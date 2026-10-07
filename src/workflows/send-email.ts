// Sends an EMAIL task's draft from the rep's Gmail, logs it on the contact in
// HubSpot, then runs the "email sent" follow-up (complete the task, create
// tomorrow's CALL task).
//
// Sending is the one step that can never be repeated safely, so it's guarded
// in D1 before Gmail is called:
//   no row      → take the row as 'sending', call Gmail, mark 'sent'
//   'sending'   → another run is mid-send (lock live), or it died mid-send
//                 (lock expired → 'unknown')
//   'unknown'   → we can't tell whether Gmail took it; the rep checks their
//                 Sent folder and says which (see resolveUnknownSend)
//   'sent'      → skip straight to logging and the follow-up, both of which
//                 resume safely
// Gmail answering with a 4xx means it definitely didn't send, so that
// attempt is discarded and can be retried.

import { composeEmail, type ComposedEmail } from '../lib/compose';
import type { ConfirmationStore, SentEmail, SentEmailStore } from '../lib/db';
import { GoogleApiError } from '../lib/google';
import { HubSpotApiError, type HubSpot } from '../lib/hubspot';
import { base64UrlEncode, buildMime } from '../lib/mime';
import { htmlToText, parseTaskBody } from '../lib/richtext';
import { instrumentHtml, randomToken } from '../lib/tracking';
import {
  abandonEmailSent,
  finishEmailSent,
  prepareEmailSent,
  type EmailSentOptions,
  type PreparedEmailSent,
} from './email-sent';
import { contactName, loadTask, WorkflowError, type TaskParties } from './parties';

// Long enough for one Gmail API call. A lock older than this with no result
// means the run died mid-send.
const SEND_LOCK_TTL_SEC = 60;

export interface Mailer {
  fromEmail: string;
  send(rawBase64Url: string): Promise<{ id: string }>;
}

export class SendOutcomeUnknownError extends WorkflowError {
  constructor(readonly taskId: string) {
    super(
      "A send for this task started but never confirmed, so it may or may not have gone out. Check Gmail's Sent folder.",
      409
    );
  }
}

export interface OutgoingEmail extends TaskParties {
  toEmail: string;
  toName: string;
  composed: ComposedEmail;
}

// Everything the preview shows and the send uses. The preview and the send
// both build from this, so what the rep approves is what goes out (plus the
// invisible tracking pixel and rewritten link addresses).
export async function prepareEmail(hs: HubSpot, taskId: string, signatureHtml: string | null): Promise<OutgoingEmail> {
  // With the contact's task ids, so the follow-up after the send can check
  // for an existing call task without looking them up again.
  const parties = await loadTask(hs, taskId, 'EMAIL', ['tasks']);
  // A completed task was already sent (by this app, or by hand from HubSpot
  // and then marked sent). A stale Send page must never email the prospect
  // again.
  if (parties.task.properties.hs_task_status === 'COMPLETED') {
    throw new WorkflowError(
      'This task is already completed, so its email has already gone out. Nothing was sent.',
      409
    );
  }
  if (parties.task.properties.hs_task_status === 'DEFERRED') {
    throw new WorkflowError('This task was dropped (Deferred in HubSpot). Nothing was sent.', 409);
  }
  const toEmail = parties.contact.properties.email;
  if (!toEmail) throw new WorkflowError(`${contactName(parties.contact)} has no email address in HubSpot.`);

  const body = parties.task.properties.hs_task_body;
  const draft = body ? parseTaskBody(body) : null;
  if (!draft) {
    throw new WorkflowError('This task has no draft in the "Subject: …" format yet. Draft it first.');
  }

  const p = parties.contact.properties;
  const toName = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
  return { ...parties, toEmail, toName, composed: composeEmail(draft.subject, draft.body, signatureHtml) };
}

export interface SendOptions {
  now: number; // epoch ms
  timeZone: string;
  baseUrl: string; // public origin for tracking links
  fromName: string | null;
  trackOpens?: boolean;
  trackClicks?: boolean;
  // Log the email on the contact from the app. Only needed when the Gmail
  // inbox isn't connected to HubSpot, which otherwise logs it on its own.
  logToHubSpot?: boolean;
  newToken?: () => string;
  boundary?: string;
}

export interface SendResult {
  gmailMessageId: string | null; // null when the rep confirmed an unknown send by hand
  sentNow: boolean;
  loggedEmailId: string | null; // null when HubSpot's inbox sync does the logging
  callTaskId: string;
  callTaskCreated: boolean;
}

export interface SendDeps {
  hs: HubSpot;
  mailer: Mailer;
  sent: SentEmailStore;
  confirmations: ConfirmationStore;
}

export async function runSend(
  deps: SendDeps,
  taskId: string,
  signatureHtml: string | null,
  opts: SendOptions
): Promise<SendResult> {
  const sent = await sendEmail(deps, taskId, signatureHtml, opts);
  const prepared = await prepareEmailSent(deps.hs, deps.confirmations, taskId, followUpOptions(sent, opts));
  return finishSend(deps, sent, prepared, opts);
}

// What a send leaves for the steps after it: the sent row, and the task,
// contact and company when this run read them.
export interface SentState {
  row: SentEmail;
  sentNow: boolean;
  parties: TaskParties | undefined;
}

export function followUpOptions(sent: SentState, opts: Pick<SendOptions, 'now' | 'timeZone'>): EmailSentOptions {
  return { now: opts.now, timeZone: opts.timeZone, afterSend: true, parties: sent.parties };
}

// Sending, in two parts. sendEmail is the part the rep waits for: Gmail takes
// the email (or an earlier run's send is picked up). finishSend is only
// HubSpot writes (the email on the contact, the task completed, the follow-up
// call task), so it can run after the page has answered (routes/send.ts),
// once prepareEmailSent has taken the follow-up's lock.
export async function sendEmail(
  deps: SendDeps,
  taskId: string,
  signatureHtml: string | null,
  opts: SendOptions
): Promise<SentState> {
  const { hs, mailer, sent } = deps;
  const newToken = opts.newToken ?? randomToken;
  const nowSec = Math.floor(opts.now / 1000);
  let sentNow = false;
  let parties: TaskParties | undefined; // when this run loaded them

  const [existingRow, confirmation] = await Promise.all([sent.get(taskId), deps.confirmations.get(taskId)]);
  let row = existingRow;

  if (!row) {
    // "Mark sent" leaves no sent_emails row but does leave a confirmation.
    if (confirmation) {
      throw new WorkflowError('This task was already marked as sent. Nothing was sent.', 409);
    }
    const email = await prepareEmail(hs, taskId, signatureHtml);
    parties = email;
    const openToken = newToken();
    const tracked = instrumentHtml(email.composed.html, {
      baseUrl: opts.baseUrl,
      openToken,
      newToken,
      opens: opts.trackOpens,
      clicks: opts.trackClicks,
    });

    const claimed = await sent.beginSend(
      {
        emailTaskId: taskId,
        contactId: email.contact.id,
        companyId: email.company?.id ?? null,
        fromEmail: mailer.fromEmail,
        toEmail: email.toEmail,
        subject: email.composed.subject,
        html: email.composed.html,
        openToken,
        links: tracked.links,
        trackOpens: opts.trackOpens ?? false,
        trackClicks: opts.trackClicks ?? true,
      },
      nowSec,
      SEND_LOCK_TTL_SEC
    );
    if (!claimed) throw new WorkflowError('This email is already being sent. Refresh in a moment.', 409);

    // Read the status again now that the claim is in D1. A Drop running at the
    // same moment either landed first and is seen here, or checks D1 after
    // its write, sees this claim, and puts the task back.
    const current = await hs.getObject('tasks', taskId, ['hs_task_status']);
    if (current.properties.hs_task_status === 'DEFERRED') {
      await sent.discard(taskId, 'sending');
      throw new WorkflowError('This task was dropped just now (Deferred in HubSpot). Nothing was sent.', 409);
    }

    const mime = buildMime({
      from: { email: mailer.fromEmail, name: opts.fromName },
      to: { email: email.toEmail, name: email.toName || null },
      subject: email.composed.subject,
      html: tracked.html,
      text: email.composed.text,
      messageId: `<hsa.${taskId}.${openToken}@causeway>`,
      date: new Date(opts.now),
      boundary: opts.boundary ?? `hsa-${newToken()}`,
    });

    try {
      const result = await mailer.send(base64UrlEncode(mime));
      await sent.markSent(taskId, result.id, new Date(opts.now).toISOString());
      sentNow = true;
    } catch (err) {
      // A 4xx from Gmail is a definite "not sent" (bad token, bad address).
      // Anything else (5xx, network) might have gone out, so the row stays
      // 'sending' and turns 'unknown' once its lock expires.
      if (err instanceof GoogleApiError && err.status >= 400 && err.status < 500) {
        await sent.discard(taskId, 'sending');
      }
      throw err;
    }
    row = await sent.get(taskId);
    if (!row) throw new Error(`sent_emails row for ${taskId} missing right after send`);
  } else if (row.status === 'sending') {
    if (await sent.markUnknownIfStale(taskId, nowSec)) throw new SendOutcomeUnknownError(taskId);
    throw new WorkflowError('This email is being sent right now. Refresh in a moment.', 409);
  }

  if (row.status === 'unknown') throw new SendOutcomeUnknownError(taskId);
  return { row, sentNow, parties };
}

export async function finishSend(
  deps: SendDeps,
  sent: SentState,
  prepared: PreparedEmailSent,
  opts: SendOptions
): Promise<SendResult> {
  const { row, sentNow } = sent;
  let loggedEmailId: string | null;
  try {
    loggedEmailId = await logSentEmail(deps, row, opts);
  } catch (err) {
    await abandonEmailSent(deps.confirmations, prepared, err);
    throw err;
  }
  const followUp = await finishEmailSent(deps.hs, deps.confirmations, prepared, followUpOptions(sent, opts));
  return {
    gmailMessageId: row.gmail_message_id,
    sentNow,
    loggedEmailId,
    callTaskId: followUp.callTaskId,
    callTaskCreated: followUp.callTaskCreated,
  };
}

// Puts the email on the contact's timeline, when the app does the logging.
async function logSentEmail(
  { hs, sent }: SendDeps,
  row: SentEmail,
  opts: Pick<SendOptions, 'now' | 'fromName' | 'logToHubSpot'>
): Promise<string | null> {
  const taskId = row.email_task_id;
  let loggedEmailId = row.logged_email_id;
  // The marker goes in before the HubSpot call. If HubSpot created the entry
  // but the response was lost, a retry sees the marker and skips logging
  // again: a possibly missing log beats a duplicate. HubSpot's own inbox sync
  // logs the email anyway when the Gmail account is connected to it.
  if (!loggedEmailId && opts.logToHubSpot && (await sent.markLogAttempted(taskId, new Date(opts.now).toISOString()))) {
    const [firstName, ...rest] = (opts.fromName ?? '').split(' ');
    try {
      // HubSpot gets the clean HTML: logging the tracked version would count
      // an "open" every time someone views the contact's timeline.
      loggedEmailId = await hs.logEmail(
        {
          subject: row.subject,
          html: row.html,
          text: htmlToText(row.html),
          from: { email: row.from_email, ...(firstName ? { firstName, lastName: rest.join(' ') } : {}) },
          to: { email: row.to_email },
          sentAt: row.sent_at ?? new Date(opts.now).toISOString(),
        },
        { contactId: row.contact_id, companyId: row.company_id }
      );
    } catch (err) {
      // A 4xx answer means HubSpot created nothing, so the retry may log.
      if (err instanceof HubSpotApiError && err.status >= 400 && err.status < 500) await sent.clearLogAttempt(taskId);
      throw err;
    }
    await sent.setLoggedEmail(taskId, loggedEmailId);
  }
  return loggedEmailId;
}

// The rep checked Gmail's Sent folder after an unknown outcome. Returns the
// send's state afterwards, which is what the caller acts on. The rep's choice
// alone isn't enough: a second tab may already have resolved it the other way.
//   'sent'    → it went out (now or earlier), so finishing the follow-up is safe
//   'cleared' → no send on record, so the rep may send it
//   'pending' → another run is mid-send, so do nothing
export async function resolveUnknownSend(
  sent: SentEmailStore,
  taskId: string,
  wentOut: boolean,
  now: number
): Promise<'sent' | 'cleared' | 'pending'> {
  const row = await sent.get(taskId);
  if (row?.status === 'unknown') {
    if (wentOut) await sent.markSentManually(taskId, new Date(now).toISOString());
    else await sent.discard(taskId, 'unknown');
  }
  const after = await sent.get(taskId);
  if (!after) return 'cleared';
  return after.status === 'sent' ? 'sent' : 'pending';
}

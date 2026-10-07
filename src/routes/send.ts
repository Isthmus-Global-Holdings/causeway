import { Hono, type Context } from 'hono';
import { gmailMailer, loadAppSettings } from '../lib/app-settings';
import { privateNotes, voiceWarnings } from '../lib/compose';
import { d1ConfirmationStore, d1SentEmailStore, insertAudit } from '../lib/db';
import { afterResponse } from '../lib/background';
import { createHubSpot } from '../lib/hubspot';
import { parseTaskBody } from '../lib/richtext';
import type { AppEnv } from '../types';
import { redirectToNextEmail, sentNotice } from './next-email';
import { alreadySentPage, sendPage, unknownSendPage } from '../views/send';
import { prepareEmailSent, type PreparedEmailSent } from '../workflows/email-sent';
import {
  finishSend,
  followUpOptions,
  prepareEmail,
  resolveUnknownSend,
  sendEmail,
  SendOutcomeUnknownError,
  type SentState,
} from '../workflows/send-email';
import { WorkflowError } from '../workflows/parties';

export const sendRoute = new Hono<AppEnv>();

// GET /tasks/:id/send: the exact email, ready to send.
sendRoute.get('/:id/send', async (c) => {
  const taskId = c.req.param('id');
  const [sent, settings] = await Promise.all([d1SentEmailStore(c.env.DB).get(taskId), loadAppSettings(c.env)]);
  if (sent?.status === 'unknown') {
    return c.html(unknownSendPage(taskId, sent.subject, sent.to_email, c.get('actor')));
  }
  // Already sent from here: show where it stands instead of a preview (the
  // completed task can't be sent again). If the follow-up didn't finish (e.g.
  // HubSpot failed after Gmail sent), offer to finish it. Re-running the send
  // skips Gmail and resumes the remaining steps.
  if (sent?.status === 'sent') {
    const confirmation = await d1ConfirmationStore(c.env.DB).get(taskId);
    const followUpDone = Boolean(confirmation?.completed_at && confirmation.call_task_id);
    return c.html(alreadySentPage(taskId, sent, followUpDone, c.get('actor')));
  }

  const email = await prepareEmail(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), taskId, settings.signatureHtml);
  const draft = parseTaskBody(email.task.properties.hs_task_body ?? '');
  return c.html(
    sendPage(
      {
        email,
        fromEmail: settings.googleEmail,
        fromName: settings.fromName,
        hasSignature: Boolean(settings.signatureHtml),
        warnings: draft ? voiceWarnings(draft.subject, draft.body) : [],
        notes: draft ? privateNotes(draft.body) : [],
        trackOpens: settings.trackOpens,
        trackClicks: settings.trackClicks,
        notice: sentNotice(c),
      },
      c.get('actor')
    )
  );
});

// Sends (or picks up an earlier run's send) and redirects to the queue. Used
// by the Send button and, after a manual "it went out", by resolve. That
// second call skips Gmail because the row is already 'sent'. The HubSpot
// steps after it (the email on the contact, the task completed, the follow-up
// call task) run after the page answers.
async function sendAndFinish(c: Context<AppEnv>, taskId: string) {
  const actor = c.get('actor');
  const settings = await loadAppSettings(c.env);
  const sent = d1SentEmailStore(c.env.DB);
  const deps = {
    hs: createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN),
    mailer: await gmailMailer(c.env, settings),
    sent,
    confirmations: d1ConfirmationStore(c.env.DB),
  };
  const opts = {
    now: Date.now(),
    timeZone: settings.timeZone,
    baseUrl: c.env.PUBLIC_BASE_URL,
    fromName: settings.fromName,
    trackOpens: settings.trackOpens,
    trackClicks: settings.trackClicks,
    logToHubSpot: settings.logToHubSpot,
  };

  let sentState: SentState;
  let prepared: PreparedEmailSent;
  try {
    sentState = await sendEmail(deps, taskId, settings.signatureHtml, opts);
    prepared = await prepareEmailSent(deps.hs, deps.confirmations, taskId, followUpOptions(sentState, opts));
  } catch (err) {
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'send-email',
      taskId,
      action: 'send via gmail',
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof SendOutcomeUnknownError) {
      const row = await sent.get(taskId);
      return c.html(unknownSendPage(taskId, row?.subject ?? null, row?.to_email ?? null, actor), 409);
    }
    throw err;
  }
  await insertAudit(c.env.DB, {
    actor,
    workflow: 'send-email',
    taskId,
    action: 'send via gmail',
    outcome: 'success',
    detail: { gmailMessageId: sentState.row.gmail_message_id, sentNow: sentState.sentNow },
  });

  const followUp = 'log + complete task + create call task';
  afterResponse(c, `follow-up for the email on task ${taskId}`, async () => {
    try {
      const result = await finishSend(deps, sentState, prepared, opts);
      await insertAudit(c.env.DB, {
        actor,
        workflow: 'send-email',
        taskId,
        action: followUp,
        outcome: 'success',
        detail: result,
      });
    } catch (err) {
      await insertAudit(c.env.DB, {
        actor,
        workflow: 'send-email',
        taskId,
        action: followUp,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return redirectToNextEmail(c, taskId, settings, 'gmail');
}

// POST /tasks/:id/send: send, log to HubSpot, complete the task, queue the call.
sendRoute.post('/:id/send', (c) => sendAndFinish(c, c.req.param('id')));

// POST /tasks/:id/send/resolve: the rep checked Gmail's Sent folder.
sendRoute.post('/:id/send/resolve', async (c) => {
  const taskId = c.req.param('id');
  const wentOut = (await c.req.parseBody()).went_out === '1';
  const state = await resolveUnknownSend(d1SentEmailStore(c.env.DB), taskId, wentOut, Date.now());
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: 'send-email',
    taskId,
    action: `rep said the unknown send ${wentOut ? 'went out' : 'did not go out'} (now ${state})`,
    outcome: 'success',
  });
  // Act on the state, not the button: a stale "it's in Sent" after another
  // tab chose "not there" must not start a brand-new send.
  if (wentOut && state === 'sent') return sendAndFinish(c, taskId);
  if (wentOut && state === 'cleared') {
    throw new WorkflowError(
      'This send was already resolved as "not sent" in another tab, so nothing was sent. Open the task\'s send page to send it.',
      409
    );
  }
  return c.redirect(`/tasks/${encodeURIComponent(taskId)}/send`, 303);
});

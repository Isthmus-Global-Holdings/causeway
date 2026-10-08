// The rep logs how a call went. Three writes to HubSpot, each recorded in D1
// (call_logs) as it lands, so a double-click or a retry resumes instead of
// repeating, the same way runEmailSent does:
//   1. log the call on the contact's timeline, with its outcome, duration and
//      numbers. Reached on WhatsApp instead (the channel, lib/whatsapp.ts): a
//      WhatsApp call is logged as a call; a message as a WhatsApp
//      communication, its text the notes
//   2. mark the CALL task COMPLETED
//   3. if the rep asked for one, create the follow-up task (CALL or EMAIL) on
//      the chosen day, at the time the contact asked for (a set-time call,
//      with a HubSpot reminder: lib/set-time.ts), else at the call task's
//      local time of day, else 09:00. The last-try EMAIL comes with its draft
//      written (closeTheLoopEmail in prompts/follow-up-emails.ts).
//   4. move the contact's Lead Status forward (nextLeadStatus below)
//   5. if the call booked an interview, create the meeting in HubSpot
// The form's values are stored with the row on the first submission, so a
// retry writes exactly what the rep first submitted.

import { isDate, localDateAt, parseHubSpotTime, parseTime, timeOfDay, type TimeOfDay } from '../lib/dates';
import { CALL_CHANNELS, type CallChannel, type CallLog, type CallLogStore, type Dial } from '../lib/db';
import { HubSpotApiError, type CallStatus, type HubSpot } from '../lib/hubspot';
import { textToHtml, toTaskBodyHtml } from '../lib/richtext';
import { reminderFor } from '../lib/set-time';
import { whatsappNumber } from '../lib/whatsapp';
import { closeTheLoopEmail } from '../prompts/follow-up-emails';
import { transcriptHtml, type CallTranscript } from '../lib/transcript';
import { escapeHtml } from '../lib/richtext';
import {
  bookingPhone,
  bookingTimes,
  findOrCreateMeeting,
  interviewTitle,
  inviteeEmail,
  parseBookingForm,
  sendInvite,
  type BookingInput,
  type Calendar,
} from './book-interview';
import {
  companyName,
  contactName,
  findOpenTask,
  loadTask,
  withTaskLock,
  WorkflowError,
  type TaskType,
} from './parties';

const LOCK_TTL_SEC = 60;
const DEFAULT_NEXT_TIME: TimeOfDay = { hour: 9, minute: 0 };

// HubSpot's default call outcomes. The GUIDs are fixed across accounts.
// https://developers.hubspot.com/docs/api-reference/latest/crm/activities/calls/guide
export const CALL_OUTCOMES = [
  { value: 'connected', label: 'Connected', disposition: 'f240bbac-87c9-4f6e-bf70-924b57d47db7' },
  { value: 'left_voicemail', label: 'Left voicemail', disposition: 'b2cf5968-551e-4856-9783-52b3da59a7d0' },
  { value: 'left_live_message', label: 'Left live message', disposition: 'a4c4c377-d246-4b32-a13b-75a56a4cd0ff' },
  { value: 'no_answer', label: 'No answer', disposition: '73a0d17f-1163-4015-bdd5-ec830791da20' },
  { value: 'busy', label: 'Busy', disposition: '9d9162e7-6cf3-4944-bf63-4dff82258764' },
  { value: 'wrong_number', label: 'Wrong number', disposition: '17b47fee-58de-441e-a44c-c6300d46f273' },
] as const;

// A WhatsApp message's outcomes: nothing back yet, or they answered.
export const MESSAGE_OUTCOMES = [
  { value: 'sent', label: 'Sent, no reply yet' },
  { value: 'replied', label: 'They replied' },
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number]['value'];
export type MessageOutcome = (typeof MESSAGE_OUTCOMES)[number]['value'];

export function outcomeFor(value: string) {
  return CALL_OUTCOMES.find((o) => o.value === value) ?? null;
}

export function messageOutcomeFor(value: string) {
  return MESSAGE_OUTCOMES.find((o) => o.value === value) ?? null;
}

// The log form's channel; none given is a phone call.
export function callChannel(value: string | undefined): CallChannel | null {
  return CALL_CHANNELS.find((ch) => ch === (value || 'phone')) ?? null;
}

// The contact's numbers the rep can reach them on over WhatsApp.
export const WHATSAPP_FIELDS = ['mobilephone', 'phone'] as const;
export type WhatsAppField = (typeof WHATSAPP_FIELDS)[number];

// Twilio's final status for the prospect's leg, in HubSpot's terms.
export const HUBSPOT_STATUS: Record<string, CallStatus> = {
  completed: 'COMPLETED',
  busy: 'BUSY',
  'no-answer': 'NO_ANSWER',
  failed: 'FAILED',
  canceled: 'CANCELED',
};

export interface CallLogInput {
  channel?: CallChannel; // a phone call unless given
  outcome: CallOutcome | MessageOutcome; // a MessageOutcome for a WhatsApp message
  notes: string; // a WhatsApp message's text
  whatsappField?: WhatsAppField | null; // the number they were reached on over WhatsApp
  // date: "YYYY-MM-DD" in the rep's time zone. time: the time the contact
  // asked to be called at, which makes a set-time call (CALL only). lastTry:
  // the EMAIL is the last one, drafted from closeTheLoopEmail.
  next: { type: TaskType; date: string; time?: TimeOfDay; lastTry?: boolean } | null;
  booking: BookingInput | null; // the interview the call booked
  dial: Dial | null; // the app's dial this outcome is for; null if the rep called another way
  transcript: CallTranscript | null; // the dial's transcript, if it finished before the rep logged
}

export interface CallLoggedOptions {
  now: number; // epoch ms
  timeZone: string;
  baseUrl: string; // the app's public origin, for a link back to the call page
  calendar?: Calendar; // sends the interview's invite, when the rep asked for one
}

export interface CallLoggedResult {
  loggedCallId: string | null; // null if an earlier attempt's result was lost (see log_attempted_at)
  loggedMessageId: string | null; // a WhatsApp message's, logged in place of a call
  completedNow: boolean;
  nextTaskId: string | null;
  nextTaskCreated: boolean;
  leadStatus: string | null; // what Lead Status was set to; null if left as it was
  bookedMeetingId: string | null;
}

// HubSpot's free Lead Status, moved forward by a call and never back: a
// status the rep set by hand past "attempted" (In Progress, Open Deal,
// Unqualified, Bad Timing, Connected) is left alone. Null means no change.
const LEAD_STATUS_BY_OUTCOME: Record<CallOutcome | MessageOutcome, string | null> = {
  connected: 'CONNECTED',
  replied: 'CONNECTED',
  sent: 'ATTEMPTED_TO_CONTACT',
  left_voicemail: 'ATTEMPTED_TO_CONTACT',
  left_live_message: 'ATTEMPTED_TO_CONTACT',
  no_answer: 'ATTEMPTED_TO_CONTACT',
  busy: 'ATTEMPTED_TO_CONTACT',
  wrong_number: null,
};
const OVERWRITABLE_LEAD_STATUS = new Set(['', 'NEW', 'OPEN', 'ATTEMPTED_TO_CONTACT']);

export function nextLeadStatus(current: string | null | undefined, outcome: string): string | null {
  const target = LEAD_STATUS_BY_OUTCOME[outcome as CallOutcome] ?? null;
  const now = current ?? '';
  if (!target || target === now || !OVERWRITABLE_LEAD_STATUS.has(now)) return null;
  return target;
}

// HubSpot allows 65,536 characters in a call body; this leaves room for the rest.
const MAX_NOTES = 10_000;

// The log form's fields, checked. `today` is "YYYY-MM-DD" in the rep's time
// zone: a follow-up can't be due in the past.
export function parseCallLogForm(
  form: Record<string, string | undefined>,
  today: string
): Omit<CallLogInput, 'dial' | 'transcript'> {
  const channel = callChannel(form.channel);
  if (!channel)
    throw new WorkflowError('Pick how you reached them: a phone call, a WhatsApp call or a WhatsApp message.');
  const message = channel === 'whatsapp_message';
  const outcome = message ? messageOutcomeFor(form.outcome ?? '') : outcomeFor(form.outcome ?? '');
  if (!outcome) throw new WorkflowError(message ? 'Pick how the message went.' : 'Pick an outcome for the call.');
  const notes = (form.notes ?? '').replace(/\r\n?/g, '\n');
  if (notes.length > MAX_NOTES)
    throw new WorkflowError(`Notes are limited to ${MAX_NOTES.toLocaleString('en-US')} characters.`);
  if (message && !notes.trim()) throw new WorkflowError('Put the message you sent in Notes.');
  const field = channel === 'phone' ? null : form.whatsapp_field || 'mobilephone';
  const whatsappField = WHATSAPP_FIELDS.find((f) => f === field) ?? null;
  if (field && !whatsappField) throw new WorkflowError('Unknown WhatsApp number.');

  const booking = form.book === '1' ? parseBookingForm(form, today) : null;
  if (booking && outcome.value !== 'connected' && outcome.value !== 'replied') {
    throw new WorkflowError('An interview can only be booked on a call that connected, or a message they replied to.');
  }

  const base = { channel, outcome: outcome.value, notes, whatsappField, booking };
  const type = form.next_type ?? '';
  if (type === '') return { ...base, next: null };
  if (type !== 'CALL' && type !== 'EMAIL' && type !== LAST_TRY) throw new WorkflowError('Unknown follow-up type.');
  const date = form.next_date ?? '';
  if (!isDate(date)) throw new WorkflowError('Pick a date for the follow-up task.');
  if (date < today) throw new WorkflowError('The follow-up date is in the past.');
  if (type === LAST_TRY) return { ...base, next: { type: 'EMAIL', date, lastTry: true } };
  const timeText = type === 'CALL' ? (form.next_time ?? '') : '';
  const time = timeText ? parseTime(timeText) : null;
  if (timeText && !time)
    throw new WorkflowError('Enter a time like 4pm or 4:30pm for the follow-up call, or leave it blank.');
  return { ...base, next: time ? { type, date, time } : { type, date } };
}

// The log form's follow-up for the last email to someone who's gone quiet.
export const LAST_TRY = 'EMAIL_LAST';

export function lastTrySubject(company: string | null, contact: string): string {
  const who = company ? `${company} (${contact})` : contact;
  return `Email: ${who} — close the loop`;
}

// What the logged call (or message) is called, in the app and on the timeline.
export function callTitle(channel: CallChannel, company: string | null, contact: string): string {
  const who = company ? `${contact} (${company})` : contact;
  if (channel === 'whatsapp_message') return `WhatsApp message to ${who}`;
  return `${channel === 'whatsapp_call' ? 'WhatsApp call' : 'Call'} with ${who}`;
}

export function nextTaskSubject(type: TaskType, company: string | null, contact: string): string {
  const who = company ? `${company} (${contact})` : contact;
  return `${type === 'CALL' ? 'Call' : 'Email'}: ${who} — follow up on call`;
}

function lastTryBody(firstName: string | null | undefined): string {
  const draft = closeTheLoopEmail({ firstName: firstName?.trim() || null });
  return toTaskBodyHtml(draft.subject, draft.body);
}

// The logged call's notes in HubSpot. Built whole from the row and the
// transcript every time, so writing it again (when a transcript lands after
// the call was logged) replaces it rather than appending twice.
export function callBodyHtml(row: CallLog, transcript: CallTranscript | null, baseUrl: string): string {
  const outcome = outcomeFor(row.outcome)?.label ?? row.outcome;
  const notes = row.notes.trim() ? `<p>${textToHtml(row.notes.trim())}</p>` : '';
  const via = row.twilio_status
    ? 'Dialled from Causeway through Twilio.'
    : row.channel === 'whatsapp_call'
      ? 'Called on WhatsApp, logged from Causeway.'
      : 'Logged from Causeway.';
  if (!transcript) return `${notes}<p>Outcome: ${outcome}. ${via}</p>`;

  const summary = transcript.summary.length
    ? `<p><strong>Summary</strong></p><ul>${transcript.summary.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
    : '';
  const link = `${baseUrl.replace(/\/+$/, '')}/calls/${encodeURIComponent(row.call_task_id)}`;
  return (
    `${notes}${summary}<p>Outcome: ${outcome}. ${via} <a href="${escapeHtml(link)}">Recording in the app</a>.</p>` +
    `<p><strong>Transcript</strong></p>${transcriptHtml(transcript.turns)}`
  );
}

// A WhatsApp message on the contact's timeline: what was sent, then how it went.
export function messageBodyHtml(row: CallLog): string {
  const outcome = messageOutcomeFor(row.outcome)?.label ?? row.outcome;
  return `<p>${textToHtml(row.notes.trim())}</p><p>${escapeHtml(outcome)}. Sent on WhatsApp, logged from Causeway.</p>`;
}

// Every step of the workflow has landed. Until then the call page keeps the
// log form, even once the task shows COMPLETED in HubSpot (step 2), so the
// rep can finish the follow-up and Lead Status after a failure.
export function callLogDone(row: CallLog): boolean {
  const logged = Boolean(row.logged_call_id || row.logged_message_id || row.log_attempted_at);
  return (
    logged &&
    Boolean(row.completed_at) &&
    (!row.next_type || Boolean(row.next_task_id)) &&
    Boolean(row.lead_status_at) &&
    (!row.book_start || Boolean(row.booked_meeting_id))
  );
}

export async function runCallLogged(
  hs: HubSpot,
  store: CallLogStore,
  callTaskId: string,
  input: CallLogInput,
  opts: CallLoggedOptions
): Promise<CallLoggedResult> {
  const prepared = await prepareCallLog(hs, store, callTaskId, input, opts);
  return prepared.kind === 'done'
    ? doneResult(prepared.row)
    : finishCallLog(hs, store, prepared, input.transcript, opts);
}

// Logging, in two parts. prepareCallLog answers the rep: it checks the task,
// records what they entered (the first submission's values stick) and takes
// the lock. finishCallLog is only HubSpot writes, each recorded as it lands,
// so it can run after the page has answered (routes/calls.ts).
export type PreparedCallLog =
  | { kind: 'done'; row: CallLog } // every step landed on an earlier run
  | { kind: 'locked'; row: CallLog; knownTaskIds: string[] | undefined }; // this run holds the lock

export function doneResult(row: CallLog): CallLoggedResult {
  return {
    loggedCallId: row.logged_call_id,
    loggedMessageId: row.logged_message_id,
    completedNow: false,
    nextTaskId: row.next_task_id,
    nextTaskCreated: false,
    leadStatus: null,
    bookedMeetingId: row.booked_meeting_id,
  };
}

const DROPPED = 'This call task was dropped (Deferred in HubSpot), so the call wasn’t logged.';

export async function prepareCallLog(
  hs: HubSpot,
  store: CallLogStore,
  callTaskId: string,
  input: Omit<CallLogInput, 'transcript'>,
  opts: Pick<CallLoggedOptions, 'now' | 'timeZone'>
): Promise<PreparedCallLog> {
  let knownTaskIds: string[] | undefined; // the contact's tasks, read with it in this run

  let row = await store.get(callTaskId);
  if (!row) {
    // Under the task's lock from the status check to the row: a Drop waits for
    // it, sees the row and refuses, or wrote DEFERRED first and is seen here.
    await withTaskLock(store, callTaskId, Math.floor(opts.now / 1000), async (beforeWrite) => {
      const { task, contact, company, related } = await loadTask(hs, callTaskId, 'CALL', ['tasks']);
      knownTaskIds = related?.tasks;
      // Completed in HubSpot but never logged here: probably logged by hand
      // there already, and a second log would duplicate it.
      if (task.properties.hs_task_status === 'COMPLETED') {
        throw new WorkflowError('This call task is already completed in HubSpot, so nothing was logged.', 409);
      }
      if (task.properties.hs_task_status === 'DEFERRED') throw new WorkflowError(DROPPED, 409);
      const contactLabel = contactName(contact);
      const company_ = companyName(company);
      const due = parseHubSpotTime(task.properties.hs_timestamp);
      const { next, booking } = input;
      const channel = input.channel ?? 'phone';
      // A Twilio dial is a phone call's: one left on the page doesn't count for WhatsApp.
      const dial = channel === 'phone' ? input.dial : null;
      const whatsapp = input.whatsappField ? whatsappNumber(contact.properties[input.whatsappField]) : null;
      if (channel !== 'phone' && !whatsapp) {
        throw new WorkflowError('That number isn’t one WhatsApp can reach. Check it on the page or in HubSpot.');
      }
      const at = next?.time ?? (due === null ? DEFAULT_NEXT_TIME : timeOfDay(due, opts.timeZone));
      const nextDue = next ? localDateAt(next.date, opts.timeZone, at) : null;
      if (next?.time && nextDue !== null && nextDue <= opts.now) {
        throw new WorkflowError('The follow-up call’s time has already passed.');
      }
      const bookedTimes = booking ? bookingTimes(booking, opts.timeZone, opts.now) : null;
      beforeWrite();
      await store.create({
        call_task_id: callTaskId,
        contact_id: contact.id,
        company_id: company?.id ?? null,
        owner_id: task.properties.hubspot_owner_id || null,
        title: callTitle(channel, company_, contactLabel),
        channel,
        outcome: input.outcome,
        notes: input.notes,
        twilio_status: dial?.prospect_status ?? null,
        duration_sec: dial?.prospect_duration_sec ?? null,
        from_number: dial?.from_number ?? null,
        to_number:
          whatsapp ??
          dial?.to_number ??
          contact.properties.phone ??
          contact.properties.mobilephone ??
          company?.properties.phone ??
          null,
        next_type: next?.type ?? null,
        next_subject: !next
          ? null
          : next.lastTry
            ? lastTrySubject(company_, contactLabel)
            : nextTaskSubject(next.type, company_, contactLabel),
        next_body: next?.lastTry ? lastTryBody(contact.properties.firstname) : null,
        next_due: nextDue === null ? null : new Date(nextDue).toISOString(),
        next_set_time: next?.time ? 1 : 0,
        dial_id: dial?.id ?? null,
        book_start: bookedTimes?.startAt ?? null,
        book_title: booking ? interviewTitle(company_, contactLabel) : null,
        book_invite: booking?.invite ? 1 : 0,
        book_invitee_email: booking ? inviteeEmail(contact, booking.invite) : null,
        book_minutes: booking?.minutes ?? null,
        book_join_url: booking?.joinUrl ?? null,
        book_phone: booking ? bookingPhone(contact, company, booking.byPhone) : null,
      });
    });
    row = await store.get(callTaskId);
    if (!row) throw new Error(`call_logs row for ${callTaskId} missing right after insert`);
  }

  if (callLogDone(row)) return { kind: 'done', row };

  if (!(await store.acquireLock(callTaskId, Math.floor(opts.now / 1000), LOCK_TTL_SEC))) {
    throw new WorkflowError('This call is already being logged. Refresh in a moment.', 409);
  }
  // Re-read under the lock: a run that held it before us may have finished steps.
  return { kind: 'locked', row: (await store.get(callTaskId)) ?? row, knownTaskIds };
}

// The HubSpot steps, under the lock prepareCallLog took; it's released at the
// end either way. A step that fails leaves its error on the row for the
// notice, and the next run picks up from the first step not yet recorded.
export async function finishCallLog(
  hs: HubSpot,
  store: CallLogStore,
  prepared: Extract<PreparedCallLog, { kind: 'locked' }>,
  transcript: CallTranscript | null,
  opts: CallLoggedOptions
): Promise<CallLoggedResult> {
  const { row, knownTaskIds } = prepared;
  const callTaskId = row.call_task_id;
  try {
    const links = { contactId: row.contact_id, companyId: row.company_id };

    let loggedCallId = row.logged_call_id;
    let loggedMessageId = row.logged_message_id;
    // The marker goes in first: if HubSpot created the call but the response
    // was lost, a retry skips logging. A possibly missing log beats a duplicate.
    if (
      !loggedCallId &&
      !loggedMessageId &&
      (await store.markLogAttempted(callTaskId, new Date(opts.now).toISOString()))
    ) {
      try {
        if (row.channel === 'whatsapp_message') {
          loggedMessageId = await hs.logMessage(
            {
              channel: 'WHATS_APP',
              bodyHtml: messageBodyHtml(row),
              ownerId: row.owner_id,
              at: new Date(opts.now).toISOString(),
            },
            links
          );
        } else {
          loggedCallId = await hs.logCall(
            {
              title: row.title,
              bodyHtml: callBodyHtml(row, transcript, opts.baseUrl),
              status: row.twilio_status ? (HUBSPOT_STATUS[row.twilio_status] ?? 'COMPLETED') : 'COMPLETED',
              disposition: outcomeFor(row.outcome)?.disposition ?? CALL_OUTCOMES[0].disposition,
              durationMs: row.duration_sec === null ? null : row.duration_sec * 1000,
              fromNumber: row.from_number,
              toNumber: row.to_number,
              ownerId: row.owner_id,
              at: new Date(opts.now).toISOString(),
            },
            links
          );
        }
      } catch (err) {
        // A 4xx answer means HubSpot created nothing, so the retry may log.
        if (err instanceof HubSpotApiError && err.status >= 400 && err.status < 500) {
          await store.clearLogAttempt(callTaskId);
        }
        throw err;
      }
      if (loggedMessageId) {
        await store.setLoggedMessage(callTaskId, loggedMessageId);
      } else if (loggedCallId) {
        await store.setLoggedCall(callTaskId, loggedCallId);
        if (transcript) await store.markTranscriptSynced(callTaskId, new Date(opts.now).toISOString());
      }
    }

    let completedNow = false;
    if (!row.completed_at) {
      await hs.updateObject('tasks', callTaskId, { hs_task_status: 'COMPLETED' });
      await store.markCompleted(callTaskId, new Date(opts.now).toISOString());
      completedNow = true;
    }

    let nextTaskId = row.next_task_id;
    let nextTaskCreated = false;
    if (row.next_type && row.next_subject && row.next_due && !nextTaskId) {
      // A set-time call is due when the contact asked, and has its reminder.
      const setTime = row.next_set_time
        ? { hs_timestamp: row.next_due, hs_task_reminders: reminderFor(Date.parse(row.next_due)) }
        : null;
      nextTaskId = await findOpenTask(hs, row.contact_id, row.next_type, row.next_subject, knownTaskIds);
      if (nextTaskId && setTime) await hs.updateObject('tasks', nextTaskId, setTime);
      if (!nextTaskId) {
        nextTaskId = await hs.createTask(
          {
            hs_task_type: row.next_type,
            hs_task_status: 'NOT_STARTED',
            hs_task_subject: row.next_subject,
            hs_timestamp: row.next_due,
            ...setTime,
            ...(row.next_body ? { hs_task_body: row.next_body } : {}),
            ...(row.owner_id ? { hubspot_owner_id: row.owner_id } : {}),
          },
          links
        );
        nextTaskCreated = true;
      }
      await store.setNextTask(callTaskId, nextTaskId);
    }

    // Read fresh: the rep may have changed it in HubSpot since the page loaded.
    let leadStatus: string | null = null;
    if (!row.lead_status_at) {
      const contact = await hs.getObject('contacts', row.contact_id, ['hs_lead_status']);
      leadStatus = nextLeadStatus(contact.properties.hs_lead_status, row.outcome);
      if (leadStatus) await hs.updateObject('contacts', row.contact_id, { hs_lead_status: leadStatus });
      await store.markLeadStatusDone(callTaskId, new Date(opts.now).toISOString());
    }

    let bookedMeetingId = row.booked_meeting_id;
    if (row.book_start && !bookedMeetingId) {
      const start = Date.parse(row.book_start);
      const endAt = new Date(start + (row.book_minutes ?? 30) * 60_000).toISOString();
      const title = row.book_title ?? row.title;
      let joinUrl = row.book_join_url;
      if (row.book_invite && row.book_invitee_email && !row.book_calendar_event_id) {
        if (!opts.calendar) throw new Error('runCallLogged needs a calendar to send the interview invite');
        const sent = await sendInvite(opts.calendar, `call:${callTaskId}`, {
          title,
          startAt: row.book_start,
          endAt,
          joinUrl,
          phone: row.book_phone,
          attendeeEmail: row.book_invitee_email,
        });
        joinUrl = sent.joinUrl;
        await store.setBookedInvite(callTaskId, sent.eventId, joinUrl);
      }
      ({ meetingId: bookedMeetingId } = await findOrCreateMeeting(hs, links, {
        title,
        startAt: row.book_start,
        endAt,
        joinUrl,
        phone: row.book_phone,
        ownerId: row.owner_id,
      }));
      await store.setBookedMeeting(callTaskId, bookedMeetingId);
    }

    if (row.last_error) await store.setError(callTaskId, null);
    return { loggedCallId, loggedMessageId, completedNow, nextTaskId, nextTaskCreated, leadStatus, bookedMeetingId };
  } catch (err) {
    await store
      .setError(callTaskId, err instanceof Error ? err.message : String(err))
      .catch((e: unknown) => console.error('recording why the call log stopped', e));
    throw err;
  } finally {
    await store.releaseLock(callTaskId);
  }
}

// The rep logs how an interview went. Each write is recorded in D1
// (meeting_logs) as it lands, so a double-click or a retry resumes instead of
// repeating, the same way runCallLogged does:
//   1. set the meeting's outcome and add the notes to its internal notes (or,
//      when rescheduled, move it to the new time)
//   2. if the app sent the contact a calendar invite for it, move the invite
//      (rescheduled) or cancel it (canceled), which emails them
//   3. if the rep asked for one, create the follow-up task (CALL or EMAIL) on
//      the chosen day at 09:00. An EMAIL after a no-show, or after they
//      canceled, comes with its draft written (missedInterviewEmail and
//      canceledInterviewEmail in prompts/follow-up-emails.ts).
//   4. move the contact's Lead Status forward (to Connected, when the
//      interview happened or was moved)
// The form's values are stored with the row on the first submission, so a
// retry writes exactly what the rep first submitted. Rows are keyed by the
// meeting and the start time the rep saw: a rescheduled interview gets a
// fresh row when it's logged at its new time. A row that stopped partway is
// found by meeting instead, since a reschedule that landed has already moved
// the meeting off the start time in its key.

import {
  earliestDate,
  isDate,
  localDateAt,
  parseHubSpotTime,
  parseSaidTime,
  saidAt,
  saidWhen,
  type SaidTime,
  type TimeOfDay,
} from '../lib/dates';
import type { CanceledBy, MeetingLog, MeetingLogStore } from '../lib/db';
import type { HubSpot } from '../lib/hubspot';
import { escapeHtml, textToHtml, toTaskBodyHtml } from '../lib/richtext';
import { whoLabel } from '../lib/conversations';
import { canceledInterviewEmail, missedInterviewEmail } from '../prompts/follow-up-emails';
import { transcriptHtml, type CallTranscript } from '../lib/transcript';
import type { Calendar } from './book-interview';
import { nextLeadStatus } from './call-logged';
import { isOpen, isPhoneInterview, loadMeeting, meetingOutcome } from './meeting-queue';
import { companyName, contactName, findOpenTask, WorkflowError, type TaskType } from './parties';

const LOCK_TTL_SEC = 60;
const DEFAULT_NEXT_TIME: TimeOfDay = { hour: 9, minute: 0 };
// hs_internal_meeting_notes holds 65,536 characters; this leaves room for
// what's already there.
const MAX_NOTES = 10_000;

export const LOGGABLE_OUTCOMES = [
  { value: 'COMPLETED', label: 'It happened' },
  { value: 'NO_SHOW', label: 'No show' },
  { value: 'RESCHEDULED', label: 'Moved to another time' },
  { value: 'CANCELED', label: 'Canceled' },
] as const;

export type LoggableOutcome = (typeof LOGGABLE_OUTCOMES)[number]['value'];

// Canceled: who called it off. Theirs is a reply (they told you ahead),
// unlike a no-show. Stored in D1 only; HubSpot's outcome is CANCELED either
// way.
export const CANCELED_BY = [
  { value: 'them', label: 'They did (they told you)' },
  { value: 'rep', label: 'You did' },
] as const satisfies readonly { value: CanceledBy; label: string }[];

export interface MeetingLogInput {
  outcome: LoggableOutcome;
  canceledBy?: CanceledBy | null; // CANCELED only
  notes: string;
  newStart: { date: string; time: SaidTime } | null; // RESCHEDULED only, in the rep's time zone unless said in theirs
  next: { type: TaskType; date: string } | null;
  // The transcript of a call made from the interview page, if it finished
  // before the rep logged: it goes into the meeting's notes with theirs.
  transcript?: CallTranscript | null;
}

export interface MeetingLoggedOptions {
  now: number; // epoch ms
  timeZone: string;
  calendar?: Calendar; // moves or cancels the interview's invite, if the app sent one
}

export interface MeetingLoggedResult {
  outcome: LoggableOutcome;
  newStartAt: number | null; // epoch ms, when rescheduled
  nextTaskId: string | null;
  nextTaskCreated: boolean;
  leadStatus: string | null;
  inviteUpdated: boolean; // the contact's calendar invite was moved or canceled
  contactId: string;
  who: string | null; // "Name (Company)", when this run read them; null when an earlier run had
}

// The log form's fields, checked. `today` is "YYYY-MM-DD" in the rep's time
// zone: neither a new time nor a follow-up can be in the past.
export function parseMeetingLogForm(form: Record<string, string | undefined>, today: string): MeetingLogInput {
  const outcome = LOGGABLE_OUTCOMES.find((o) => o.value === form.outcome)?.value;
  if (!outcome) throw new WorkflowError('Pick how the interview went.');
  const notes = (form.notes ?? '').replace(/\r\n?/g, '\n');
  if (notes.length > MAX_NOTES)
    throw new WorkflowError(`Notes are limited to ${MAX_NOTES.toLocaleString('en-US')} characters.`);

  let canceledBy: CanceledBy | null = null;
  if (outcome === 'CANCELED') {
    canceledBy = CANCELED_BY.find((c) => c.value === (form.canceled_by || 'them'))?.value ?? null;
    if (!canceledBy) throw new WorkflowError('Pick who canceled the interview.');
  }

  let newStart: MeetingLogInput['newStart'] = null;
  if (outcome === 'RESCHEDULED') {
    const date = form.new_date ?? '';
    const time = parseSaidTime(form.new_time ?? '', form.new_time_tz);
    if (!isDate(date) || !time) throw new WorkflowError('Pick the new date and time for the interview.');
    if (date < earliestDate(today, time)) throw new WorkflowError('The new date is in the past.');
    newStart = { date, time };
  }

  const type = form.next_type ?? '';
  if (type === '') return { outcome, canceledBy, notes, newStart, next: null };
  if (type !== 'CALL' && type !== 'EMAIL') throw new WorkflowError('Unknown follow-up type.');
  const date = form.next_date ?? '';
  if (!isDate(date)) throw new WorkflowError('Pick a date for the follow-up task.');
  if (date < today) throw new WorkflowError('The follow-up date is in the past.');
  return { outcome, canceledBy, notes, newStart, next: { type, date } };
}

export function meetingLogId(meetingId: string, startAt: number | null): string {
  return `${meetingId}@${startAt ?? 'none'}`;
}

export function interviewFollowUpSubject(type: TaskType, company: string | null, contact: string): string {
  const who = company ? `${company} (${contact})` : contact;
  return `${type === 'CALL' ? 'Call' : 'Email'}: ${who} — follow up on interview`;
}

export function missedInterviewSubject(company: string | null, contact: string): string {
  const who = company ? `${company} (${contact})` : contact;
  return `Email: ${who} — missed interview`;
}

export function canceledInterviewSubject(company: string | null, contact: string): string {
  const who = company ? `${company} (${contact})` : contact;
  return `Email: ${who} — canceled interview`;
}

// What goes in hs_internal_meeting_notes: what was there, then the notes,
// then the call's summary and transcript.
export function internalNotesHtml(
  existing: string | null | undefined,
  notes: string,
  transcript: CallTranscript | null = null
): string {
  const added = notes.trim() ? `<p>${textToHtml(notes.trim())}</p>` : '';
  const call = transcript
    ? (transcript.summary.length
        ? `<p><strong>Call summary</strong></p><ul>${transcript.summary.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
        : '') + `<p><strong>Call transcript</strong></p>${transcriptHtml(transcript.turns)}`
    : '';
  return [existing?.trim() ?? '', added, call].filter(Boolean).join('');
}

// The contact's invite changes with the interview: moved or canceled.
function changesInvite(row: MeetingLog): boolean {
  return Boolean(row.calendar_event_id) && (row.outcome === 'RESCHEDULED' || row.outcome === 'CANCELED');
}

// Kept in step with d1MeetingLogStore.unfinished.
export function meetingLogDone(row: MeetingLog): boolean {
  return (
    Boolean(row.outcome_at) &&
    (!changesInvite(row) || Boolean(row.calendar_at)) &&
    (!row.next_type || Boolean(row.next_task_id)) &&
    Boolean(row.lead_status_at)
  );
}

// `seenStartAt` is the meeting's start time on the page the rep submitted
// from: if HubSpot has moved it since, the rep sees the new time first.
export async function runMeetingLogged(
  hs: HubSpot,
  store: MeetingLogStore,
  meetingId: string,
  seenStartAt: number | null,
  input: MeetingLogInput,
  opts: MeetingLoggedOptions
): Promise<MeetingLoggedResult> {
  let row = (await store.unfinished(meetingId)) ?? (await store.get(meetingLogId(meetingId, seenStartAt)));
  const logId = row?.log_id ?? meetingLogId(meetingId, seenStartAt);
  let who: string | null = null;
  if (!row) {
    const { meeting, contact, company } = await loadMeeting(hs, meetingId);
    who = whoLabel(contactName(contact), companyName(company));
    const p = meeting.properties;
    if (parseHubSpotTime(p.hs_meeting_start_time) !== seenStartAt) {
      throw new WorkflowError(
        'This interview’s time changed in HubSpot since you opened it. Reload and log it again.',
        409
      );
    }
    if (!isOpen(meetingOutcome(p.hs_meeting_outcome))) {
      throw new WorkflowError('This interview already has an outcome in HubSpot, so nothing was changed.', 409);
    }
    const { next, newStart } = input;
    const canceledBy = input.outcome === 'CANCELED' ? (input.canceledBy ?? 'them') : null;
    // An email follow-up after a no-show, or after they canceled, comes
    // drafted, ready to send.
    const firstName = contact.properties.firstname?.trim() || null;
    const phone = isPhoneInterview(p.hs_meeting_location);
    const draft =
      next?.type !== 'EMAIL'
        ? null
        : input.outcome === 'NO_SHOW'
          ? {
              email: missedInterviewEmail({
                firstName,
                when: saidWhen(seenStartAt ?? opts.now, opts.now, opts.timeZone),
                phone,
              }),
              subject: missedInterviewSubject(companyName(company), contactName(contact)),
            }
          : canceledBy === 'them'
            ? {
                email: canceledInterviewEmail({ firstName, phone }),
                subject: canceledInterviewSubject(companyName(company), contactName(contact)),
              }
            : null;
    let newStartIso: string | null = null;
    let newEndIso: string | null = null;
    if (newStart) {
      const startAt = saidAt(newStart.date, newStart.time, opts.timeZone);
      if (startAt <= opts.now) throw new WorkflowError('That time has already passed. Pick a later one.');
      const oldEnd = parseHubSpotTime(p.hs_meeting_end_time);
      const length = seenStartAt !== null && oldEnd !== null && oldEnd > seenStartAt ? oldEnd - seenStartAt : 1_800_000;
      newStartIso = new Date(startAt).toISOString();
      newEndIso = new Date(startAt + length).toISOString();
    }
    await store.create({
      log_id: logId,
      meeting_id: meetingId,
      contact_id: contact.id,
      company_id: company?.id ?? null,
      owner_id: p.hubspot_owner_id || null,
      outcome: input.outcome,
      canceled_by: canceledBy,
      notes: input.notes,
      internal_notes_html: internalNotesHtml(p.hs_internal_meeting_notes, input.notes, input.transcript ?? null),
      new_start: newStartIso,
      new_end: newEndIso,
      next_type: next?.type ?? null,
      next_subject: !next
        ? null
        : (draft?.subject ?? interviewFollowUpSubject(next.type, companyName(company), contactName(contact))),
      next_body: draft ? toTaskBodyHtml(draft.email.subject, draft.email.body) : null,
      next_due: next ? new Date(localDateAt(next.date, opts.timeZone, DEFAULT_NEXT_TIME)).toISOString() : null,
      calendar_event_id: await store.calendarEventFor(meetingId),
    });
    row = await store.get(logId);
    if (!row) throw new Error(`meeting_logs row for ${logId} missing right after insert`);
  }

  const newStartAt = parseHubSpotTime(row.new_start);
  if (meetingLogDone(row)) {
    return {
      outcome: row.outcome,
      newStartAt,
      nextTaskId: row.next_task_id,
      nextTaskCreated: false,
      leadStatus: null,
      inviteUpdated: false,
      contactId: row.contact_id,
      who,
    };
  }

  if (!(await store.acquireLock(logId, Math.floor(opts.now / 1000), LOCK_TTL_SEC))) {
    throw new WorkflowError('This interview is already being logged. Refresh in a moment.', 409);
  }

  try {
    row = (await store.get(logId)) ?? row;
    const links = { contactId: row.contact_id, companyId: row.company_id };

    // A PATCH with the same values, so repeating it is harmless.
    if (!row.outcome_at) {
      await hs.updateObject('meetings', meetingId, {
        hs_meeting_outcome: row.outcome,
        hs_internal_meeting_notes: row.internal_notes_html,
        ...(row.new_start && row.new_end
          ? { hs_meeting_start_time: row.new_start, hs_meeting_end_time: row.new_end, hs_timestamp: row.new_start }
          : {}),
      });
      await store.markOutcome(logId, new Date(opts.now).toISOString());
    }

    // Both calls are safe to repeat: an invite already moved or canceled is
    // left alone, so the contact is told once.
    let inviteUpdated = false;
    if (changesInvite(row) && row.calendar_event_id && !row.calendar_at) {
      if (!opts.calendar) throw new Error('runMeetingLogged needs a calendar to change the interview’s invite');
      if (row.outcome === 'CANCELED') await opts.calendar.cancel(row.calendar_event_id);
      else if (row.new_start && row.new_end)
        await opts.calendar.move(row.calendar_event_id, row.new_start, row.new_end);
      await store.markCalendarDone(logId, new Date(opts.now).toISOString());
      inviteUpdated = true;
    }

    let nextTaskId = row.next_task_id;
    let nextTaskCreated = false;
    if (row.next_type && row.next_subject && row.next_due && !nextTaskId) {
      nextTaskId = await findOpenTask(hs, row.contact_id, row.next_type, row.next_subject);
      if (!nextTaskId) {
        nextTaskId = await hs.createTask(
          {
            hs_task_type: row.next_type,
            hs_task_status: 'NOT_STARTED',
            hs_task_subject: row.next_subject,
            hs_timestamp: row.next_due,
            ...(row.next_body ? { hs_task_body: row.next_body } : {}),
            ...(row.owner_id ? { hubspot_owner_id: row.owner_id } : {}),
          },
          links
        );
        nextTaskCreated = true;
      }
      await store.setNextTask(logId, nextTaskId);
    }

    // They talked (or agreed a new time): Connected, like a connected call.
    let leadStatus: string | null = null;
    if (!row.lead_status_at) {
      if (row.outcome === 'COMPLETED' || row.outcome === 'RESCHEDULED') {
        const contact = await hs.getObject('contacts', row.contact_id, ['hs_lead_status']);
        leadStatus = nextLeadStatus(contact.properties.hs_lead_status, 'connected');
        if (leadStatus) await hs.updateObject('contacts', row.contact_id, { hs_lead_status: leadStatus });
      }
      await store.markLeadStatusDone(logId, new Date(opts.now).toISOString());
    }

    return {
      outcome: row.outcome,
      newStartAt,
      nextTaskId,
      nextTaskCreated,
      leadStatus,
      inviteUpdated,
      contactId: row.contact_id,
      who,
    };
  } finally {
    await store.releaseLock(logId);
  }
}

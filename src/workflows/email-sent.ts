// Workflow 2: a rep confirms an outreach email actually went out. HubSpot has
// no send event for the one-to-one compose panel, so this is always a human
// click, never something we can detect.
//
// Two writes to HubSpot, each recorded in D1 as it lands, so any rerun (a
// double-click, or a retry after an error) resumes instead of repeating:
//   1. mark the EMAIL task COMPLETED
//   2. create a CALL task for the next calendar day on the same Contact + Company,
//      due at the same local time of day as the email task (the
//      hubspot-email-sent-followup skill's rule), else 09:00. A contact who
//      already has an open CALL task keeps that one instead (openCallTask).
// Ranking the remaining queue (step 3) is read-only and lives in email-queue.ts.

import { nextCalendarDayAt, parseHubSpotTime, timeOfDay, type TimeOfDay } from '../lib/dates';
import type { Confirmation, ConfirmationStore } from '../lib/db';
import type { HubSpot, HubSpotObject } from '../lib/hubspot';
import { hasReminder } from '../lib/set-time';
import {
  COMPANY_PROPS,
  CONTACT_PROPS,
  companyName,
  contactName,
  loadTask,
  ownerOf,
  WorkflowError,
  type TaskParties,
} from './parties';

// Long enough to cover both HubSpot writes; short enough that a crashed run
// doesn't hold the task for long.
const LOCK_TTL_SEC = 60;
// Used only when the email task has no usable due time to copy.
const DEFAULT_CALL_TIME: TimeOfDay = { hour: 9, minute: 0 };

export interface EmailSentOptions {
  now: number; // epoch ms
  timeZone: string;
  // True when runSend calls this after Gmail took the email. The email went
  // out, so a task dropped at the same moment is completed anyway. From Mark
  // sent, a dropped (DEFERRED) task is refused.
  afterSend?: boolean;
  // The task, contact and company when the caller already loaded them (the
  // send did, moments ago), so they aren't read again.
  parties?: TaskParties;
}

const DROPPED = 'This task was dropped (Deferred in HubSpot), so it wasn’t marked sent.';

export interface EmailSentResult {
  callTaskId: string;
  completedNow: boolean; // false if an earlier run already completed the task
  callTaskCreated: boolean; // false if an earlier run's CALL task was reused
}

export function followUpSubject(company: string | null, contact: string): string {
  return company ? `Call: ${company} (${contact}) — follow up on email` : `Call: ${contact} — follow up on email`;
}

export async function runEmailSent(
  hs: HubSpot,
  store: ConfirmationStore,
  emailTaskId: string,
  opts: EmailSentOptions
): Promise<EmailSentResult> {
  return finishEmailSent(hs, store, await prepareEmailSent(hs, store, emailTaskId, opts), opts);
}

// In two parts, like logging a call. prepareEmailSent records the task's
// contact and company and takes the lock; finishEmailSent is only HubSpot
// writes, so it can run after the page has answered (routes/send.ts, sent.ts).
export type PreparedEmailSent =
  | { kind: 'done'; row: Confirmation; callTaskId: string } // both steps landed on an earlier run
  | { kind: 'locked'; row: Confirmation; parties: TaskParties | null }; // this run holds the lock

export async function prepareEmailSent(
  hs: HubSpot,
  store: ConfirmationStore,
  emailTaskId: string,
  opts: EmailSentOptions
): Promise<PreparedEmailSent> {
  let parties: TaskParties | null = null; // when read in this run
  let row = await store.get(emailTaskId);
  if (!row) {
    parties = opts.parties ?? (await loadTask(hs, emailTaskId, 'EMAIL', ['tasks']));
    if (!opts.afterSend && parties.task.properties.hs_task_status === 'DEFERRED') {
      throw new WorkflowError(DROPPED, 409);
    }
    await store.create({ emailTaskId, contactId: parties.contact.id, companyId: parties.company?.id ?? null });
    row = await store.get(emailTaskId);
    if (!row) throw new Error(`sent_confirmations row for ${emailTaskId} missing right after insert`);
  }

  if (row.completed_at && row.call_task_id) return { kind: 'done', row, callTaskId: row.call_task_id };

  if (!(await store.acquireLock(emailTaskId, Math.floor(opts.now / 1000), LOCK_TTL_SEC))) {
    throw new WorkflowError('This task is already being processed. Refresh in a moment.', 409);
  }
  // Re-read under the lock: a run that held it before us may have finished steps.
  return { kind: 'locked', row: (await store.get(emailTaskId)) ?? row, parties };
}

// The HubSpot steps. Under the lock prepareEmailSent took, released at the
// end either way; a step that fails leaves its error on the row for the
// notice, and the next run picks up from the first step not yet recorded.
export async function finishEmailSent(
  hs: HubSpot,
  store: ConfirmationStore,
  prepared: PreparedEmailSent,
  opts: EmailSentOptions
): Promise<EmailSentResult> {
  if (prepared.kind === 'done') {
    // Both steps are done, but a Drop racing this workflow can have reopened
    // the task in HubSpot. Running again puts COMPLETED back.
    const emailTaskId = prepared.row.email_task_id;
    const current = await hs.getObject('tasks', emailTaskId, ['hs_task_status']);
    if (current.properties.hs_task_status !== 'COMPLETED') {
      await hs.updateObject('tasks', emailTaskId, { hs_task_status: 'COMPLETED' });
    }
    return { callTaskId: prepared.callTaskId, completedNow: false, callTaskCreated: false };
  }

  const { row, parties } = prepared;
  const emailTaskId = row.email_task_id;
  let emailTask: HubSpotObject | null = parties?.task ?? null;
  let contact: HubSpotObject | null = parties?.contact ?? null;
  let company: HubSpotObject | null = parties?.company ?? null;
  const knownTaskIds = parties?.related?.tasks; // the contact's tasks, read with it in this run
  try {
    let completedNow = false;
    if (!row.completed_at) {
      // Read again after our D1 row exists: a Drop that raced the check above
      // sees the row and backs off, or it landed first and is seen here.
      if (!opts.afterSend) {
        const current = await hs.getObject('tasks', emailTaskId, ['hs_task_status']);
        if (current.properties.hs_task_status === 'DEFERRED') throw new WorkflowError(DROPPED, 409);
      }
      await hs.updateObject('tasks', emailTaskId, { hs_task_status: 'COMPLETED' });
      await store.markCompleted(emailTaskId, new Date(opts.now).toISOString());
      completedNow = true;
    }

    if (row.call_task_id) {
      if (row.last_error) await store.setError(emailTaskId, null);
      return { callTaskId: row.call_task_id, completedNow, callTaskCreated: false };
    }

    contact ??= await hs.getObject('contacts', row.contact_id, CONTACT_PROPS);
    if (!company && row.company_id) company = await hs.getObject('companies', row.company_id, COMPANY_PROPS);

    emailTask ??= await hs.getObject('tasks', emailTaskId, ['hs_timestamp', 'hubspot_owner_id']);
    const emailDue = parseHubSpotTime(emailTask.properties.hs_timestamp);
    const callTime = emailDue === null ? DEFAULT_CALL_TIME : timeOfDay(emailDue, opts.timeZone);

    const subject = followUpSubject(companyName(company), contactName(contact));
    const followUpAt = nextCalendarDayAt(opts.now, opts.timeZone, callTime);
    const existing = await openCallTask(hs, contact.id, subject, knownTaskIds);
    if (existing && laterCall(existing, followUpAt)) {
      await hs.updateObject('tasks', existing.id, { hs_timestamp: new Date(followUpAt).toISOString() });
    }
    const callTaskId =
      existing?.id ??
      (await hs.createTask(
        {
          hs_task_type: 'CALL',
          hs_task_status: 'NOT_STARTED',
          hs_task_subject: subject,
          hs_timestamp: new Date(followUpAt).toISOString(),
          ...ownerOf(emailTask),
        },
        { contactId: contact.id, companyId: company?.id ?? null }
      ));
    await store.setCallTask(emailTaskId, callTaskId);
    if (row.last_error) await store.setError(emailTaskId, null);

    return { callTaskId, completedNow, callTaskCreated: existing === null };
  } catch (err) {
    await store
      .setError(emailTaskId, err instanceof Error ? err.message : String(err))
      .catch((e: unknown) => console.error('recording why the follow-up stopped', e));
    throw err;
  } finally {
    await store.releaseLock(emailTaskId);
  }
}

// The contact's CALL task to use as the follow-up, so a send never leaves
// them with two: the one an earlier run of this send created but D1 never
// heard about (by its subject), else any call already waiting on them (made
// from their page, by hand in HubSpot, or left by a logged call).
async function openCallTask(
  hs: HubSpot,
  contactId: string,
  subject: string,
  knownTaskIds?: string[]
): Promise<HubSpotObject | null> {
  const taskIds = knownTaskIds ?? (await hs.associatedIds('contacts', contactId, 'tasks'));
  if (taskIds.length === 0) return null;
  const calls = (
    await hs.batchRead('tasks', taskIds, [
      'hs_task_subject',
      'hs_task_type',
      'hs_task_status',
      'hs_timestamp',
      'hs_task_reminders',
    ])
  ).filter((t) => t.properties.hs_task_type === 'CALL');
  return (
    calls.find((t) => t.properties.hs_task_status !== 'COMPLETED' && t.properties.hs_task_subject === subject) ??
    calls.find((t) => t.properties.hs_task_status === 'NOT_STARTED') ??
    null
  );
}

// A call already waiting moves to the follow-up's time when it was due
// sooner: calling a few hours after the email would beat it there. One at a
// set time (the contact asked for it) or already due later stays put.
function laterCall(task: HubSpotObject, followUpAt: number): boolean {
  if (hasReminder(task.properties.hs_task_reminders)) return false;
  const due = parseHubSpotTime(task.properties.hs_timestamp);
  return due === null || due < followUpAt;
}

// Frees the lock prepareEmailSent took when something before finishEmailSent
// failed (logging the email on the contact, after a send), keeping the error.
export async function abandonEmailSent(store: ConfirmationStore, prepared: PreparedEmailSent, err: unknown) {
  if (prepared.kind !== 'locked') return;
  await store.setError(prepared.row.email_task_id, err instanceof Error ? err.message : String(err));
  await store.releaseLock(prepared.row.email_task_id);
}

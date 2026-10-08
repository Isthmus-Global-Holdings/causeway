// Small task changes the rep would otherwise make in HubSpot's task UI:
//   - move a CALL task to another day or a set time without logging a call
//   - drop an EMAIL task that won't be sent (DEFERRED, as done by hand before)
// Each is one PATCH to an absolute value, so a double submit or a retry
// writes the same thing again and needs no D1 row.

import { isDate, localDate, parseHubSpotTime, saidAt, sameTimeOn, type SaidTime, type TimeOfDay } from '../lib/dates';
import type { ConfirmationStore, SentEmailStore } from '../lib/db';
import type { HubSpot, HubSpotObject } from '../lib/hubspot';
import { hasReminder, reminderFor } from '../lib/set-time';
import { WorkflowError, type TaskType } from './parties';

const DEFAULT_CALL_TIME: TimeOfDay = { hour: 9, minute: 0 };
const PROPS = ['hs_task_type', 'hs_task_status', 'hs_timestamp', 'hs_task_reminders'];

async function loadOpen(hs: HubSpot, taskId: string, type: TaskType): Promise<HubSpotObject> {
  const task = await hs.getObject('tasks', taskId, PROPS);
  const actual = task.properties.hs_task_type;
  if (actual !== type) {
    throw new WorkflowError(`Task ${taskId} is a ${actual ?? 'untyped'} task, not ${type}.`);
  }
  return task;
}

// The new due instant: `date` at `time`, which makes it a set-time call
// (lib/set-time.ts), else at the time of day the task was due (09:00 if
// none). A set-time call moved without a time keeps its time and reminder.
export async function snoozeCall(
  hs: HubSpot,
  taskId: string,
  date: string,
  time: SaidTime | null,
  opts: { now: number; timeZone: string }
): Promise<{ dueAt: number }> {
  if (!isDate(date)) throw new WorkflowError('Pick a day to move the call to.');
  const today = localDate(opts.now, opts.timeZone);
  if (time ? date < today : date <= today) throw new WorkflowError('Pick a day after today, or a time.');
  const dueAt = time ? saidAt(date, time, opts.timeZone) : null;
  if (dueAt !== null && dueAt <= opts.now) throw new WorkflowError('That time has already passed.');
  const task = await loadOpen(hs, taskId, 'CALL');
  if (task.properties.hs_task_status !== 'NOT_STARTED') {
    throw new WorkflowError('This call task is no longer open, so it wasn’t moved.', 409);
  }
  const due =
    dueAt ?? sameTimeOn(date, parseHubSpotTime(task.properties.hs_timestamp), opts.timeZone, DEFAULT_CALL_TIME);
  await hs.updateObject('tasks', taskId, {
    hs_timestamp: new Date(due).toISOString(),
    ...(time || hasReminder(task.properties.hs_task_reminders) ? { hs_task_reminders: reminderFor(due) } : {}),
  });
  return { dueAt: due };
}

// An email the app sent or may have sent, or one marked sent, is never
// dropped: its task has to finish through that flow so the follow-up call
// gets created. `completed` means that flow already set COMPLETED in HubSpot.
async function sendState(
  sent: SentEmailStore,
  confirmations: ConfirmationStore,
  taskId: string
): Promise<{ started: boolean; completed: boolean }> {
  const [row, confirmation] = await Promise.all([sent.get(taskId), confirmations.get(taskId)]);
  return { started: row !== null || confirmation !== null, completed: Boolean(confirmation?.completed_at) };
}

const SEND_STARTED =
  'An email for this task was sent, is being sent, or was marked sent from this app. Open its send page instead.';

export async function dropEmail(
  hs: HubSpot,
  sent: SentEmailStore,
  confirmations: ConfirmationStore,
  taskId: string
): Promise<void> {
  if ((await sendState(sent, confirmations, taskId)).started) throw new WorkflowError(SEND_STARTED, 409);
  const task = await loadOpen(hs, taskId, 'EMAIL');
  const status = task.properties.hs_task_status;
  if (status === 'DEFERRED') return;
  if (status !== 'NOT_STARTED') {
    throw new WorkflowError('This email task is no longer open, so it wasn’t dropped.', 409);
  }
  await hs.updateObject('tasks', taskId, { hs_task_status: 'DEFERRED' });

  // Send and Mark sent write their D1 row, then read the task's status; this
  // writes the status, then reads D1. So when the two overlap, at least one
  // sees the other. If a send or Mark sent started meanwhile, it wins: the
  // task gets back the status that flow left, COMPLETED if it already finished
  // (its retries skip that step), else open for it to finish.
  const after = await sendState(sent, confirmations, taskId);
  if (after.started) {
    const current = await hs.getObject('tasks', taskId, ['hs_task_status']);
    if (current.properties.hs_task_status === 'DEFERRED') {
      await hs.updateObject('tasks', taskId, { hs_task_status: after.completed ? 'COMPLETED' : 'NOT_STARTED' });
    }
    throw new WorkflowError(SEND_STARTED, 409);
  }
}

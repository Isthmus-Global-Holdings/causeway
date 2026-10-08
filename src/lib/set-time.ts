// A call at a set time: the prospect asked to be called then. Every call
// task has a due time (09:00 when nobody picked one, or the email task's), so
// the time alone can't say that. A set-time call is one with a HubSpot
// reminder (hs_task_reminders), which the app sets LEAD_MS before the call:
// HubSpot notifies the rep then, and the queue makes it the next call from
// then on, never before. A reminder set by hand in HubSpot counts too.
// No I/O here.

export const SET_TIME_LEAD_MS = 5 * 60_000;

// hs_task_reminders: epoch ms, as text (several are joined with ";").
export function reminderFor(dueMs: number): string {
  return String(dueMs - SET_TIME_LEAD_MS);
}

export function hasReminder(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

// From when a set-time call is the one to make.
export function callableFrom(dueMs: number): number {
  return dueMs - SET_TIME_LEAD_MS;
}

// The time they asked to be called at, from callableFrom's: what a page shows.
export function askedFor(callableMs: number): number {
  return callableMs + SET_TIME_LEAD_MS;
}

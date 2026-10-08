// Calls due: every NOT_STARTED CALL task, soonest due first. Most are the
// follow-ups runEmailSent creates the day after an email goes out. The ones
// due today are ranked by who to call first (see planCalls), except the calls
// at a set time (lib/set-time.ts), which wait for their time.

import { partyTimeZone } from '../lib/address';
import { localDate, parseHubSpotTime } from '../lib/dates';
import type { ContactEngagement } from '../lib/db';
import { FIT_RANK, parseFitLabel, type FitLabel } from '../lib/fit';
import type { HubSpot } from '../lib/hubspot';
import { toE164 } from '../lib/phone';
import { callableFrom, hasReminder } from '../lib/set-time';
import type { WorkPlan } from '../lib/work-plan';
import { upcomingInterviewFor, type MeetingRow } from './meeting-queue';
import { companyName, contactName, loadOpenTasks } from './parties';

export interface CallRow {
  taskId: string;
  subject: string;
  dueAt: number | null; // epoch ms
  setTime: boolean; // the contact asked to be called at dueAt (lib/set-time.ts)
  contactId: string | null;
  contactName: string | null;
  companyName: string | null;
  timeZone: string | null; // theirs, from their address (or their company's)
  // First dialable number: phone, then mobile, then the company line.
  phone: string | null;
  // The contact's next interview, when the call is also one (see withInterviews).
  interview: { meetingId: string; startAt: number } | null;
  fit: FitLabel;
  // Opens and clicks on the emails the app sent them (see withEngagement).
  engagement: ContactEngagement | null;
}

export interface CallQueue {
  rows: CallRow[];
  truncated: boolean;
}

export async function loadCallQueue(hs: HubSpot): Promise<CallQueue> {
  const { tasks, truncated } = await loadOpenTasks(hs, 'CALL', [
    'hs_task_subject',
    'hs_timestamp',
    'hs_task_reminders',
  ]);
  const rows: CallRow[] = tasks.map(({ task, contact, company }) => ({
    taskId: task.id,
    subject: task.properties.hs_task_subject ?? '(no subject)',
    dueAt: parseHubSpotTime(task.properties.hs_timestamp),
    setTime: hasReminder(task.properties.hs_task_reminders),
    contactId: contact?.id ?? null,
    contactName: contact ? contactName(contact) : null,
    companyName: companyName(company),
    timeZone: partyTimeZone(contact, company),
    phone:
      toE164(contact?.properties.phone) ?? toE164(contact?.properties.mobilephone) ?? toE164(company?.properties.phone),
    interview: null,
    fit: parseFitLabel(company?.properties.description),
    engagement: null,
  }));
  return { rows: byDue(rows), truncated };
}

// Marks each call whose contact has an interview coming up, so a call that
// is also an interview says so.
export function withInterviews(queue: CallQueue, meetings: MeetingRow[], now: number, timeZone: string): CallQueue {
  return {
    ...queue,
    rows: queue.rows.map((row) => {
      const next = upcomingInterviewFor(meetings, row.contactId, now, timeZone);
      return next && next.startAt !== null
        ? { ...row, interview: { meetingId: next.meetingId, startAt: next.startAt } }
        : row;
    }),
  };
}

// Adds what each contact did with the emails the app sent them.
export function withEngagement(queue: CallQueue, byContact: Map<string, ContactEngagement>): CallQueue {
  return {
    ...queue,
    rows: queue.rows.map((row) => ({ ...row, engagement: (row.contactId && byContact.get(row.contactId)) || null })),
  };
}

export interface CallPlan {
  atTime: CallRow[]; // today's set-time calls, soonest first
  due: CallRow[]; // the rest due today or overdue, ranked by callFirst
  later: CallRow[]; // soonest first
  nextUp: CallRow | null;
}

// Splits the calls into today's and later ones, and ranks today's like the
// email queue: who to call first. Today's set-time calls are apart: one is
// the next call from a few minutes before its time (late or not), and never
// before. One from an earlier day that nobody made is just overdue.
export function planCalls(rows: CallRow[], now: number, timeZone: string): CallPlan {
  const today = localDate(now, timeZone);
  const day = (r: CallRow): string | null => (r.dueAt === null ? null : localDate(r.dueAt, timeZone));
  const atTime = byDue(rows.filter((r) => r.setTime && day(r) === today));
  const due = rows.filter((r) => !atTime.includes(r) && (day(r) ?? '9999') <= today).sort(callFirst);
  const nextUp = atTime.filter(canCall).find((r) => isCallTime(r, now)) ?? due.find(canCall) ?? null;
  return { atTime, due, later: rows.filter((r) => (day(r) ?? '9999') > today), nextUp };
}

// Today's calls in the order the page ranks them, saved so logging one can go
// straight to the next (nextInPlan): the set-time calls with their time, and
// who each is, for the list beside a call.
export function planItems(plan: CallPlan): WorkPlan['items'] {
  const who = (r: CallRow) => ({
    ...(r.companyName ? { company: r.companyName } : {}),
    ...(r.contactName ? { contact: r.contactName } : {}),
  });
  return [
    ...plan.atTime
      .filter(canCall)
      .map((r) => ({ id: r.taskId, drafted: false, at: callableFrom(r.dueAt ?? 0), ...who(r) })),
    ...plan.due.filter(canCall).map((r) => ({ id: r.taskId, drafted: false, ...who(r) })),
  ];
}

// A set-time call whose time has come (or passed).
export function isCallTime(row: CallRow, now: number): boolean {
  return row.setTime && row.dueAt !== null && now >= callableFrom(row.dueAt);
}

// Worth dialling now: there's a number, and the company isn't drop-flagged.
export function canCall(row: CallRow): boolean {
  return row.phone !== null && row.fit !== 'DROP';
}

export function clicked(row: CallRow): boolean {
  return (row.engagement?.clicks ?? 0) > 0;
}

export function opened(row: CallRow): boolean {
  return (row.engagement?.opens ?? 0) > 0;
}

// 0 clicked, 1 opened, 2 neither.
function warmth(row: CallRow): number {
  return clicked(row) ? 0 : opened(row) ? 1 : 2;
}

// 1. Calls that can be made before ones with no number, drop-flagged last.
// 2. Someone who clicked a link in your email: they're warm now.
// 3. Then someone who opened it. Opens are approximate (some mail apps and
//    corporate filters load images on their own), so they rank below clicks.
// 4. Company fit, like the email queue: STRONG, GOOD, weaker, unlabelled.
// 5. The most overdue.
function callFirst(a: CallRow, b: CallRow): number {
  const group = (r: CallRow): number => (r.fit === 'DROP' ? 2 : r.phone === null ? 1 : 0);
  return (
    group(a) - group(b) ||
    warmth(a) - warmth(b) ||
    FIT_RANK[a.fit] - FIT_RANK[b.fit] ||
    (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
  );
}

// Undated tasks last; ties keep HubSpot's order (oldest created first).
function byDue(rows: CallRow[]): CallRow[] {
  return rows.sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER));
}

export interface MovedCall {
  taskId: string;
  dueAt: number;
  setTime: boolean;
}

// HubSpot's search index trails a write by a few seconds, and a logged call's
// HubSpot steps run after the page answered, so the search can still return
// a task the rep just logged or moved. `logged` are the calls logged through
// the app lately (D1) and the redirect's; the redirect says what moved, and
// whether to a set time (moved without one, a call keeps what it was).
export function applyRecentChange(
  queue: CallQueue,
  change: { logged: Set<string>; moved: MovedCall | null }
): CallQueue {
  const { logged, moved } = change;
  const rows = queue.rows
    .filter((r) => !logged.has(r.taskId))
    .map((r) =>
      moved && r.taskId === moved.taskId ? { ...r, dueAt: moved.dueAt, setTime: r.setTime || moved.setTime } : r
    );
  return { ...queue, rows: byDue(rows) };
}

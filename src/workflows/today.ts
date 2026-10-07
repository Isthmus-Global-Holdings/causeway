// The counts at the top of the Queue, Calls and Interviews pages: emails sent,
// people called and interviews had today, in the rep's time zone. Emails and
// calls come from D1 (what the rep did through the app); interviews from the
// HubSpot meetings that start today.

import { dayBounds, parseHubSpotTime } from '../lib/dates';
import { dayActivity } from '../lib/db';
import type { HubSpot } from '../lib/hubspot';
import { isOpen, meetingOutcome, type MeetingRow } from './meeting-queue';

export interface TodayCounts {
  emailsSent: number;
  peopleCalled: number;
  // null when HubSpot's meetings couldn't be read: a 0 would read as "none".
  interviews: { had: number; open: number } | null;
}

type MeetingTimes = Pick<MeetingRow, 'startAt' | 'outcome'>;

// Had: logged as completed. Open: still scheduled, whether it's later today
// or over and waiting for its outcome.
export function countInterviews(rows: MeetingTimes[], bounds: { startMs: number; endMs: number }) {
  const today = rows.filter((r) => r.startAt !== null && r.startAt >= bounds.startMs && r.startAt < bounds.endMs);
  return {
    had: today.filter((r) => r.outcome === 'COMPLETED').length,
    open: today.filter((r) => isOpen(r.outcome)).length,
  };
}

// Today's meetings on their own, for a page that doesn't already list them.
// One page of 100: more interviews than that in a day isn't this app's rep.
export async function todaysMeetings(hs: HubSpot, bounds: { startMs: number; endMs: number }): Promise<MeetingTimes[]> {
  const page = await hs.searchMeetings(
    [
      { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: String(bounds.startMs) },
      { propertyName: 'hs_meeting_start_time', operator: 'LTE', value: String(bounds.endMs - 1) },
    ],
    ['hs_meeting_start_time', 'hs_meeting_outcome'],
    null
  );
  return page.results.map((m) => ({
    startAt: parseHubSpotTime(m.properties.hs_meeting_start_time),
    outcome: meetingOutcome(m.properties.hs_meeting_outcome),
  }));
}

// `meetings` are the rows the page already loaded (the Calls and Interviews
// pages), null if they couldn't be read, or undefined to search for today's.
export async function loadTodayCounts(
  db: D1Database,
  hs: HubSpot,
  now: number,
  timeZone: string,
  meetings?: MeetingTimes[] | null
): Promise<TodayCounts> {
  const bounds = dayBounds(now, timeZone);
  const [activity, rows] = await Promise.all([
    dayActivity(db, Math.floor(bounds.startMs / 1000), Math.floor(bounds.endMs / 1000)),
    meetings === undefined
      ? todaysMeetings(hs, bounds).catch((err: unknown) => {
          console.error('meetings for today’s counts', err);
          return null;
        })
      : meetings,
  ]);
  return { ...activity, interviews: rows ? countInterviews(rows, bounds) : null };
}

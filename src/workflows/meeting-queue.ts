// Interviews: the rep's HubSpot meetings from a week back to two weeks ahead,
// soonest first. A meeting is HubSpot's record of a scheduled conversation
// (an interview here), with its own start time and outcome, unlike a CALL
// task, which is only a to-do.

import { localDate, parseHubSpotTime } from '../lib/dates';
import {
  MEETING_OUTCOMES,
  type HubSpot,
  type HubSpotObject,
  type MeetingOutcome,
  type ObjectType,
} from '../lib/hubspot';
import {
  CONTACT_PROPS,
  companyName,
  contactName,
  firstPhone,
  loadRecordParties,
  resolveParties,
  type ContactLinks,
  type Parties,
} from './parties';

export const MEETING_PROPS = [
  'hs_meeting_title',
  'hs_meeting_start_time',
  'hs_meeting_end_time',
  'hs_meeting_outcome',
  'hs_meeting_external_url',
  'hs_meeting_location',
  'hs_meeting_body',
  'hs_internal_meeting_notes',
  'hubspot_owner_id',
];

const DAY_MS = 86_400_000;
const LOOK_BACK_MS = 7 * DAY_MS;
const LOOK_AHEAD_MS = 14 * DAY_MS;
// 5 pages of 100: a rep with more interviews than this in three weeks has a
// team, and this app isn't built for one.
const MAX_PAGES = 5;

export interface MeetingRow {
  meetingId: string;
  title: string;
  startAt: number | null; // epoch ms
  endAt: number | null;
  outcome: MeetingOutcome;
  joinUrl: string | null;
  contactId: string | null;
  contactName: string | null;
  companyName: string | null;
  phoneCall: boolean; // a phone interview: the rep calls them, there's no video link
  phone: string | null; // first dialable number: phone, mobile, then the company line
}

export function meetingOutcome(value: string | null | undefined): MeetingOutcome {
  return MEETING_OUTCOMES.find((o) => o === value) ?? 'SCHEDULED';
}

// Still to happen, or happened without an outcome logged.
export function isOpen(outcome: MeetingOutcome): boolean {
  return outcome === 'SCHEDULED' || outcome === 'RESCHEDULED';
}

// A join link is shown as a button, so only a plain https URL is used.
export function httpsUrl(value: string | null | undefined): string | null {
  const url = (value ?? '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

// A phone interview is booked with its location set to "Phone: <number>"
// (phoneLocation in book-interview.ts).
export const PHONE_LOCATION_PREFIX = 'Phone';

export function isPhoneInterview(location: string | null | undefined): boolean {
  return (location ?? '').trim().startsWith(PHONE_LOCATION_PREFIX);
}

export function meetingRow(meeting: HubSpotObject, { contact, company }: Parties): MeetingRow {
  const p = meeting.properties;
  return {
    meetingId: meeting.id,
    title: p.hs_meeting_title || 'Meeting',
    startAt: parseHubSpotTime(p.hs_meeting_start_time),
    endAt: parseHubSpotTime(p.hs_meeting_end_time),
    outcome: meetingOutcome(p.hs_meeting_outcome),
    joinUrl: httpsUrl(p.hs_meeting_external_url),
    contactId: contact?.id ?? null,
    contactName: contact ? contactName(contact) : null,
    companyName: companyName(company),
    phoneCall: isPhoneInterview(p.hs_meeting_location),
    phone: firstPhone(contact, company),
  };
}

export async function loadMeetings(hs: HubSpot, now: number): Promise<MeetingRow[]> {
  const meetings: HubSpotObject[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const page = await hs.searchMeetings(
      [
        { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: String(now - LOOK_BACK_MS) },
        { propertyName: 'hs_meeting_start_time', operator: 'LTE', value: String(now + LOOK_AHEAD_MS) },
      ],
      MEETING_PROPS,
      after
    );
    meetings.push(...page.results);
    after = page.after;
    pages += 1;
  } while (after && pages < MAX_PAGES);

  const parties = await resolveParties(hs, 'meetings', meetings);
  return meetings.map((m) => meetingRow(m, parties(m.id))).sort(byStart);
}

function byStart(a: MeetingRow, b: MeetingRow): number {
  return (a.startAt ?? Number.MAX_SAFE_INTEGER) - (b.startAt ?? Number.MAX_SAFE_INTEGER);
}

export interface MeetingBuckets {
  needsOutcome: MeetingRow[]; // over, still marked scheduled
  today: MeetingRow[]; // later today
  upcoming: MeetingRow[]; // after today
  recent: MeetingRow[]; // outcome logged, most recent first
}

export function bucketMeetings(rows: MeetingRow[], now: number, timeZone: string): MeetingBuckets {
  const today = localDate(now, timeZone);
  const buckets: MeetingBuckets = { needsOutcome: [], today: [], upcoming: [], recent: [] };
  for (const row of rows) {
    if (!isOpen(row.outcome)) buckets.recent.push(row);
    else if (row.startAt === null || localDate(row.startAt, timeZone) > today) buckets.upcoming.push(row);
    else if ((row.endAt ?? row.startAt) <= now) buckets.needsOutcome.push(row);
    else buckets.today.push(row);
  }
  buckets.recent.reverse();
  return buckets;
}

// The interview a call task's contact has coming up (today or later), for a
// badge on the call. The soonest one if there are several.
export function upcomingInterviewFor(
  rows: MeetingRow[],
  contactId: string | null,
  now: number,
  timeZone: string
): MeetingRow | null {
  if (!contactId) return null;
  const today = localDate(now, timeZone);
  return (
    rows.find(
      (r) =>
        r.contactId === contactId && isOpen(r.outcome) && r.startAt !== null && localDate(r.startAt, timeZone) >= today
    ) ?? null
  );
}

// HubSpot's search index trails a write by a few seconds, so right after the
// rep logs an interview the search can still show it as scheduled.
export function applyLoggedOutcome(
  rows: MeetingRow[],
  logged: { meetingId: string; outcome: MeetingOutcome; startAt: number | null } | null
): MeetingRow[] {
  if (!logged) return rows;
  return rows
    .map((r) =>
      r.meetingId === logged.meetingId
        ? {
            ...r,
            outcome: logged.outcome,
            ...(logged.startAt !== null && r.startAt !== null
              ? { startAt: logged.startAt, endAt: r.endAt === null ? null : logged.startAt + (r.endAt - r.startAt) }
              : {}),
          }
        : r
    )
    .sort(byStart);
}

export interface MeetingParties {
  meeting: HubSpotObject;
  contact: HubSpotObject;
  company: HubSpotObject | null;
  related?: ContactLinks;
}

// One meeting with the Contact and Company it belongs to, and the ids of the
// contact's `related` records.
export async function loadMeeting(hs: HubSpot, meetingId: string, related: ObjectType[] = []): Promise<MeetingParties> {
  const { record: meeting, ...parties } = await loadRecordParties(
    hs,
    'meetings',
    meetingId,
    MEETING_PROPS,
    [...CONTACT_PROPS, 'hs_lead_status'],
    related,
    { check: () => {}, noContact: `Meeting ${meetingId} isn’t associated with a contact.` }
  );
  return { meeting, ...parties };
}

export interface ContactMeetings {
  interviews: MeetingRow[]; // still open, starting today or later, soonest first
  missed: MeetingRow | null; // their last interview was a no-show, and nothing's booked since
}

// The contact's interviews for the call page: the ones coming up, and the
// last one if they didn't show, so the page can offer the last-try email.
export function sortContactMeetings(rows: MeetingRow[], now: number, timeZone: string): ContactMeetings {
  const today = localDate(now, timeZone);
  const sorted = [...rows].sort(byStart);
  const interviews = sorted.filter(
    (r) => isOpen(r.outcome) && r.startAt !== null && localDate(r.startAt, timeZone) >= today
  );
  const last = sorted.filter((r) => r.startAt !== null && r.startAt <= now).at(-1) ?? null;
  const missed = last?.outcome === 'NO_SHOW' && interviews.length === 0 ? last : null;
  return { interviews, missed };
}

export async function contactMeetings(
  hs: HubSpot,
  contactId: string,
  now: number,
  timeZone: string,
  knownIds?: string[] // when the page already read them with the contact
): Promise<ContactMeetings> {
  const ids = knownIds ?? (await hs.associatedIds('contacts', contactId, 'meetings'));
  if (ids.length === 0) return { interviews: [], missed: null };
  const meetings = await hs.batchRead('meetings', ids, MEETING_PROPS);
  return sortContactMeetings(
    meetings.map((m) => meetingRow(m, { contact: null, company: null })),
    now,
    timeZone
  );
}

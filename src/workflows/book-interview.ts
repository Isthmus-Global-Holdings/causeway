// Booking an interview: a meeting in HubSpot, on the contact (and company)
// of the call task that set it up. Either while logging the call (step 5 of
// runCallLogged) or on its own from the call page (runBooking below).
//
// Creating a meeting isn't safe to repeat by itself, so both paths first
// look for one already on the contact at the same time with the same title,
// the way findOpenTask guards follow-up tasks: a run that died after HubSpot
// created the meeting reuses it instead of booking a second one.
//
// An interview is a phone call (the default) or a video call. A phone
// interview has no join link: the rep calls the contact at the number HubSpot
// had when it was booked, and the meeting's location says so. Dialling still
// reads the number from HubSpot at the time, like any call.
//
// If the rep asks, a Google Calendar invite goes to the contact first (for a
// video call, with a Google Meet link unless the rep gave a join link, which
// is put on the meeting). The invite's id comes from the booking, so a retry
// can't send a second one.

import { isDate, localDateAt, parseHubSpotTime, parseTime, type TimeOfDay } from '../lib/dates';
import type { MeetingBookingStore } from '../lib/db';
import type { HubSpot, HubSpotObject, RecordLinks } from '../lib/hubspot';
import { formatPhone } from '../lib/phone';
import { httpsUrl, PHONE_LOCATION_PREFIX } from './meeting-queue';
import { companyName, contactName, firstPhone, loadTask, WorkflowError } from './parties';

const LOCK_TTL_SEC = 60;
export const LENGTHS_MIN = [15, 30, 45, 60] as const;

export interface BookingInput {
  date: string; // "YYYY-MM-DD" in the rep's time zone
  time: TimeOfDay;
  minutes: number;
  byPhone: boolean; // a phone interview: the rep calls them
  joinUrl: string | null; // video only
  invite: boolean; // send the contact a calendar invite
}

export interface Invite {
  key: string; // the booking's key: the same key never sends a second invite
  withWhom: string; // "Company (Contact)", for the event's title
  attendeeEmail: string;
  startAt: string; // ISO
  endAt: string;
  joinUrl: string | null; // null (and no phone): add a Google Meet link
  phone: string | null; // E.164: a phone interview, the rep calls this number
}

// The connected Google account's calendar.
export interface Calendar {
  invite(invite: Invite): Promise<{ eventId: string; meetUrl: string | null }>;
  // Both email the attendee, and both are safe to repeat: an event already
  // at the new time, or already canceled, is left alone.
  move(eventId: string, startAt: string, endAt: string): Promise<void>;
  cancel(eventId: string): Promise<void>;
}

// The booking form's fields, as the routes pass them on to parseBookingForm.
// Every book_* input on the call page must be listed here (a test checks).
export const BOOKING_FIELDS = [
  'book_date',
  'book_time',
  'book_minutes',
  'book_format',
  'book_join_url',
  'book_invite',
] as const;

export function bookingFieldsOf(text: (key: string) => string | undefined): Record<string, string | undefined> {
  return Object.fromEntries(BOOKING_FIELDS.map((key) => [key, text(key)]));
}

// The booking fields (book_date, book_time, book_minutes, book_format,
// book_join_url), checked. `today` is "YYYY-MM-DD" in the rep's time zone.
// A phone interview ignores the join link.
export function parseBookingForm(form: Record<string, string | undefined>, today: string): BookingInput {
  const date = form.book_date ?? '';
  const time = parseTime(form.book_time ?? '');
  if (!isDate(date) || !time) throw new WorkflowError('Pick the date and time of the interview.');
  if (date < today) throw new WorkflowError('The interview date is in the past.');
  const minutes = LENGTHS_MIN.find((m) => String(m) === form.book_minutes) ?? 30;
  const invite = form.book_invite === '1';
  if (form.book_format === 'phone') return { date, time, minutes, byPhone: true, joinUrl: null, invite };
  const rawUrl = (form.book_join_url ?? '').trim();
  const joinUrl = rawUrl ? httpsUrl(rawUrl) : null;
  if (rawUrl && !joinUrl) throw new WorkflowError('The join link must be an https:// address (a Meet or Zoom link).');
  return { date, time, minutes, byPhone: false, joinUrl, invite };
}

// The number a phone interview is on, from HubSpot, or an error saying what
// to fix. Null for a video interview.
export function bookingPhone(contact: HubSpotObject, company: HubSpotObject | null, byPhone: boolean): string | null {
  if (!byPhone) return null;
  const phone = firstPhone(contact, company);
  if (!phone) {
    throw new WorkflowError(
      `${contactName(contact)} has no phone number in HubSpot, so there's nothing to call. Add one, or book a video call.`
    );
  }
  return phone;
}

// The meeting's location for a phone interview (isPhoneInterview reads it).
export function phoneLocation(phone: string): string {
  return `${PHONE_LOCATION_PREFIX}: ${formatPhone(phone)}`;
}

export function interviewTitle(company: string | null, contact: string): string {
  return company ? `Interview: ${company} (${contact})` : `Interview: ${contact}`;
}

// Who the interview is with, from its title: what the contact sees in the
// invite, without the word "Interview".
export function interviewee(title: string): string {
  return title.replace(/^Interview: /, '');
}

// Sends the invite (once) for a booking that asked for one. Returns the join
// link to put on the meeting: the rep's own, else the invite's Meet link, and
// none for a phone interview.
export async function sendInvite(
  calendar: Calendar,
  key: string,
  booking: {
    title: string;
    startAt: string;
    endAt: string;
    joinUrl: string | null;
    phone: string | null;
    attendeeEmail: string;
  }
): Promise<{ eventId: string; joinUrl: string | null }> {
  const sent = await calendar.invite({
    key,
    withWhom: interviewee(booking.title),
    attendeeEmail: booking.attendeeEmail,
    startAt: booking.startAt,
    endAt: booking.endAt,
    joinUrl: booking.phone ? null : booking.joinUrl,
    phone: booking.phone,
  });
  if (booking.phone) return { eventId: sent.eventId, joinUrl: null };
  return { eventId: sent.eventId, joinUrl: booking.joinUrl ?? sent.meetUrl };
}

export interface MeetingToBook {
  title: string;
  startAt: string; // ISO
  endAt: string;
  joinUrl: string | null;
  phone: string | null; // E.164: a phone interview
  ownerId: string | null;
}

// The interview's start and end. `now` guards the first submission: a time
// earlier today would book an interview (and send an invite) in the past.
export function bookingTimes(
  input: BookingInput,
  timeZone: string,
  now: number | null = null
): { startAt: string; endAt: string } {
  const start = localDateAt(input.date, timeZone, input.time);
  if (now !== null && start <= now)
    throw new WorkflowError('That interview time has already passed. Pick a later one.');
  return { startAt: new Date(start).toISOString(), endAt: new Date(start + input.minutes * 60_000).toISOString() };
}

// The contact's meeting at this start time with this title, if one exists.
async function findMeeting(hs: HubSpot, contactId: string, startAt: string, title: string): Promise<string | null> {
  const ids = await hs.associatedIds('contacts', contactId, 'meetings');
  if (ids.length === 0) return null;
  const meetings = await hs.batchRead('meetings', ids, ['hs_meeting_title', 'hs_meeting_start_time']);
  const start = Date.parse(startAt);
  const match = meetings.find(
    (m) => m.properties.hs_meeting_title === title && parseHubSpotTime(m.properties.hs_meeting_start_time) === start
  );
  return match?.id ?? null;
}

export async function findOrCreateMeeting(
  hs: HubSpot,
  links: RecordLinks,
  meeting: MeetingToBook
): Promise<{ meetingId: string; created: boolean }> {
  const existing = await findMeeting(hs, links.contactId, meeting.startAt, meeting.title);
  if (existing) return { meetingId: existing, created: false };
  const meetingId = await hs.createMeeting(
    {
      title: meeting.title,
      bodyHtml: meeting.phone
        ? `<p>Phone interview: you call them at ${formatPhone(meeting.phone)}. Booked from Causeway.</p>`
        : '<p>Discovery interview, booked from Causeway.</p>',
      startAt: meeting.startAt,
      endAt: meeting.endAt,
      joinUrl: meeting.phone ? null : meeting.joinUrl,
      location: meeting.phone ? phoneLocation(meeting.phone) : null,
      ownerId: meeting.ownerId,
    },
    links
  );
  return { meetingId, created: true };
}

// The contact's email for the invite, or an error saying what to fix.
export function inviteeEmail(contact: HubSpotObject, invite: boolean): string | null {
  if (!invite) return null;
  const email = contact.properties.email?.trim();
  if (!email) {
    throw new WorkflowError(
      `${contactName(contact)} has no email in HubSpot, so there's nobody to send the invite to. Add one, or untick the invite.`
    );
  }
  return email;
}

export interface BookingOptions {
  now: number;
  timeZone: string;
}

// Books an interview from a call task without logging a call: for one set
// up another way (an email reply, a text). Keyed by task and start time, so a
// double-click books it once.
export async function runBooking(
  hs: HubSpot,
  calendar: Calendar,
  store: MeetingBookingStore,
  taskId: string,
  input: BookingInput,
  opts: BookingOptions
): Promise<{ meetingId: string; created: boolean; startAt: string; invited: boolean }> {
  const { startAt, endAt } = bookingTimes(input, opts.timeZone);
  const bookingId = `${taskId}@${Date.parse(startAt)}`;
  let row = await store.get(bookingId);
  if (!row) {
    bookingTimes(input, opts.timeZone, opts.now);
    const { task, contact, company } = await loadTask(hs, taskId, 'CALL');
    await store.create({
      booking_id: bookingId,
      task_id: taskId,
      contact_id: contact.id,
      company_id: company?.id ?? null,
      owner_id: task.properties.hubspot_owner_id || null,
      title: interviewTitle(companyName(company), contactName(contact)),
      start_at: startAt,
      end_at: endAt,
      join_url: input.joinUrl,
      phone: bookingPhone(contact, company, input.byPhone),
      invite: input.invite ? 1 : 0,
      invitee_email: inviteeEmail(contact, input.invite),
    });
    row = await store.get(bookingId);
    if (!row) throw new Error(`meeting_bookings row for ${bookingId} missing right after insert`);
  }
  const invited = Boolean(row.invite);
  if (row.meeting_id) return { meetingId: row.meeting_id, created: false, startAt: row.start_at, invited };

  if (!(await store.acquireLock(bookingId, Math.floor(opts.now / 1000), LOCK_TTL_SEC))) {
    throw new WorkflowError('This interview is already being booked. Refresh in a moment.', 409);
  }
  try {
    row = (await store.get(bookingId)) ?? row;
    let joinUrl = row.join_url;
    if (row.invite && row.invitee_email && !row.calendar_event_id) {
      const sent = await sendInvite(calendar, bookingId, {
        title: row.title,
        startAt: row.start_at,
        endAt: row.end_at,
        joinUrl,
        phone: row.phone,
        attendeeEmail: row.invitee_email,
      });
      joinUrl = sent.joinUrl;
      await store.setCalendarEvent(bookingId, sent.eventId, joinUrl);
    }
    const result = await findOrCreateMeeting(
      hs,
      { contactId: row.contact_id, companyId: row.company_id },
      { title: row.title, startAt: row.start_at, endAt: row.end_at, joinUrl, phone: row.phone, ownerId: row.owner_id }
    );
    await store.setMeeting(bookingId, result.meetingId);
    return { ...result, startAt: row.start_at, invited };
  } finally {
    await store.releaseLock(bookingId);
  }
}

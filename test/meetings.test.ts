// Interviews (HubSpot meetings): listing them, logging how one went, and
// booking one from a call. Workflows run against the real SQL on SQLite
// (test/sqlite-d1.ts) and a fake HubSpot.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { inviteDescription, isTimeZone } from '../src/lib/app-settings.ts';
import { adjustNotes, ruleInsight, type CallFacts } from '../src/lib/call-insight.ts';
import { callTimeline } from '../src/lib/call-timeline.ts';
import { d1CallLogStore, d1DialStore, d1MeetingBookingStore, d1MeetingLogStore } from '../src/lib/db.ts';
import type { NewCall, Twilio } from '../src/lib/twilio.ts';
import type { AppEnv } from '../src/types.ts';
import { meetingPage } from '../src/views/meetings.ts';
import {
  bookingTimes,
  parseBookingForm,
  runBooking,
  type Calendar,
  type Invite,
} from '../src/workflows/book-interview.ts';
import { callLogDone, LAST_TRY, parseCallLogForm, runCallLogged } from '../src/workflows/call-logged.ts';
import { loadCallQueue, withInterviews } from '../src/workflows/call-queue.ts';
import { startDial, startMeetingDial } from '../src/workflows/dial.ts';
import {
  meetingLogDone,
  internalNotesHtml,
  meetingLogId,
  parseMeetingLogForm,
  runMeetingLogged,
  type MeetingLogInput,
} from '../src/workflows/meeting-logged.ts';
import {
  bucketMeetings,
  httpsUrl,
  loadMeeting,
  loadMeetings,
  sortContactMeetings,
  type MeetingRow,
} from '../src/workflows/meeting-queue.ts';
import { parseTaskBody } from '../src/lib/richtext.ts';
import { FakeHubSpot, hubspotApi } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const NOW = Date.parse('2026-09-25T15:00:00Z'); // 09:00 in Denver (MDT)
const TZ = 'America/Denver';
const OPTS = { now: NOW, timeZone: TZ };
const START = Date.parse('2026-09-25T14:00:00Z'); // 08:00 Denver, an hour ago

let db: D1Database;
let hs: FakeHubSpot;
let calendar: FakeCalendar;

// Like Google: the same key is one event, and only the first sends an invite.
class FakeCalendar implements Calendar {
  sent: Invite[] = [];
  events = new Map<string, string>(); // key -> event id
  fail: Error | null = null;
  async invite(invite: Invite) {
    if (this.fail) throw this.fail;
    let eventId = this.events.get(invite.key);
    if (!eventId) {
      eventId = `ev${this.events.size + 1}`;
      this.events.set(invite.key, eventId);
      this.sent.push(invite);
    }
    return { eventId, meetUrl: invite.joinUrl || invite.phone ? null : `https://meet.google.com/${eventId}` };
  }
  moved: { eventId: string; startAt: string; endAt: string }[] = [];
  canceled: string[] = [];
  async move(eventId: string, startAt: string, endAt: string) {
    if (this.fail) throw this.fail;
    this.moved.push({ eventId, startAt, endAt });
  }
  async cancel(eventId: string) {
    if (this.fail) throw this.fail;
    this.canceled.push(eventId);
  }
}

function putMeeting(id: string, start: string, end: string, extra: Record<string, string | null> = {}) {
  hs.put('meetings', id, {
    hs_meeting_title: `Interview ${id}`,
    hs_meeting_start_time: start,
    hs_meeting_end_time: end,
    hs_meeting_outcome: 'SCHEDULED',
    hubspot_owner_id: '77',
    ...extra,
  });
}

beforeEach(() => {
  db = sqliteD1();
  hs = new FakeHubSpot();
  calendar = new FakeCalendar();
  hs.put('contacts', '10', {
    firstname: 'Sam',
    lastname: 'Granger',
    email: 'sam@granger.test',
    phone: '(801) 555-0130',
    hs_lead_status: 'NEW',
  });
  hs.put('companies', '20', { name: 'Granger Hauling' });
  hs.put('contacts', '11', { firstname: 'Drew', lastname: 'Pollard' });
  // The interview that was an hour ago, still marked scheduled.
  putMeeting('m1', '2026-09-25T14:00:00Z', '2026-09-25T14:30:00Z', {
    hs_internal_meeting_notes: '<p>Prep: ask about hay loads.</p>',
    hs_meeting_external_url: 'https://meet.google.com/abc-defg-hij',
  });
  hs.link('meetings', 'm1', 'contacts', '10');
  hs.link('contacts', '10', 'meetings', 'm1');
  hs.link('meetings', 'm1', 'companies', '20');
  // A CALL task on the same contact, due today.
  hs.put('tasks', '1', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Call: Granger Hauling (follow up on VFWPA email)',
    hs_timestamp: '2026-09-25T16:00:00Z',
    hubspot_owner_id: '77',
  });
  hs.link('tasks', '1', 'contacts', '10');
  hs.link('tasks', '1', 'companies', '20');
});

// --- The list ---

test('interviews are sorted into needs-outcome, today, upcoming and recent', async () => {
  putMeeting('later', '2026-09-25T19:00:00Z', '2026-09-25T19:30:00Z'); // 13:00 today
  putMeeting('tomorrow', '2026-09-26T15:00:00Z', '2026-09-26T15:45:00Z', { hs_meeting_outcome: null });
  putMeeting('done', '2026-09-24T15:00:00Z', '2026-09-24T15:30:00Z', { hs_meeting_outcome: 'COMPLETED' });
  putMeeting('far', '2026-11-01T15:00:00Z', '2026-11-01T15:30:00Z');
  hs.link('meetings', 'later', 'contacts', '11');

  const rows = await loadMeetings(hs, NOW);
  assert.deepEqual(
    rows.map((r) => r.meetingId),
    ['done', 'm1', 'later', 'tomorrow'],
    'soonest first, out-of-window meetings left out'
  );
  const m1 = rows.find((r) => r.meetingId === 'm1')!;
  assert.equal(m1.contactName, 'Sam Granger');
  assert.equal(m1.companyName, 'Granger Hauling');
  assert.equal(m1.phone, '+18015550130');
  assert.equal(rows.find((r) => r.meetingId === 'tomorrow')!.outcome, 'SCHEDULED', 'no outcome means scheduled');

  const b = bucketMeetings(rows, NOW, TZ);
  assert.deepEqual(
    [b.needsOutcome, b.today, b.upcoming, b.recent].map((list) => list.map((r) => r.meetingId)),
    [['m1'], ['later'], ['tomorrow'], ['done']]
  );
});

test('a call whose contact has an interview coming up is marked with it', async () => {
  putMeeting('m2', '2026-09-26T17:00:00Z', '2026-09-26T17:30:00Z');
  hs.link('meetings', 'm2', 'contacts', '10');
  hs.put('meetings', 'm1', { ...hs.objects.get('meetings/m1')!.properties, hs_meeting_outcome: 'COMPLETED' });
  hs.put('tasks', '2', { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED', hs_task_subject: 'other' });
  hs.link('tasks', '2', 'contacts', '11');

  const queue = withInterviews(await loadCallQueue(hs), await loadMeetings(hs, NOW), NOW, TZ);
  const byTask = new Map(queue.rows.map((r) => [r.taskId, r.interview]));
  assert.deepEqual(byTask.get('1'), { meetingId: 'm2', startAt: Date.parse('2026-09-26T17:00:00Z') }, 'the open one');
  assert.equal(byTask.get('2'), null);
});

test('only a plain https join link is used', () => {
  assert.equal(httpsUrl(' https://meet.google.com/abc '), 'https://meet.google.com/abc');
  assert.equal(httpsUrl('javascript:alert(1)'), null);
  assert.equal(httpsUrl('http://zoom.us/j/1'), null);
  assert.equal(httpsUrl(null), null);
});

// --- Logging an interview ---

const COMPLETED: MeetingLogInput = {
  outcome: 'COMPLETED',
  notes: 'Quotes by phone, then retyped into QuickBooks.',
  newStart: null,
  next: { type: 'EMAIL', date: '2026-09-26' },
};

test('logging an interview sets its outcome and notes, creates the follow-up, and moves Lead Status', async () => {
  const store = d1MeetingLogStore(db);
  const result = await runMeetingLogged(hs, store, 'm1', START, COMPLETED, OPTS);

  const m = hs.objects.get('meetings/m1')!.properties;
  assert.equal(m.hs_meeting_outcome, 'COMPLETED');
  assert.equal(
    m.hs_internal_meeting_notes,
    '<p>Prep: ask about hay loads.</p><p>Quotes by phone, then retyped into QuickBooks.</p>',
    'added after what was there'
  );
  assert.equal(m.hs_meeting_start_time, '2026-09-25T14:00:00Z', 'the time is left alone');
  assert.equal(hs.created.length, 1);
  assert.deepEqual(hs.created[0].properties, {
    hs_task_type: 'EMAIL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Email: Granger Hauling (Sam Granger) — follow up on interview',
    hs_timestamp: '2026-09-26T15:00:00.000Z', // 09:00 Denver
    hubspot_owner_id: '77',
  });
  assert.deepEqual(hs.created[0].links, { contactId: '10', companyId: '20' });
  assert.equal(hs.objects.get('contacts/10')!.properties.hs_lead_status, 'CONNECTED');
  assert.deepEqual(result, {
    outcome: 'COMPLETED',
    newStartAt: null,
    nextTaskId: '900',
    nextTaskCreated: true,
    leadStatus: 'CONNECTED',
    inviteUpdated: false,
    contactId: '10',
    who: 'Sam Granger at Granger Hauling',
  });

  // A second submission, even with different values, writes nothing more.
  const again = await runMeetingLogged(hs, store, 'm1', START, { ...COMPLETED, notes: 'other' }, OPTS);
  assert.equal(hs.created.length, 1);
  assert.equal(again.nextTaskCreated, false);
  assert.equal(again.who, null, 'not read again');
  assert.match(hs.objects.get('meetings/m1')!.properties.hs_internal_meeting_notes!, /QuickBooks/);
});

test('a log that failed partway resumes where it stopped', async () => {
  const store = d1MeetingLogStore(db);
  hs.failNextCreate = true;
  await assert.rejects(runMeetingLogged(hs, store, 'm1', START, COMPLETED, OPTS), /HubSpot 500/);
  const row = (await store.get(meetingLogId('m1', START)))!;
  assert.ok(row.outcome_at, 'step 1 landed');
  assert.equal(row.next_task_id, null);
  assert.equal(meetingLogDone(row), false);

  // HubSpot now shows it completed, but the unfinished row still lets the retry through.
  const result = await runMeetingLogged(hs, store, 'm1', START, COMPLETED, OPTS);
  assert.equal(hs.created.length, 1);
  assert.equal(result.nextTaskCreated, true);
  assert.equal(meetingLogDone((await store.get(meetingLogId('m1', START)))!), true);
});

test('a no-show leaves Lead Status alone', async () => {
  await runMeetingLogged(
    hs,
    d1MeetingLogStore(db),
    'm1',
    START,
    { outcome: 'NO_SHOW', notes: '', newStart: null, next: { type: 'CALL', date: '2026-09-26' } },
    OPTS
  );
  assert.equal(hs.objects.get('meetings/m1')!.properties.hs_meeting_outcome, 'NO_SHOW');
  assert.equal(hs.objects.get('contacts/10')!.properties.hs_lead_status, 'NEW');
  assert.equal(
    hs.objects.get('meetings/m1')!.properties.hs_internal_meeting_notes,
    '<p>Prep: ask about hay loads.</p>'
  );
});

test('rescheduling moves the interview and keeps its length, and it can be logged again at the new time', async () => {
  const store = d1MeetingLogStore(db);
  const result = await runMeetingLogged(
    hs,
    store,
    'm1',
    START,
    { outcome: 'RESCHEDULED', notes: '', newStart: { date: '2026-09-29', time: { hour: 14, minute: 0 } }, next: null },
    OPTS
  );
  const m = hs.objects.get('meetings/m1')!.properties;
  assert.equal(m.hs_meeting_outcome, 'RESCHEDULED');
  assert.equal(m.hs_meeting_start_time, '2026-09-29T20:00:00.000Z'); // 14:00 Denver
  assert.equal(m.hs_meeting_end_time, '2026-09-29T20:30:00.000Z');
  assert.equal(result.newStartAt, Date.parse('2026-09-29T20:00:00Z'));

  const rows = await loadMeetings(hs, Date.parse('2026-09-29T21:00:00Z'));
  assert.equal(
    bucketMeetings(rows, Date.parse('2026-09-29T21:00:00Z'), TZ).needsOutcome[0]?.meetingId,
    'm1',
    'still open'
  );

  const newStart = Date.parse('2026-09-29T20:00:00Z');
  await runMeetingLogged(hs, store, 'm1', newStart, { ...COMPLETED, next: null }, OPTS);
  assert.equal(hs.objects.get('meetings/m1')!.properties.hs_meeting_outcome, 'COMPLETED');
});

test('refuses a stale page and a meeting that already has an outcome', async () => {
  const store = d1MeetingLogStore(db);
  await assert.rejects(runMeetingLogged(hs, store, 'm1', START - 60_000, COMPLETED, OPTS), /time changed/);
  hs.objects.get('meetings/m1')!.properties.hs_meeting_outcome = 'CANCELED';
  await assert.rejects(runMeetingLogged(hs, store, 'm1', START, COMPLETED, OPTS), /already has an outcome/);
  assert.equal(hs.created.length, 0);
});

test('parseMeetingLogForm checks the outcome, the new time and the follow-up', () => {
  const today = '2026-09-25';
  assert.deepEqual(parseMeetingLogForm({ outcome: 'COMPLETED', notes: 'a\r\nb', next_type: '' }, today), {
    outcome: 'COMPLETED',
    canceledBy: null,
    notes: 'a\nb',
    newStart: null,
    next: null,
  });
  assert.deepEqual(
    parseMeetingLogForm({ outcome: 'RESCHEDULED', new_date: '2026-09-29', new_time: '14:05' }, today).newStart,
    { date: '2026-09-29', time: { hour: 14, minute: 5 } }
  );
  assert.throws(() => parseMeetingLogForm({ outcome: 'SCHEDULED' }, today), /Pick how/);
  assert.equal(parseMeetingLogForm({ outcome: 'CANCELED', canceled_by: 'rep' }, today).canceledBy, 'rep');
  assert.equal(parseMeetingLogForm({ outcome: 'CANCELED' }, today).canceledBy, 'them', 'theirs unless said');
  assert.equal(parseMeetingLogForm({ outcome: 'COMPLETED', canceled_by: 'rep' }, today).canceledBy, null);
  assert.throws(() => parseMeetingLogForm({ outcome: 'CANCELED', canceled_by: 'boss' }, today), /who canceled/);
  assert.throws(() => parseMeetingLogForm({ outcome: 'RESCHEDULED', new_date: '2026-09-29' }, today), /new date/);
  assert.throws(
    () => parseMeetingLogForm({ outcome: 'RESCHEDULED', new_date: '2026-09-24', new_time: '10:00' }, today),
    /past/
  );
  assert.throws(
    () => parseMeetingLogForm({ outcome: 'COMPLETED', next_type: 'CALL', next_date: '2026-09-24' }, today),
    /past/
  );
});

// --- Booking an interview ---

test('booking from a call task creates one meeting, however many times it is submitted', async () => {
  const store = d1MeetingBookingStore(db);
  const input = parseBookingForm(
    { book_date: '2026-09-28', book_time: '10:30', book_minutes: '45', book_join_url: 'https://meet.google.com/x' },
    '2026-09-25'
  );
  const first = await runBooking(hs, calendar, store, '1', input, OPTS);
  const again = await runBooking(hs, calendar, store, '1', input, OPTS);
  assert.equal(hs.meetings.length, 1);
  assert.deepEqual(hs.meetings[0], {
    meeting: {
      title: 'Interview: Granger Hauling (Sam Granger)',
      bodyHtml: '<p>Discovery interview, booked from Causeway.</p>',
      startAt: '2026-09-28T16:30:00.000Z', // 10:30 Denver
      endAt: '2026-09-28T17:15:00.000Z',
      joinUrl: 'https://meet.google.com/x',
      location: null,
      ownerId: '77',
    },
    links: { contactId: '10', companyId: '20' },
  });
  assert.deepEqual([first.created, again.created], [true, false]);
  assert.equal(again.meetingId, first.meetingId);
  assert.equal(hs.objects.get('tasks/1')!.properties.hs_task_status, 'NOT_STARTED', 'the call task stays open');
  const { meeting } = await loadMeeting(hs, first.meetingId);
  assert.equal(meeting.properties.hs_meeting_outcome, 'SCHEDULED');
});

test("an interview booked in their time zone is saved in the rep's", async () => {
  // 10:30 in New York (EDT) is 08:30 in Denver.
  const input = parseBookingForm(
    { book_date: '2026-09-28', book_time: '10:30', book_time_tz: 'America/New_York', book_format: 'phone' },
    '2026-09-25'
  );
  assert.equal(bookingTimes(input, TZ).startAt, '2026-09-28T14:30:00.000Z');
  // At 00:10 in Denver it's 23:10 in Los Angeles: 11:30pm there is on the rep's yesterday, and still ahead.
  const late = parseBookingForm(
    { book_date: '2026-09-25', book_time: '11:30pm', book_time_tz: 'America/Los_Angeles' },
    '2026-09-26'
  );
  assert.equal(bookingTimes(late, TZ, Date.parse('2026-09-26T06:10:00Z')).startAt, '2026-09-26T06:30:00.000Z');
  // Rescheduled the same way.
  const moved = parseMeetingLogForm(
    { outcome: 'RESCHEDULED', new_date: '2026-09-29', new_time: '1pm', new_time_tz: 'America/Los_Angeles' },
    '2026-09-25'
  );
  assert.deepEqual(moved.newStart, {
    date: '2026-09-29',
    time: { hour: 13, minute: 0, timeZone: 'America/Los_Angeles' },
  });
});

test('a booking whose result was lost reuses the meeting HubSpot created', async () => {
  const input = parseBookingForm({ book_date: '2026-09-28', book_time: '10:30' }, '2026-09-25');
  await hs.createMeeting(
    {
      title: 'Interview: Granger Hauling (Sam Granger)',
      bodyHtml: '',
      startAt: '2026-09-28T16:30:00.000Z',
      endAt: '2026-09-28T17:00:00.000Z',
      joinUrl: null,
      ownerId: null,
    },
    { contactId: '10', companyId: '20' }
  );
  const result = await runBooking(hs, calendar, d1MeetingBookingStore(db), '1', input, OPTS);
  assert.equal(hs.meetings.length, 1);
  assert.deepEqual([result.meetingId, result.created], ['meeting-1', false]);
});

test('parseBookingForm checks the time and the join link', () => {
  const today = '2026-09-25';
  assert.throws(() => parseBookingForm({ book_date: '2026-09-28' }, today), /date and time/);
  assert.throws(() => parseBookingForm({ book_date: '2026-09-24', book_time: '10:00' }, today), /past/);
  assert.throws(
    () => parseBookingForm({ book_date: '2026-09-28', book_time: '10:00', book_join_url: 'javascript:x' }, today),
    /https/
  );
  assert.equal(parseBookingForm({ book_date: '2026-09-28', book_time: '10:00', book_minutes: '7' }, today).minutes, 30);
});

test('logging a connected call can book the interview, once, even after a failure', async () => {
  const store = d1CallLogStore(db);
  const form = parseCallLogForm(
    { outcome: 'connected', next_type: '', book: '1', book_date: '2026-09-28', book_time: '09:00' },
    '2026-09-25'
  );
  assert.throws(
    () =>
      parseCallLogForm({ outcome: 'no_answer', book: '1', book_date: '2026-09-28', book_time: '09:00' }, '2026-09-25'),
    /connected/
  );

  hs.failNextCreateMeeting = new Error('HubSpot 502');
  const input = { ...form, dial: null, transcript: null };
  const opts = { ...OPTS, baseUrl: 'https://app.test', calendar };
  await assert.rejects(runCallLogged(hs, store, '1', input, opts), /HubSpot 502/);
  assert.equal(callLogDone((await store.get('1'))!), false, 'the call page keeps the form to finish it');
  assert.equal(hs.calls.length, 1);

  const result = await runCallLogged(hs, store, '1', input, opts);
  assert.equal(hs.calls.length, 1, 'the call is logged once');
  assert.equal(hs.meetings.length, 1);
  assert.equal(result.bookedMeetingId, 'meeting-1');
  assert.equal(hs.meetings[0].meeting.startAt, '2026-09-28T15:00:00.000Z');
  assert.equal(hs.meetings[0].meeting.title, 'Interview: Granger Hauling (Sam Granger)');
  assert.equal(callLogDone((await store.get('1'))!), true);
});

// --- The prep page ---

const EMPTY_SECTION = { items: [], failed: false, missingScopes: [] };

const SETUP = {
  twilioReady: true,
  browserReady: false,
  callWith: 'phone' as const,
  fromNumber: '+13852557051',
  repPhone: '+18085550199',
  whatsappOpens: 'app' as const,
  fromName: 'Anel Canto',
};

test('the prep page shows what coaching read from the call made from it', async () => {
  const facts: CallFacts = {
    label: 'Ana Díaz at Acme',
    firstName: 'Ana',
    outcome: 'connected',
    channel: 'phone',
    durationSec: 600,
    notes: 'She walked me through last week’s quote.',
    transcript: null,
    setTime: false,
    booked: false,
  };
  const reading = ruleInsight(facts);
  const read = { ...reading, duration_sec: 600, label: facts.label };
  const page = String(
    await meetingPage(
      {
        parties: await loadMeeting(hs, 'm1'),
        context: { notes: EMPTY_SECTION, calls: EMPTY_SECTION, emails: EMPTY_SECTION },
        lastEmail: null,
        log: null,
        booked: false,
        dial: null,
        dialState: null,
        recordingState: null,
        coaching: {
          label: facts.label,
          outcome: 'connected',
          read,
          unsure: [],
          sources: {},
          notes: adjustNotes(read),
          feedbackBy: { whatWorked: null, adjust: null },
          timeline: callTimeline(facts, reading),
        },
        setup: SETUP,
        portalId: '1',
        now: NOW,
        timeZone: TZ,
      },
      'rep@example.com'
    )
  );
  assert.match(page, /After the call with Ana Díaz at Acme/);
  assert.match(page, /<div class="strip" aria-hidden="true"/, 'the interview drawn to scale');
  assert.match(page, /Long connect \(10:00\)/);
});

test('the prep page shows the join link, the questions and the log form', async () => {
  const parties = await loadMeeting(hs, 'm1');
  const page = String(
    await meetingPage(
      {
        parties,
        context: {
          notes: {
            items: [
              {
                kind: 'note',
                id: 'n1',
                at: NOW - 86_400_000,
                title: 'Note',
                detail: null,
                text: 'Owner. Main line verified.',
                fullText: null,
              },
            ],
            failed: false,
            missingScopes: [],
          },
          calls: EMPTY_SECTION,
          emails: EMPTY_SECTION,
        },
        lastEmail: null,
        log: null,
        booked: false,
        dial: null,
        dialState: null,
        recordingState: null,
        coaching: null,
        setup: SETUP,
        portalId: '1',
        now: NOW,
        timeZone: TZ,
      },
      'rep@example.com'
    )
  );
  assert.match(page, /href="https:\/\/meet\.google\.com\/abc-defg-hij"/);
  assert.match(page, /Walk me through the last load you quoted/);
  assert.match(page, /Main line verified/);
  assert.match(page, /action="\/meetings\/m1\/log"/);
  assert.match(page, new RegExp(`name="start" value="${START}"`));
  assert.match(page, /action="\/meetings\/m1\/dial"/, 'the contact can be called from here');

  hs.objects.get('meetings/m1')!.properties.hs_meeting_outcome = 'COMPLETED';
  hs.objects.get('meetings/m1')!.properties.hs_meeting_external_url = 'javascript:alert(1)';
  const done = String(
    await meetingPage(
      {
        parties: await loadMeeting(hs, 'm1'),
        context: { notes: EMPTY_SECTION, calls: EMPTY_SECTION, emails: EMPTY_SECTION },
        lastEmail: null,
        log: null,
        booked: false,
        dial: null,
        dialState: null,
        recordingState: null,
        coaching: null,
        setup: SETUP,
        portalId: '1',
        now: NOW,
        timeZone: TZ,
      },
      'rep@example.com'
    )
  );
  assert.doesNotMatch(done, /action="\/meetings\/m1\/log"/);
  assert.doesNotMatch(done, /javascript:/);
  assert.doesNotMatch(done, /\/dial"/, 'no calling once it has an outcome');
});

test('the time zone setting only takes real zones', () => {
  assert.equal(isTimeZone('America/Denver'), true);
  assert.equal(isTimeZone('UTC'), true);
  assert.equal(isTimeZone('Mars/Olympus'), false);
  assert.equal(isTimeZone(''), false);
});

// --- Calling from an interview ---

class FakeTwilio implements Twilio {
  calls: NewCall[] = [];
  async listNumbers() {
    return { voice: [], verified: [] };
  }
  async recording() {
    return new Response('mp3');
  }
  async startRecording() {
    return { sid: 'RE1' };
  }
  async createCall(call: NewCall) {
    this.calls.push(call);
    return { sid: `CA${this.calls.length}` };
  }
}

const DIAL_OPTS = {
  now: NOW,
  baseUrl: 'https://app.test',
  fromNumber: '+13852557051',
  mode: 'phone' as const,
  repNumber: '+18085550199',
  record: false,
  newId: () => 'd'.repeat(32),
};

test('an interview dials its contact the same way a call task does, with the number from HubSpot', async () => {
  const twilio = new FakeTwilio();
  const dials = d1DialStore(db);
  const dial = await startMeetingDial({ hs, twilio, dials }, 'm1', 'phone', DIAL_OPTS);
  assert.equal(dial.subject, 'meeting');
  assert.equal(dial.task_id, 'm1');
  assert.equal(dial.to_number, '+18015550130');
  assert.equal(dial.contact_label, 'Sam Granger at Granger Hauling');
  assert.equal(twilio.calls.length, 1, 'the rep’s phone rings first');
  assert.equal(twilio.calls[0].to, '+18085550199');
  assert.equal((await dials.latestForTask('m1'))?.id, dial.id);

  await assert.rejects(
    startMeetingDial({ hs, twilio, dials }, 'm1', 'phone', { ...DIAL_OPTS, newId: () => 'e'.repeat(32) }),
    /already ringing/
  );
  // A call task's dial is still a task dial.
  const taskDial = await startDial({ hs, twilio, dials }, '1', 'phone', { ...DIAL_OPTS, newId: () => 'f'.repeat(32) });
  assert.equal(taskDial.subject, 'task');
});

test('an interview that already has an outcome is not dialled', async () => {
  hs.objects.get('meetings/m1')!.properties.hs_meeting_outcome = 'COMPLETED';
  const twilio = new FakeTwilio();
  await assert.rejects(
    startMeetingDial({ hs, twilio, dials: d1DialStore(db) }, 'm1', 'phone', DIAL_OPTS),
    /already has an outcome/
  );
  assert.equal(twilio.calls.length, 0);
});

test('a finished call transcript goes into the interview notes when it is logged', async () => {
  const transcript = {
    turns: [
      { speaker: 'rep' as const, text: 'How do you quote hay loads?' },
      { speaker: 'prospect' as const, text: 'By phone, mostly <from memory>.' },
    ],
    summary: ['Quotes by phone.'],
  };
  await runMeetingLogged(hs, d1MeetingLogStore(db), 'm1', START, { ...COMPLETED, next: null, transcript }, OPTS);
  const notes = hs.objects.get('meetings/m1')!.properties.hs_internal_meeting_notes!;
  assert.ok(notes.startsWith('<p>Prep: ask about hay loads.</p><p>Quotes by phone, then retyped'), notes);
  assert.match(notes, /<li>Quotes by phone\.<\/li>/);
  assert.match(notes, /&lt;from memory&gt;/, 'escaped');
  assert.equal(internalNotesHtml(null, '  '), '');
});

// --- Calendar invites ---

test('a booking can send one calendar invite, and the meeting gets its Meet link', async () => {
  const store = d1MeetingBookingStore(db);
  const input = parseBookingForm({ book_date: '2026-09-28', book_time: '10:30', book_invite: '1' }, '2026-09-25');
  calendar.fail = new Error('Google 503');
  await assert.rejects(runBooking(hs, calendar, store, '1', input, OPTS), /Google 503/);
  assert.equal(hs.meetings.length, 0, 'nothing in HubSpot until the invite is out');
  calendar.fail = null;

  const first = await runBooking(hs, calendar, store, '1', input, OPTS);
  await runBooking(hs, calendar, store, '1', input, OPTS);
  assert.equal(calendar.sent.length, 1);
  assert.deepEqual(calendar.sent[0], {
    key: `1@${Date.parse('2026-09-28T16:30:00Z')}`,
    withWhom: 'Granger Hauling (Sam Granger)',
    attendeeEmail: 'sam@granger.test',
    startAt: '2026-09-28T16:30:00.000Z',
    endAt: '2026-09-28T17:00:00.000Z',
    joinUrl: null,
    phone: null,
  });
  assert.equal(first.invited, true);
  assert.equal(hs.meetings.length, 1);
  assert.equal(hs.meetings[0].meeting.joinUrl, 'https://meet.google.com/ev1');
});

test('a booking whose HubSpot step failed after the invite went out does not invite twice', async () => {
  const store = d1MeetingBookingStore(db);
  const input = parseBookingForm(
    { book_date: '2026-09-28', book_time: '10:30', book_invite: '1', book_join_url: 'https://zoom.us/j/1' },
    '2026-09-25'
  );
  hs.failNextCreateMeeting = new Error('HubSpot 502');
  await assert.rejects(runBooking(hs, calendar, store, '1', input, OPTS), /HubSpot 502/);
  const result = await runBooking(hs, calendar, store, '1', input, OPTS);
  assert.equal(calendar.sent.length, 1);
  assert.equal(calendar.sent[0].joinUrl, 'https://zoom.us/j/1', 'the rep’s own link, no Meet');
  assert.equal(hs.meetings[0].meeting.joinUrl, 'https://zoom.us/j/1');
  assert.equal(result.created, true);
});

test('an invite needs the contact’s email', async () => {
  hs.objects.get('contacts/10')!.properties.email = null;
  const input = parseBookingForm({ book_date: '2026-09-28', book_time: '10:30', book_invite: '1' }, '2026-09-25');
  await assert.rejects(runBooking(hs, calendar, d1MeetingBookingStore(db), '1', input, OPTS), /no email in HubSpot/);
  assert.equal(calendar.sent.length, 0);
});

test('logging a call that booked an interview can send its invite, once', async () => {
  const store = d1CallLogStore(db);
  const form = parseCallLogForm(
    { outcome: 'connected', next_type: '', book: '1', book_date: '2026-09-28', book_time: '09:00', book_invite: '1' },
    '2026-09-25'
  );
  const input = { ...form, dial: null, transcript: null };
  const opts = { ...OPTS, baseUrl: 'https://app.test', calendar };
  hs.failNextCreateMeeting = new Error('HubSpot 502');
  await assert.rejects(runCallLogged(hs, store, '1', input, opts), /HubSpot 502/);
  await runCallLogged(hs, store, '1', input, opts);
  assert.equal(calendar.sent.length, 1);
  assert.equal(calendar.sent[0].key, 'call:1');
  assert.equal(hs.meetings.length, 1);
  assert.equal(hs.meetings[0].meeting.joinUrl, 'https://meet.google.com/ev1');
});

// --- Review fixes: past times, resuming after a reschedule, invites follow the interview ---

test('an interview can’t be booked or moved to a time earlier today', async () => {
  const today = '2026-09-25'; // NOW is 09:00 Denver
  const early = parseBookingForm({ book_date: today, book_time: '08:30' }, today);
  await assert.rejects(runBooking(hs, calendar, d1MeetingBookingStore(db), '1', early, OPTS), /already passed/);
  const later = parseBookingForm({ book_date: today, book_time: '15:00' }, today);
  await runBooking(hs, calendar, d1MeetingBookingStore(db), '1', later, OPTS);
  assert.equal(hs.meetings.length, 1);

  const call = parseCallLogForm(
    { outcome: 'connected', next_type: '', book: '1', book_date: today, book_time: '08:00' },
    today
  );
  await assert.rejects(
    runCallLogged(
      hs,
      d1CallLogStore(db),
      '1',
      { ...call, dial: null, transcript: null },
      {
        ...OPTS,
        baseUrl: 'https://app.test',
        calendar,
      }
    ),
    /already passed/
  );
  assert.equal(hs.calls.length, 0, 'nothing logged');

  await assert.rejects(
    runMeetingLogged(
      hs,
      d1MeetingLogStore(db),
      'm1',
      START,
      { outcome: 'RESCHEDULED', notes: '', newStart: { date: today, time: { hour: 8, minute: 45 } }, next: null },
      OPTS
    ),
    /already passed/
  );
  assert.equal(hs.objects.get('meetings/m1')!.properties.hs_meeting_start_time, '2026-09-25T14:00:00Z');
});

test('a reschedule that stopped after moving the meeting resumes, not starts over', async () => {
  const store = d1MeetingLogStore(db);
  const moved: MeetingLogInput = {
    outcome: 'RESCHEDULED',
    notes: 'They asked for Tuesday.',
    newStart: { date: '2026-09-29', time: { hour: 14, minute: 0 } },
    next: { type: 'EMAIL', date: '2026-09-26' },
  };
  hs.failNextCreate = true;
  await assert.rejects(runMeetingLogged(hs, store, 'm1', START, moved, OPTS), /HubSpot 500/);
  const newStart = Date.parse('2026-09-29T20:00:00Z');
  assert.equal(hs.objects.get('meetings/m1')!.properties.hs_meeting_start_time, '2026-09-29T20:00:00.000Z');
  assert.equal((await store.unfinished('m1'))?.log_id, meetingLogId('m1', START), 'found by meeting');

  // The page now shows the new time, so that's what the form sends back.
  const result = await runMeetingLogged(hs, store, 'm1', newStart, { ...COMPLETED, next: null }, OPTS);
  assert.equal(result.outcome, 'RESCHEDULED', 'the first submission finished');
  assert.equal(hs.created.length, 1, 'its follow-up, once');
  assert.equal(await store.get(meetingLogId('m1', newStart)), null, 'no second log');
  assert.equal(await store.unfinished('m1'), null);
});

test('moving or canceling an invited interview moves or cancels the invite, once', async () => {
  const input = parseBookingForm({ book_date: '2026-09-28', book_time: '10:30', book_invite: '1' }, '2026-09-25');
  const { meetingId } = await runBooking(hs, calendar, d1MeetingBookingStore(db), '1', input, OPTS);
  const start = Date.parse('2026-09-28T16:30:00Z');
  const store = d1MeetingLogStore(db);
  const opts = { ...OPTS, calendar };

  calendar.fail = new Error('Google 503');
  const moved: MeetingLogInput = {
    outcome: 'RESCHEDULED',
    notes: '',
    newStart: { date: '2026-09-30', time: { hour: 11, minute: 0 } },
    next: null,
  };
  await assert.rejects(runMeetingLogged(hs, store, meetingId, start, moved, opts), /Google 503/);
  calendar.fail = null;
  const result = await runMeetingLogged(hs, store, meetingId, start, moved, opts);
  await runMeetingLogged(hs, store, meetingId, start, moved, opts);
  assert.deepEqual(calendar.moved, [
    { eventId: 'ev1', startAt: '2026-09-30T17:00:00.000Z', endAt: '2026-09-30T17:30:00.000Z' },
  ]);
  assert.equal(result.inviteUpdated, true);

  const newStart = Date.parse('2026-09-30T17:00:00Z');
  const canceled: MeetingLogInput = { outcome: 'CANCELED', notes: '', newStart: null, next: null };
  await runMeetingLogged(hs, store, meetingId, newStart, canceled, opts);
  await runMeetingLogged(hs, store, meetingId, newStart, canceled, opts);
  assert.deepEqual(calendar.canceled, ['ev1']);
  assert.equal(hs.objects.get(`meetings/${meetingId}`)!.properties.hs_meeting_outcome, 'CANCELED');
});

test('an interview without an app invite is moved without touching the calendar', async () => {
  await runMeetingLogged(
    hs,
    d1MeetingLogStore(db),
    'm1',
    START,
    { outcome: 'CANCELED', notes: '', newStart: null, next: null },
    { ...OPTS, calendar }
  );
  assert.deepEqual([calendar.moved, calendar.canceled], [[], []]);
});

// --- Phone interviews ---

test('a phone interview gets no Meet link: the meeting and invite say the rep calls them', async () => {
  const store = d1MeetingBookingStore(db);
  const input = parseBookingForm(
    {
      book_date: '2026-09-28',
      book_time: '09:00',
      book_format: 'phone',
      book_invite: '1',
      book_join_url: 'https://meet.google.com/ignored',
    },
    '2026-09-25'
  );
  assert.equal(input.byPhone, true);
  assert.equal(input.joinUrl, null, 'a phone interview has no join link');

  await runBooking(hs, calendar, store, '1', input, OPTS);
  await runBooking(hs, calendar, store, '1', input, OPTS);
  assert.equal(calendar.sent.length, 1, 'one invite');
  assert.equal(calendar.sent[0].phone, '+18015550130');
  assert.equal(calendar.sent[0].joinUrl, null);
  assert.equal(hs.meetings.length, 1, 'one meeting');
  const { meeting } = hs.meetings[0];
  assert.equal(meeting.joinUrl, null, 'no Meet link from the invite');
  assert.equal(meeting.location, 'Phone: +1 801-555-0130');
  assert.match(meeting.bodyHtml, /Phone interview: you call them at \+1 801-555-0130/);

  const [row] = await loadMeetings(hs, NOW).then((rows) => rows.filter((r) => r.title.startsWith('Interview:')));
  assert.equal(row.phoneCall, true);
  assert.equal(row.joinUrl, null);
});

test('the invite tells the contact the number the rep will call', () => {
  assert.equal(
    inviteDescription({ joinUrl: null, phone: '+18015550130' }),
    "Thanks for making the time to talk. I'll call you at +1 801-555-0130. If another number's better, just reply and let me know."
  );
  assert.match(inviteDescription({ joinUrl: null, phone: null }), /Google Meet link is on this invite/);
  assert.match(
    inviteDescription({ joinUrl: 'https://zoom.us/j/1', phone: null }),
    /Join here: https:\/\/zoom\.us\/j\/1/
  );
});

test('a phone interview needs a number in HubSpot', async () => {
  hs.objects.get('contacts/10')!.properties.phone = null;
  const input = parseBookingForm({ book_date: '2026-09-28', book_time: '09:00', book_format: 'phone' }, '2026-09-25');
  await assert.rejects(
    runBooking(hs, calendar, d1MeetingBookingStore(db), '1', input, OPTS),
    /no phone number in HubSpot/
  );
  assert.equal(hs.meetings.length, 0);
});

test('logging a call that booked a phone interview books it as a phone call, once', async () => {
  const store = d1CallLogStore(db);
  const form = parseCallLogForm(
    {
      outcome: 'connected',
      next_type: '',
      book: '1',
      book_date: '2026-09-28',
      book_time: '09:00',
      book_format: 'phone',
      book_invite: '1',
    },
    '2026-09-25'
  );
  const input = { ...form, dial: null, transcript: null };
  const opts = { ...OPTS, baseUrl: 'https://app.test', calendar };
  hs.failNextCreateMeeting = new Error('HubSpot 502');
  await assert.rejects(runCallLogged(hs, store, '1', input, opts), /HubSpot 502/);
  await runCallLogged(hs, store, '1', input, opts);
  assert.equal(calendar.sent.length, 1);
  assert.equal(calendar.sent[0].phone, '+18015550130');
  assert.equal(hs.meetings.length, 1);
  assert.equal(hs.meetings[0].meeting.joinUrl, null);
  assert.equal(hs.meetings[0].meeting.location, 'Phone: +1 801-555-0130');
});

test('a phone interview’s page leads with calling them, not Join', async () => {
  hs.put('meetings', 'm1', {
    ...hs.objects.get('meetings/m1')!.properties,
    hs_meeting_external_url: null,
    hs_meeting_location: 'Phone: +1 801-555-0130',
  });
  const page = String(
    await meetingPage(
      {
        parties: await loadMeeting(hs, 'm1'),
        context: { notes: EMPTY_SECTION, calls: EMPTY_SECTION, emails: EMPTY_SECTION },
        lastEmail: null,
        log: null,
        booked: false,
        dial: null,
        dialState: null,
        recordingState: null,
        coaching: null,
        setup: SETUP,
        portalId: '1',
        now: NOW,
        timeZone: TZ,
      },
      'rep@example.com'
    )
  );
  assert.doesNotMatch(page, />Join</);
  assert.match(page, /Phone call · you call them/);
  const call = page.indexOf('Call them: it’s a phone interview');
  assert.ok(call > 0 && call < page.indexOf('Walk me through the last load you quoted'), 'calling comes first');
});

// --- The no-show cadence ---

test('a no-show with an email follow-up creates the task with its draft written, once', async () => {
  const store = d1MeetingLogStore(db);
  const input: MeetingLogInput = {
    outcome: 'NO_SHOW',
    notes: '',
    newStart: null,
    next: { type: 'EMAIL', date: '2026-09-25' },
  };
  hs.failNextCreate = true;
  await assert.rejects(runMeetingLogged(hs, store, 'm1', START, input, OPTS), /HubSpot 500/);
  await runMeetingLogged(hs, store, 'm1', START, input, OPTS);
  assert.equal(hs.created.length, 1);
  const task = hs.created[0].properties;
  assert.equal(task.hs_task_subject, 'Email: Granger Hauling (Sam Granger) — missed interview');
  assert.equal(task.hs_timestamp, '2026-09-25T15:00:00.000Z', 'today at 09:00 Denver');
  const draft = parseTaskBody(task.hs_task_body!)!;
  assert.equal(draft.subject, 'sorry we missed each other');
  assert.match(draft.body, /^Hi Sam,\n\nI think we missed each other today\./);
  assert.match(draft.body, /happy to just give you a call instead/i, 'a video interview offers a call instead');
  assert.match(draft.body, /3 quick questions by email/);
  assert.equal(hs.objects.get('contacts/10')!.properties.hs_lead_status, 'NEW');
});

test('canceled by them: the email follow-up comes drafted, and who canceled is kept in D1', async () => {
  const store = d1MeetingLogStore(db);
  await runMeetingLogged(
    hs,
    store,
    'm1',
    START,
    {
      outcome: 'CANCELED',
      canceledBy: 'them',
      notes: 'Texted that a truck broke down',
      newStart: null,
      next: { type: 'EMAIL', date: '2026-09-25' },
    },
    OPTS
  );
  assert.equal(hs.objects.get('meetings/m1')!.properties.hs_meeting_outcome, 'CANCELED');
  const task = hs.created[0].properties;
  assert.equal(task.hs_task_subject, 'Email: Granger Hauling (Sam Granger) — canceled interview');
  const draft = parseTaskBody(task.hs_task_body!)!;
  assert.equal(draft.subject, 'thanks for letting me know');
  assert.match(draft.body, /^Hi Sam,\n\nThanks for letting me know\./);
  const row = await db
    .prepare(`SELECT canceled_by FROM meeting_logs WHERE meeting_id = 'm1'`)
    .first<{ canceled_by: string }>();
  assert.equal(row?.canceled_by, 'them');
});

test('canceled by the rep: a plain follow-up, no draft', async () => {
  await runMeetingLogged(
    hs,
    d1MeetingLogStore(db),
    'm1',
    START,
    { outcome: 'CANCELED', canceledBy: 'rep', notes: '', newStart: null, next: { type: 'EMAIL', date: '2026-09-25' } },
    OPTS
  );
  const task = hs.created[0].properties;
  assert.equal(task.hs_task_subject, 'Email: Granger Hauling (Sam Granger) — follow up on interview');
  assert.ok(!task.hs_task_body, 'no template for the rep’s own cancel');
});

test('the log form keeps who canceled: the page posts canceled_by through to D1', async () => {
  const { default: app } = await import('../src/index.ts');
  const background: Promise<unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = hubspotApi(hs) as unknown as typeof fetch;
  try {
    const res = await app.request(
      'http://localhost/meetings/m1/log',
      {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          outcome: 'CANCELED',
          canceled_by: 'rep',
          notes: '',
          start: '2026-09-25T14:00:00Z',
        }),
      },
      {
        DB: db,
        DEV_BYPASS_ACCESS: 'true',
        TZ,
        HUBSPOT_ACCESS_TOKEN: 'hs',
        PUBLIC_BASE_URL: 'http://localhost',
      } as unknown as AppEnv['Bindings'],
      {
        waitUntil: (p: Promise<unknown>) => background.push(p),
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext
    );
    await Promise.all(background.splice(0));
    assert.equal(res.status, 303);
  } finally {
    globalThis.fetch = realFetch;
  }
  const row = await db
    .prepare(`SELECT canceled_by FROM meeting_logs WHERE meeting_id = 'm1'`)
    .first<{ canceled_by: string }>();
  assert.equal(row?.canceled_by, 'rep');
});

test('a no-show from a phone interview offers another time for the call', async () => {
  hs.put('meetings', 'm1', {
    ...hs.objects.get('meetings/m1')!.properties,
    hs_meeting_location: 'Phone: +1 801-555-0130',
  });
  await runMeetingLogged(
    hs,
    d1MeetingLogStore(db),
    'm1',
    START,
    { outcome: 'NO_SHOW', notes: '', newStart: null, next: { type: 'EMAIL', date: '2026-09-25' } },
    OPTS
  );
  const draft = parseTaskBody(hs.created[0].properties.hs_task_body!)!;
  assert.match(draft.body, /I can just give you a call, so tell me a time/);
});

test('the last-try email after a call that got nowhere comes drafted', async () => {
  const form = parseCallLogForm({ outcome: 'no_answer', next_type: LAST_TRY, next_date: '2026-09-28' }, '2026-09-25');
  assert.deepEqual(form.next, { type: 'EMAIL', date: '2026-09-28', lastTry: true });
  await runCallLogged(
    hs,
    d1CallLogStore(db),
    '1',
    { ...form, dial: null, transcript: null },
    { ...OPTS, baseUrl: 'https://app.test' }
  );
  const task = hs.created.find((t) => t.properties.hs_task_type === 'EMAIL')!.properties;
  assert.equal(task.hs_task_subject, 'Email: Granger Hauling (Sam Granger) — close the loop');
  const draft = parseTaskBody(task.hs_task_body!)!;
  assert.equal(draft.subject, 'closing the loop');
  assert.match(draft.body, /^Hi Sam,\n\nI tried you a couple of times/);
});

test('the call page knows when the contact’s last interview was a no-show', () => {
  const row = (id: string, startAt: number, outcome: MeetingRow['outcome']): MeetingRow => ({
    meetingId: id,
    title: id,
    startAt,
    endAt: startAt + 1_800_000,
    outcome,
    joinUrl: null,
    contactId: '10',
    contactName: null,
    companyName: null,
    phoneCall: false,
    phone: null,
  });
  const missed = row('missed', NOW - 86_400_000, 'NO_SHOW');
  assert.equal(sortContactMeetings([missed], NOW, TZ).missed?.meetingId, 'missed');
  const rebooked = row('rebooked', NOW + 86_400_000, 'SCHEDULED');
  assert.deepEqual(sortContactMeetings([rebooked, missed], NOW, TZ), { interviews: [rebooked], missed: null });
  const held = row('held', NOW - 3_600_000, 'COMPLETED');
  assert.equal(sortContactMeetings([missed, held], NOW, TZ).missed, null, 'a later interview happened');
});

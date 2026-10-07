// The counts at the top of the pages: emails sent, people called and
// interviews had today. The D1 half runs the real SQL on SQLite.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { d1CallLogStore, d1ConfirmationStore, d1DialStore, d1SentEmailStore, dayActivity } from '../src/lib/db.ts';
import { countInterviews, loadTodayCounts } from '../src/workflows/today.ts';
import { FakeHubSpot } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const TZ = 'America/Denver';
const NOW = Date.parse('2026-09-25T18:00:00Z'); // noon in Denver
const DAY_START = Date.parse('2026-09-25T06:00:00Z'); // midnight in Denver
const DAY_END = Date.parse('2026-09-26T06:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);

let db: D1Database;
beforeEach(() => {
  db = sqliteD1();
});

async function sendEmail(taskId: string, sentAt: string | null) {
  const store = d1SentEmailStore(db);
  await store.beginSend(
    {
      emailTaskId: taskId,
      contactId: `c${taskId}`,
      companyId: null,
      fromEmail: 'isthmusglobalholdings@gmail.com',
      toEmail: 'ana@acme.test',
      subject: 'Quick question',
      html: '<div>Hi</div>',
      openToken: taskId.padEnd(32, 'x'),
      links: [],
      trackOpens: false,
      trackClicks: false,
    },
    1000,
    60
  );
  if (sentAt) await store.markSent(taskId, `gmail-${taskId}`, sentAt);
  // The follow-up workflow runs after every Gmail send, too.
  await d1ConfirmationStore(db).create({ emailTaskId: taskId, contactId: `c${taskId}`, companyId: null });
}

async function markedSent(taskId: string, createdAt: string) {
  await d1ConfirmationStore(db).create({ emailTaskId: taskId, contactId: `c${taskId}`, companyId: null });
  await db
    .prepare('UPDATE sent_confirmations SET created_at = ? WHERE email_task_id = ?')
    .bind(createdAt, taskId)
    .run();
}

// `connectedMs`: when the rep pressed 1 (or the browser placed the call); null if never.
async function dial(
  id: string,
  contactId: string,
  startedMs: number,
  connectedMs: number | null,
  toNumber = '+15555550100'
) {
  const dials = d1DialStore(db);
  await dials.begin(
    {
      id,
      task_id: `t${id}`,
      contact_id: contactId,
      contact_label: 'Ana',
      to_number: toNumber,
      to_extension: null,
      from_number: '+13852557051',
      rep_number: '+15555550199',
      mode: 'phone',
      started_sec: sec(startedMs),
      record: 0,
      subject: 'task',
    },
    120
  );
  if (connectedMs !== null) await dials.markConnected(id, new Date(connectedMs).toISOString());
}

async function logCall(taskId: string, contactId: string, createdAt: string) {
  await d1CallLogStore(db).create({
    call_task_id: taskId,
    contact_id: contactId,
    company_id: null,
    owner_id: null,
    title: 'Call',
    channel: 'phone',
    outcome: 'NO_ANSWER',
    notes: '',
    twilio_status: null,
    duration_sec: null,
    from_number: null,
    to_number: null,
    dial_id: null,
    next_type: null,
    next_subject: null,
    next_due: null,
    next_set_time: 0,
    next_body: null,
    book_start: null,
    book_title: null,
    book_minutes: null,
    book_join_url: null,
    book_phone: null,
    book_invite: 0,
    book_invitee_email: null,
  });
  await db.prepare('UPDATE call_logs SET created_at = ? WHERE call_task_id = ?').bind(createdAt, taskId).run();
}

test('emails: Gmail sends and Mark sent today, each once, in the rep’s time zone', async () => {
  await sendEmail('1', '2026-09-25T15:00:00.000Z'); // 9am today
  await sendEmail('2', '2026-09-25T05:59:00.000Z'); // 11:59pm yesterday in Denver
  await sendEmail('3', null); // still sending: not known to have gone out
  await markedSent('4', '2026-09-25 20:00:00'); // marked sent by hand this afternoon
  await markedSent('5', '2026-09-24 20:00:00'); // yesterday
  const counts = await dayActivity(db, sec(DAY_START), sec(DAY_END));
  assert.equal(counts.emailsSent, 2);
});

test('people called: distinct contacts dialled or logged today', async () => {
  await dial('a', 'c1', NOW - 3_600_000, NOW - 3_590_000);
  await dial('b', 'c1', NOW - 60_000, NOW - 50_000); // the same person again
  await dial('c', 'c2', NOW - 120_000, null); // the rep never pressed 1: nobody was called
  await dial('d', 'c3', DAY_START - 120_000, DAY_START - 60_000); // yesterday
  await dial('e', 'c5', DAY_START - 30_000, DAY_START + 10_000); // rang before midnight, dialled after
  await dial('f', 'c6', DAY_END - 30_000, DAY_END + 10_000); // rang tonight, dialled tomorrow
  await logCall('t1', 'c1', '2026-09-25 17:00:00'); // logged the call above
  await logCall('t9', 'c4', '2026-09-25 16:00:00'); // called from their own phone, logged here
  const counts = await dayActivity(db, sec(DAY_START), sec(DAY_END));
  assert.equal(counts.peopleCalled, 3); // c1, c4 and c5
  const tomorrow = await dayActivity(db, sec(DAY_END), sec(DAY_END + 86_400_000));
  assert.equal(tomorrow.peopleCalled, 1); // c6
});

test('people called: call backs to callers not in HubSpot count once per number', async () => {
  await dial('a', '', NOW - 3_600_000, NOW - 3_590_000, '+13855550171');
  await dial('b', '', NOW - 60_000, NOW - 50_000, '+13855550172');
  await dial('c', '', NOW - 30_000, NOW - 20_000, '+13855550171'); // the same number again
  const counts = await dayActivity(db, sec(DAY_START), sec(DAY_END));
  assert.equal(counts.peopleCalled, 2);
});

test('interviews: completed today counts as had, scheduled ones as still open', () => {
  const bounds = { startMs: DAY_START, endMs: DAY_END };
  const counts = countInterviews(
    [
      { startAt: DAY_START + 3_600_000 * 9, outcome: 'COMPLETED' },
      { startAt: DAY_START + 3_600_000 * 10, outcome: 'NO_SHOW' },
      { startAt: DAY_START + 3_600_000 * 15, outcome: 'SCHEDULED' },
      { startAt: DAY_START - 3_600_000, outcome: 'COMPLETED' }, // yesterday
      { startAt: DAY_END, outcome: 'SCHEDULED' }, // tomorrow
      { startAt: null, outcome: 'COMPLETED' },
    ],
    bounds
  );
  assert.deepEqual(counts, { had: 1, open: 1 });
});

test('loadTodayCounts searches HubSpot for today’s meetings, and shows none when it can’t', async () => {
  const hs = new FakeHubSpot();
  hs.put('meetings', '500', { hs_meeting_start_time: '2026-09-25T15:00:00Z', hs_meeting_outcome: 'COMPLETED' });
  hs.put('meetings', '501', { hs_meeting_start_time: '2026-09-26T15:00:00Z', hs_meeting_outcome: 'COMPLETED' });
  const counts = await loadTodayCounts(db, hs, NOW, TZ);
  assert.deepEqual(counts, { emailsSent: 0, peopleCalled: 0, interviews: { had: 1, open: 0 } });

  hs.searchMeetings = async () => {
    throw new Error('HubSpot 403');
  };
  const failed = await loadTodayCounts(db, hs, NOW, TZ);
  assert.equal(failed.interviews, null);
});

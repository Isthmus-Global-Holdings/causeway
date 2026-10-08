import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { sameTimeOn } from '../src/lib/dates.ts';
import { d1TaskLocks, type CallLog, type TaskLocks } from '../src/lib/db.ts';
import { sqliteD1 } from './sqlite-d1.ts';
import { applyRecentChange, planCalls, planItems, type CallQueue, type CallRow } from '../src/workflows/call-queue.ts';
import { loadEmailQueue } from '../src/workflows/email-queue.ts';
import { dropCall, dropEmail, snoozeCall } from '../src/workflows/task-actions.ts';
import { FakeHubSpot, FakeSentStore, FakeStore } from './fakes.ts';

const NOW = Date.parse('2026-09-25T15:00:00Z'); // Fri 10:00 in Panama
const TZ = 'America/Panama';
const OPTS = { now: NOW, timeZone: TZ };
const NINE = { hour: 9, minute: 0 };

let hs: FakeHubSpot;
let sent: FakeSentStore;
let confirmations: FakeStore;
let locks: TaskLocks;

beforeEach(() => {
  hs = new FakeHubSpot();
  sent = new FakeSentStore();
  confirmations = new FakeStore();
  locks = d1TaskLocks(sqliteD1());
  // Due today at 14:30 Panama.
  hs.put('tasks', 'c1', { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED', hs_timestamp: '2026-09-25T19:30:00Z' });
  hs.put('tasks', 'c2', { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED', hs_timestamp: null });
  hs.put('tasks', 'e1', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED', hs_task_subject: 'Email: A' });
});

test('sameTimeOn keeps the local time of day, else uses the fallback', () => {
  const due = Date.parse('2026-09-25T19:30:00Z'); // 14:30 Panama
  assert.equal(new Date(sameTimeOn('2026-09-28', due, TZ, NINE)).toISOString(), '2026-09-28T19:30:00.000Z');
  assert.equal(new Date(sameTimeOn('2026-09-28', null, TZ, NINE)).toISOString(), '2026-09-28T14:00:00.000Z');
});

test('snoozeCall moves the due date and keeps the hour; a repeat writes the same value', async () => {
  const first = await snoozeCall(hs, 'c1', '2026-09-26', null, OPTS);
  const again = await snoozeCall(hs, 'c1', '2026-09-26', null, OPTS);
  assert.equal(first.dueAt, again.dueAt);
  assert.equal((await hs.getObject('tasks', 'c1')).properties.hs_timestamp, '2026-09-26T19:30:00.000Z');
});

test('snoozeCall puts an undated call at 09:00', async () => {
  await snoozeCall(hs, 'c2', '2026-09-28', null, OPTS);
  assert.equal((await hs.getObject('tasks', 'c2')).properties.hs_timestamp, '2026-09-28T14:00:00.000Z');
});

test('snoozeCall refuses today, bad dates, non-CALL and closed tasks', async () => {
  await assert.rejects(snoozeCall(hs, 'c1', '2026-09-25', null, OPTS), /after today/);
  await assert.rejects(snoozeCall(hs, 'c1', '2026-02-30', null, OPTS), /Pick a day/);
  await assert.rejects(snoozeCall(hs, 'e1', '2026-09-26', null, OPTS), /not CALL/);
  await hs.updateObject('tasks', 'c1', { hs_task_status: 'COMPLETED' });
  await assert.rejects(snoozeCall(hs, 'c1', '2026-09-26', null, OPTS), /no longer open/);
});

test('snoozeCall at a time makes a set-time call, later today if need be, with its reminder', async () => {
  const { dueAt } = await snoozeCall(hs, 'c2', '2026-09-25', { hour: 14, minute: 30 }, OPTS);
  const task = (await hs.getObject('tasks', 'c2')).properties;
  assert.equal(task.hs_timestamp, '2026-09-25T19:30:00.000Z');
  assert.equal(task.hs_task_reminders, String(dueAt - 5 * 60_000));
  await assert.rejects(snoozeCall(hs, 'c2', '2026-09-25', { hour: 9, minute: 30 }, OPTS), /already passed/);
  await assert.rejects(snoozeCall(hs, 'c2', '2026-09-24', { hour: 11, minute: 0 }, OPTS), /after today/);
});

test("snoozeCall at a time said in their zone saves it in the rep's", async () => {
  // 2pm in New York (EDT) is 1pm in Panama.
  const { dueAt } = await snoozeCall(
    hs,
    'c2',
    '2026-09-25',
    { hour: 14, minute: 0, timeZone: 'America/New_York' },
    OPTS
  );
  const task = (await hs.getObject('tasks', 'c2')).properties;
  assert.equal(task.hs_timestamp, '2026-09-25T18:00:00.000Z');
  assert.equal(task.hs_task_reminders, String(dueAt - 5 * 60_000));
  // 9am in Los Angeles (PDT) is 11am in Panama: still ahead at 10am.
  await snoozeCall(hs, 'c2', '2026-09-25', { hour: 9, minute: 0, timeZone: 'America/Los_Angeles' }, OPTS);
  assert.equal((await hs.getObject('tasks', 'c2')).properties.hs_timestamp, '2026-09-25T16:00:00.000Z');
  // 10am in New York is 9am in Panama: gone.
  await assert.rejects(
    snoozeCall(hs, 'c2', '2026-09-25', { hour: 10, minute: 0, timeZone: 'America/New_York' }, OPTS),
    /already passed/
  );
});

test('snoozeCall without a time keeps a set-time call at its time, and moves its reminder', async () => {
  await snoozeCall(hs, 'c1', '2026-09-25', { hour: 16, minute: 0 }, OPTS);
  await snoozeCall(hs, 'c1', '2026-09-28', null, OPTS);
  const task = (await hs.getObject('tasks', 'c1')).properties;
  assert.equal(task.hs_timestamp, '2026-09-28T21:00:00.000Z');
  assert.equal(task.hs_task_reminders, String(Date.parse('2026-09-28T21:00:00Z') - 5 * 60_000));
  // A call that isn't at a set time gets no reminder.
  await snoozeCall(hs, 'c2', '2026-09-28', null, OPTS);
  assert.equal((await hs.getObject('tasks', 'c2')).properties.hs_task_reminders, undefined);
});

test('dropEmail defers the task, and a repeat is a no-op', async () => {
  await dropEmail(hs, sent, confirmations, 'e1');
  await dropEmail(hs, sent, confirmations, 'e1');
  assert.equal((await hs.getObject('tasks', 'e1')).properties.hs_task_status, 'DEFERRED');
});

test('dropEmail refuses non-EMAIL and completed tasks', async () => {
  await assert.rejects(dropEmail(hs, sent, confirmations, 'c1'), /not EMAIL/);
  await hs.updateObject('tasks', 'e1', { hs_task_status: 'COMPLETED' });
  await assert.rejects(dropEmail(hs, sent, confirmations, 'e1'), /no longer open/);
});

test('dropEmail refuses a task the app has sent, or may have sent, an email for', async () => {
  await sent.beginSend(
    {
      emailTaskId: 'e1',
      contactId: 'k1',
      companyId: null,
      fromEmail: 'me@example.com',
      toEmail: 'them@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      openToken: 'o'.repeat(32),
      links: [],
      trackOpens: true,
      trackClicks: true,
    },
    NOW / 1000,
    60
  );
  await assert.rejects(dropEmail(hs, sent, confirmations, 'e1'), /send page/);
  assert.equal((await hs.getObject('tasks', 'e1')).properties.hs_task_status, 'NOT_STARTED');
});

test('dropEmail refuses a task being marked sent', async () => {
  await confirmations.create({ emailTaskId: 'e1', contactId: 'k1', companyId: null });
  await assert.rejects(dropEmail(hs, sent, confirmations, 'e1'), /marked sent/);
  assert.equal((await hs.getObject('tasks', 'e1')).properties.hs_task_status, 'NOT_STARTED');
});

test('dropEmail puts COMPLETED back when Mark sent finished just before its write', async () => {
  const update = hs.updateObject.bind(hs);
  let raced = false;
  hs.updateObject = async (type, id, props) => {
    if (!raced && props.hs_task_status === 'DEFERRED') {
      // Mark sent runs to the end between Drop's first check and its PATCH.
      raced = true;
      await update(type, id, { hs_task_status: 'COMPLETED' });
      await confirmations.create({ emailTaskId: 'e1', contactId: 'k1', companyId: null });
      await confirmations.markCompleted('e1', new Date(NOW).toISOString());
      await confirmations.setCallTask('e1', 'call-1');
    }
    await update(type, id, props);
  };
  await assert.rejects(dropEmail(hs, sent, confirmations, 'e1'), /send page/);
  assert.equal((await hs.getObject('tasks', 'e1')).properties.hs_task_status, 'COMPLETED');
});

test('dropEmail backs off when a send claims the task while it drops', async () => {
  const update = hs.updateObject.bind(hs);
  let raced = false;
  hs.updateObject = async (type, id, props) => {
    await update(type, id, props);
    if (!raced && props.hs_task_status === 'DEFERRED') {
      raced = true;
      await confirmations.create({ emailTaskId: 'e1', contactId: 'k1', companyId: null });
    }
  };
  await assert.rejects(dropEmail(hs, sent, confirmations, 'e1'), /send page/);
  assert.equal((await hs.getObject('tasks', 'e1')).properties.hs_task_status, 'NOT_STARTED');
});

// Only `get` is read; a row is a call logged from the app. No dials: those
// are in calls.test.ts, on the real SQL.
function callLogs(rows: Record<string, { completed_at: string | null }> = {}) {
  return {
    callLogs: { get: async (id: string) => (rows[id] ?? null) as CallLog | null },
    dials: { startedSince: async () => [] },
    locks,
  };
}
const NOW_SEC = NOW / 1000;

test('dropCall defers the task, and a repeat is a no-op', async () => {
  await dropCall(hs, callLogs(), 'c1', NOW_SEC);
  await dropCall(hs, callLogs(), 'c1', NOW_SEC);
  assert.equal((await hs.getObject('tasks', 'c1')).properties.hs_task_status, 'DEFERRED');
});

test('dropCall refuses non-CALL and completed tasks', async () => {
  await assert.rejects(dropCall(hs, callLogs(), 'e1', NOW_SEC), /not CALL/);
  await hs.updateObject('tasks', 'c1', { hs_task_status: 'COMPLETED' });
  await assert.rejects(dropCall(hs, callLogs(), 'c1', NOW_SEC), /no longer open/);
});

test('dropCall refuses a call logged from the app', async () => {
  await assert.rejects(dropCall(hs, callLogs({ c1: { completed_at: null } }), 'c1', NOW_SEC), /call page/);
  assert.equal((await hs.getObject('tasks', 'c1')).properties.hs_task_status, 'NOT_STARTED');
});

test('dropCall refuses while a log or a dial holds the task, and frees it after', async () => {
  const lease = await locks.lockTask('c1', NOW_SEC, 60);
  assert.ok(lease);
  await assert.rejects(dropCall(hs, callLogs(), 'c1', NOW_SEC), /being changed/);
  assert.equal((await hs.getObject('tasks', 'c1')).properties.hs_task_status, 'NOT_STARTED');
  await locks.unlockTask('c1', lease);
  await dropCall(hs, callLogs(), 'c1', NOW_SEC);
  assert.equal(await locks.lockTask('c1', NOW_SEC, 60), NOW_SEC + 60, 'Drop released its lease');
});

test('dropCall stops before its write once slow reads used up the lock', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const get = hs.getObject.bind(hs);
  hs.getObject = async (type, id, props) => {
    clock += 90_000; // HubSpot slow to answer
    return get(type, id, props);
  };
  await assert.rejects(dropCall(hs, callLogs(), 'c1', NOW_SEC), /too slow/);
  assert.equal((await get('tasks', 'c1')).properties.hs_task_status, 'NOT_STARTED');
});

test('loadEmailQueue leaves out tasks the rep just closed, even if search still returns them', async () => {
  hs.put('tasks', 'e2', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED', hs_task_subject: 'Email: B' });
  const queue = await loadEmailQueue(hs, ['e1']);
  assert.deepEqual(
    queue.rows.map((r) => r.taskId),
    ['e2']
  );
  assert.equal(queue.nextUp?.item.taskId, 'e2');
});

test('loadEmailQueue puts follow-ups due by today first, and leaves later ones in fit order', async () => {
  const followUp = (id: string, due: string) =>
    hs.put('tasks', id, {
      hs_task_type: 'EMAIL',
      hs_task_status: 'NOT_STARTED',
      hs_task_subject: `Email: ${id} (Drew Pollard) — missed interview`,
      hs_timestamp: due,
      hs_createdate: '2026-09-25T00:00:00Z',
    });
  followUp('due', '2026-09-25T14:00:00Z'); // 09:00 Panama today
  followUp('later', '2026-09-28T14:00:00Z');
  hs.objects.get('tasks/e1')!.properties.hs_createdate = '2026-09-01T00:00:00Z';
  const queue = await loadEmailQueue(hs, [], NOW, TZ);
  assert.deepEqual(
    queue.rows.map((r) => [r.taskId, r.warm]),
    [
      ['due', true],
      ['e1', false],
      ['later', false],
    ]
  );
});

test('applyRecentChange drops a logged call and re-sorts a moved one', () => {
  const row = (taskId: string, dueAt: number | null): CallRow => callRow({ taskId, dueAt });
  const queue: CallQueue = { rows: [row('a', 1), row('b', 2), row('c', 3)], truncated: false };
  const out = applyRecentChange(queue, { logged: new Set(['b']), moved: { taskId: 'a', dueAt: 10, setTime: false } });
  assert.deepEqual(
    out.rows.map((r) => [r.taskId, r.dueAt]),
    [
      ['c', 3],
      ['a', 10],
    ]
  );
  assert.equal(queue.rows.length, 3); // input untouched
});

const callRow = (r: Partial<CallRow> & { taskId: string }): CallRow => ({
  subject: r.taskId,
  dueAt: null,
  setTime: false,
  contactId: null,
  contactName: null,
  companyName: null,
  timeZone: null,
  phone: '+13852557051',
  interview: null,
  fit: 'UNKNOWN',
  engagement: null,
  ...r,
});

test("planCalls ranks today's calls: clicked, then opened, then fit, then most overdue; no number and drop last", () => {
  const today = Date.parse('2026-09-25T14:00:00Z'); // 09:00 in Panama
  const yesterday = Date.parse('2026-09-24T14:00:00Z');
  const rows = [
    callRow({ taskId: 'weak-overdue', dueAt: yesterday, fit: 'WEAK' }),
    callRow({ taskId: 'good', dueAt: today, fit: 'GOOD' }),
    callRow({
      taskId: 'drop-clicked',
      dueAt: yesterday,
      fit: 'DROP',
      engagement: { opens: 0, clicks: 1, lastOpenAt: null },
    }),
    callRow({ taskId: 'strong-no-number', dueAt: yesterday, fit: 'STRONG', phone: null }),
    callRow({
      taskId: 'weak-clicked',
      dueAt: today,
      fit: 'WEAK',
      engagement: { opens: 1, clicks: 2, lastOpenAt: today },
    }),
    callRow({
      taskId: 'strong-opened',
      dueAt: today,
      fit: 'STRONG',
      engagement: { opens: 3, clicks: 0, lastOpenAt: today },
    }),
    callRow({
      taskId: 'weak-opened',
      dueAt: today,
      fit: 'WEAK',
      engagement: { opens: 1, clicks: 0, lastOpenAt: today },
    }),
    callRow({ taskId: 'good-overdue', dueAt: yesterday, fit: 'GOOD' }),
    callRow({ taskId: 'strong-tomorrow', dueAt: Date.parse('2026-09-26T14:00:00Z'), fit: 'STRONG' }),
    callRow({ taskId: 'undated', dueAt: null, fit: 'STRONG' }),
  ];

  const plan = planCalls(rows, NOW, TZ);
  assert.deepEqual(
    plan.due.map((r) => r.taskId),
    [
      'weak-clicked',
      'strong-opened',
      'weak-opened',
      'good-overdue',
      'good',
      'weak-overdue',
      'strong-no-number',
      'drop-clicked',
    ]
  );
  assert.deepEqual(
    plan.later.map((r) => r.taskId),
    ['strong-tomorrow', 'undated'],
    'upcoming keep their order'
  );
  assert.equal(plan.nextUp?.taskId, 'weak-clicked');
});

test('planCalls never suggests a call with no number or a drop-flagged company', () => {
  const today = Date.parse('2026-09-25T14:00:00Z');
  const plan = planCalls(
    [
      callRow({ taskId: 'no-number', dueAt: today, fit: 'STRONG', phone: null }),
      callRow({ taskId: 'drop', dueAt: today, fit: 'DROP' }),
    ],
    NOW,
    TZ
  );
  assert.equal(plan.due.length, 2);
  assert.equal(plan.nextUp, null);
});

test('planCalls keeps set-time calls apart: the next call from 5 minutes before their time, never earlier', () => {
  const at = (iso: string) => Date.parse(iso);
  const rows = [
    callRow({
      taskId: 'clicked',
      dueAt: at('2026-09-25T14:00:00Z'),
      engagement: { opens: 1, clicks: 1, lastOpenAt: null },
    }),
    callRow({ taskId: 'at-11', dueAt: at('2026-09-25T16:00:00Z'), setTime: true }), // 11:00 Panama
    callRow({ taskId: 'at-10-03', dueAt: at('2026-09-25T15:03:00Z'), setTime: true }),
    callRow({ taskId: 'missed-yesterday', dueAt: at('2026-09-24T20:00:00Z'), setTime: true }),
    callRow({ taskId: 'at-tomorrow', dueAt: at('2026-09-26T15:00:00Z'), setTime: true }),
  ];
  const plan = planCalls(rows, NOW, TZ); // 10:00 Panama
  assert.deepEqual(
    plan.atTime.map((r) => r.taskId),
    ['at-10-03', 'at-11']
  );
  assert.deepEqual(
    plan.due.map((r) => r.taskId),
    ['clicked', 'missed-yesterday'],
    'one from an earlier day is just overdue'
  );
  assert.deepEqual(
    plan.later.map((r) => r.taskId),
    ['at-tomorrow']
  );
  assert.equal(plan.nextUp?.taskId, 'at-10-03', 'three minutes early is close enough');
  assert.equal(planCalls(rows, NOW - 5 * 60_000, TZ).nextUp?.taskId, 'clicked', 'eight minutes early is not');
  assert.equal(planCalls(rows, at('2026-09-25T17:00:00Z'), TZ).nextUp?.taskId, 'at-10-03', 'late, the earliest first');

  const items = planItems(plan);
  assert.deepEqual(
    items.map((i) => [i.id, i.at]),
    [
      ['at-10-03', at('2026-09-25T14:58:00Z')],
      ['at-11', at('2026-09-25T15:55:00Z')],
      ['clicked', undefined],
      ['missed-yesterday', undefined],
    ]
  );
});

test('applyRecentChange makes a call moved to a set time one, and keeps one moved without a time', () => {
  const queue: CallQueue = {
    rows: [callRow({ taskId: 'a', dueAt: 1 }), callRow({ taskId: 'b', dueAt: 2, setTime: true })],
    truncated: false,
  };
  const moved = (taskId: string, setTime: boolean) =>
    applyRecentChange(queue, { logged: new Set(), moved: { taskId, dueAt: 5, setTime } }).rows.find(
      (r) => r.taskId === taskId
    )?.setTime;
  assert.equal(moved('a', true), true);
  assert.equal(moved('b', false), true);
  assert.equal(moved('a', false), false);
});

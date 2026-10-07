// Logging a call and marking an email sent answer the rep first; their
// HubSpot steps run after the page has answered (waitUntil). These run the
// real app against a stand-in for HubSpot's HTTP API, and check the steps
// land, and that a failure is shown and can be finished.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { d1CallLogStore, d1ConfirmationStore } from '../src/lib/db.ts';
import type { AppEnv } from '../src/types.ts';
import { callLogDone } from '../src/workflows/call-logged.ts';
import { FakeHubSpot, hubspotApi } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const BASE = 'http://localhost';
// The follow-up's date: the route checks it against the real clock.
const TOMORROW = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Panama' });
let db: D1Database;
let hs: FakeHubSpot;
let failing: RegExp | null; // requests matching this answer 500
let background: Promise<unknown>[];

beforeEach(() => {
  db = sqliteD1();
  hs = new FakeHubSpot();
  failing = null;
  background = [];
  hs.put('tasks', '1', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Call: Acme (Ana Díaz)',
    hs_timestamp: '2026-09-25T19:30:00Z',
  });
  hs.put('tasks', '2', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED' });
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Díaz', phone: '(385) 555-0100' });
  hs.put('companies', '20', { name: 'Acme' });
  for (const task of ['1', '2']) {
    hs.link('tasks', task, 'contacts', '10');
    hs.link('tasks', task, 'companies', '20');
  }
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const { default: app } = await import('../src/index.ts');
  const realFetch = globalThis.fetch;
  globalThis.fetch = hubspotApi(hs, () => failing) as unknown as typeof fetch;
  try {
    const res = await app.request(
      `${BASE}${path}`,
      { ...init, headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded', ...init.headers } },
      {
        DB: db,
        DEV_BYPASS_ACCESS: 'true',
        TZ: 'America/Panama',
        HUBSPOT_ACCESS_TOKEN: 'hs',
        PUBLIC_BASE_URL: BASE,
      } as unknown as AppEnv['Bindings'],
      {
        waitUntil: (p: Promise<unknown>) => background.push(p),
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext
    );
    // What ran after the response, before the stand-in goes away.
    await Promise.all(background.splice(0));
    return res;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const logCall = () =>
  request('/calls/1/log', {
    method: 'POST',
    body: new URLSearchParams({
      outcome: 'no_answer',
      notes: 'Voicemail full',
      next_type: 'CALL',
      next_date: TOMORROW,
    }),
  });

test('logging a call answers at once and the HubSpot steps land after', async () => {
  const res = await logCall();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), '/queue/calls?logged=1&saving=1');

  const row = await d1CallLogStore(db).get('1');
  assert.ok(row && callLogDone(row), 'every step recorded');
  assert.equal((await hs.getObject('tasks', '1')).properties.hs_task_status, 'COMPLETED');
  assert.ok(row.next_task_id, 'follow-up created');
  const audit = await db.prepare(`SELECT outcome FROM audit_log WHERE task_id = '1'`).all<{ outcome: string }>();
  assert.deepEqual(
    audit.results.map((r) => r.outcome),
    ['success']
  );
  assert.equal(await (await request('/unfinished')).text(), '<div id="unfinished"></div>');
});

test('a step that fails after the page answered is shown, and logging again finishes it', async () => {
  failing = /^POST \/crm\/objects\/2026-09\/tasks$/; // the follow-up task
  assert.equal((await logCall()).status, 303);

  const row = await d1CallLogStore(db).get('1');
  assert.ok(row && !callLogDone(row));
  assert.equal(row.lock_until, null, 'the lock is released');
  assert.match(row.last_error ?? '', /HubSpot API 500/);
  const notice = await (await request('/unfinished')).text();
  assert.match(notice, /Call with Ana Díaz \(Acme\)<\/strong> didn't finish in HubSpot: HubSpot API 500/);
  assert.match(notice, /href="\/calls\/1"/);

  failing = null;
  assert.equal((await logCall()).status, 303);
  const done = await d1CallLogStore(db).get('1');
  assert.ok(done && callLogDone(done));
  assert.equal(done.last_error, null);
  assert.equal(await (await request('/unfinished')).text(), '<div id="unfinished"></div>');
});

test('while the steps run, the notice says so and asks the page to check again', async () => {
  failing = /^POST \/crm\/objects\/2026-09\/tasks$/;
  await logCall();
  await d1CallLogStore(db).acquireLock('1', Math.floor(Date.now() / 1000), 60);
  const notice = await (await request('/unfinished')).text();
  assert.match(notice, /<div id="unfinished" data-saving>/);
  assert.match(notice, /Saving to HubSpot: Call with Ana Díaz \(Acme\)…/);
});

test('mark sent answers at once; the task is completed and the call task created after', async () => {
  const res = await request('/tasks/2/sent', { method: 'POST' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), '/?sent=2&saving=1');
  const row = await d1ConfirmationStore(db).get('2');
  assert.ok(row?.completed_at && row.call_task_id);
  assert.equal((await hs.getObject('tasks', '2')).properties.hs_task_status, 'COMPLETED');
});

test('a follow-up that fails after mark sent offers to finish it, which clears the notice', async () => {
  failing = /^POST \/crm\/objects\/2026-09\/tasks$/;
  await request('/tasks/2/sent', { method: 'POST' });
  const notice = await (await request('/unfinished')).text();
  assert.match(notice, /Email task 2<\/strong> didn't finish in HubSpot/);
  assert.match(notice, /<form method="post" action="\/tasks\/2\/sent"/);

  failing = null;
  await request('/tasks/2/sent', { method: 'POST' });
  assert.ok((await d1ConfirmationStore(db).get('2'))?.call_task_id);
  assert.equal(await (await request('/unfinished')).text(), '<div id="unfinished"></div>');
});

// --- straight on to the next one ---

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Panama' });

async function savePlanRow(key: 'call_plan' | 'email_plan', date: string, items: { id: string; drafted: boolean }[]) {
  await db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .bind(key, JSON.stringify({ date, items }))
    .run();
}

test("logging a call goes straight to the next call in today's order", async () => {
  await savePlanRow('call_plan', TODAY, [
    { id: '1', drafted: false },
    { id: '3', drafted: false },
  ]);
  const res = await logCall();
  assert.equal(res.headers.get('Location'), '/calls/3?logged=1');
});

test('with no order for today, logging a call goes back to the list', async () => {
  await savePlanRow('call_plan', '2020-01-01', [{ id: '3', drafted: false }]);
  const res = await logCall();
  assert.equal(res.headers.get('Location'), '/queue/calls?logged=1&saving=1');
});

test('marking an email sent goes to the next email: its draft, or its send page once drafted', async () => {
  await savePlanRow('email_plan', TODAY, [
    { id: '2', drafted: false },
    { id: '4', drafted: true },
    { id: '5', drafted: false },
  ]);
  assert.equal(
    (await request('/tasks/2/sent', { method: 'POST' })).headers.get('Location'),
    '/tasks/5/draft?sent=2',
    'one to draft comes first'
  );
});

test('a snoozed call is taken out of the order', async () => {
  await savePlanRow('call_plan', TODAY, [
    { id: '1', drafted: false },
    { id: '3', drafted: false },
  ]);
  const res = await request('/calls/1/snooze', { method: 'POST', body: new URLSearchParams({ date: '2099-01-01' }) });
  assert.equal(res.status, 303);
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'call_plan'`).first<{ value: string }>();
  assert.deepEqual(
    JSON.parse(row!.value).items.map((i: { id: string }) => i.id),
    ['3']
  );
});

// The Claude connector's MCP server, run as claude.ai reaches it once
// OAuthProvider has checked the token: JSON-RPC over POST /mcp, with the
// approving rep's email in the request's props. HubSpot is the stand-in API
// over FakeHubSpot; D1 is the real SQL on SQLite.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { d1CallLogStore, setSetting } from '../src/lib/db.ts';
import { mcpApp } from '../src/mcp/app.ts';
import type { AppEnv } from '../src/types.ts';
import { callLogDone } from '../src/workflows/call-logged.ts';
import { loadCallQueue, planCalls } from '../src/workflows/call-queue.ts';
import { FakeHubSpot, hubspotApi } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const BASE = 'https://app.example';
const REP = 'rep@example.com';
const TZ = 'America/Panama';
const TOMORROW = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ });
const EARLIER_TODAY = new Date(Date.now() - 60_000).toISOString();
let db: D1Database;
let hs: FakeHubSpot;
let background: Promise<unknown>[];

beforeEach(() => {
  db = sqliteD1();
  hs = new FakeHubSpot();
  background = [];
  hs.put('tasks', '1', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Call: Acme (Ana Díaz)',
    hs_timestamp: EARLIER_TODAY,
  });
  hs.put('tasks', '2', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED', hs_task_subject: 'Email: Acme' });
  hs.put('tasks', '3', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Call: Bolt (Ben Ruiz)',
    hs_timestamp: EARLIER_TODAY,
  });
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Díaz', phone: '(385) 555-0100', jobtitle: 'Owner' });
  hs.put('contacts', '11', { firstname: 'Ben', lastname: 'Ruiz', phone: '(385) 555-0101' });
  hs.put('companies', '20', { name: 'Acme' });
  hs.put('companies', '21', { name: 'Bolt' });
  for (const task of ['1', '2']) {
    hs.link('tasks', task, 'contacts', '10');
    hs.link('tasks', task, 'companies', '20');
  }
  hs.link('tasks', '3', 'contacts', '11');
  hs.link('tasks', '3', 'companies', '21');
});

async function post(body: unknown, props: Record<string, unknown> = { actor: REP }): Promise<Response> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = hubspotApi(hs) as unknown as typeof fetch;
  try {
    const res = await mcpApp.request(
      `${BASE}/mcp`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
      },
      { DB: db, TZ, HUBSPOT_ACCESS_TOKEN: 'hs', PUBLIC_BASE_URL: BASE } as unknown as AppEnv['Bindings'],
      { waitUntil: (p: Promise<unknown>) => background.push(p), passThroughOnException() {}, props } as never
    );
    // What ran after the response, before the stand-in goes away.
    await Promise.all(background.splice(0));
    return res;
  } finally {
    globalThis.fetch = realFetch;
  }
}

let nextId = 1;
async function rpc(method: string, params: unknown = {}) {
  const res = await post({ jsonrpc: '2.0', id: nextId++, method, params });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { result: Record<string, unknown> }).result;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = (await rpc('tools/call', { name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = result.content[0]?.text ?? '';
  return { isError: result.isError === true, text, data: result.isError ? null : (JSON.parse(text) as any) };
}

test('without the props OAuthProvider sets, /mcp answers 401', async () => {
  const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {});
  assert.equal(res.status, 401);
});

test('it introduces itself and lists its tools, marked read-only or safe to repeat', async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal((init.serverInfo as { name: string }).name, 'causeway');
  assert.match(String(init.instructions), /never make one up/i);

  const { tools } = (await rpc('tools/list')) as {
    tools: { name: string; annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }[];
  };
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of [
    'today',
    'call_queue',
    'email_queue',
    'get_contact',
    'get_call_task',
    'drafting_rules',
    'call_coaching',
  ]) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
  }
  for (const name of ['save_draft', 'log_call', 'snooze_call', 'log_meeting', 'book_interview', 'mark_email_sent']) {
    assert.equal(byName.get(name)?.annotations?.idempotentHint, true, name);
  }
  assert.ok(!byName.has('send_email') && !byName.has('dial'), 'sending and dialling stay on the pages');
});

test("call_queue lists today's calls in the app's order, with links to their pages", async () => {
  const { data } = await callTool('call_queue');
  const expected = planCalls((await loadCallQueue(hs)).rows, Date.now(), TZ).due.map((r) => r.taskId);
  assert.deepEqual(
    data.today.map((r: { taskId: string }) => r.taskId),
    expected
  );
  assert.equal(data.today.length, 2);
  const ana = data.today.find((r: { taskId: string }) => r.taskId === '1');
  assert.equal(ana.contact, 'Ana Díaz');
  assert.equal(ana.url, `${BASE}/calls/1`);
  assert.equal(data.timeZone, TZ);
});

test('get_call_task fills the call script in for the contact', async () => {
  await setSetting(db, 'call_script', 'Hi {first_name}, this is about {company}.');
  const { data } = await callTool('get_call_task', { task_id: '1' });
  assert.equal(data.script, 'Hi Ana, this is about Acme.');
  assert.equal(data.contact.phone, '+13855550100');
  assert.equal(data.callLive, false);
  assert.equal(data.logged, null);
});

test('log_call logs through the app: the task completed, the follow-up created, audited as the rep', async () => {
  const args = { task_id: '1', outcome: 'no_answer', notes: 'Voicemail full', next_type: 'CALL', next_date: TOMORROW };
  const first = await callTool('log_call', args);
  assert.equal(first.isError, false, first.text);
  assert.equal(first.data.logged, true);

  const row = await d1CallLogStore(db).get('1');
  assert.ok(row && callLogDone(row), 'every step recorded');
  assert.equal((await hs.getObject('tasks', '1')).properties.hs_task_status, 'COMPLETED');
  assert.ok(row.next_task_id, 'follow-up created');
  const audit = await db
    .prepare(`SELECT actor, outcome FROM audit_log WHERE task_id = '1'`)
    .all<{ actor: string; outcome: string }>();
  assert.deepEqual(
    audit.results.map((r) => ({ ...r })),
    [{ actor: REP, outcome: 'success' }]
  );

  // Again: it resumes rather than repeats, so nothing is logged twice.
  const calls = hs.calls.length;
  const again = await callTool('log_call', args);
  assert.equal(again.isError, false, again.text);
  assert.equal(hs.calls.length, calls);
});

test('a refused write comes back as a tool error in the words the pages use', async () => {
  const wrongType = await callTool('save_draft', { task_id: '1', subject: 'Hi', body: 'Hello' });
  assert.equal(wrongType.isError, true);
  assert.equal(wrongType.text, 'Can’t do that: Task 1 is a CALL task, not EMAIL.');

  const saved = await callTool('save_draft', {
    task_id: '2',
    subject: 'Quick question',
    body: 'Hi Ana,\n\nThanks,\nAnel',
  });
  assert.equal(saved.isError, false, saved.text);
  assert.equal(saved.data.reviewAndSend, `${BASE}/tasks/2/send`);
  const replaced = await callTool('save_draft', { task_id: '2', subject: 'Other', body: 'Other' });
  assert.equal(replaced.isError, true, 'an existing draft needs overwrite');
  assert.match(replaced.text, /overwrite: true/);
  const email = await callTool('get_email_task', { task_id: '2' });
  assert.deepEqual(email.data.draft, { subject: 'Quick question', body: 'Hi Ana,\n\nThanks,\nAnel' });
});

test('drafting_rules gives the rules without the API-only output format', async () => {
  const { data } = await callTool('drafting_rules');
  assert.match(data.rules, /Anel's voice/);
  assert.doesNotMatch(data.rules, /<subject>/);
  assert.match(data.rules, /save_draft/);
});

test('a video interview booked from here needs its join link, since no invite makes a Meet link', async () => {
  const booked = await callTool('book_interview', { task_id: '1', date: TOMORROW, time: '10:00', format: 'video' });
  assert.equal(booked.isError, true);
  assert.match(booked.text, /needs its join link/);
  assert.equal(hs.meetings.length, 0, 'no meeting created');
});

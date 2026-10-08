// The Claude connector's MCP server, run as claude.ai reaches it once
// OAuthProvider has checked the token: JSON-RPC over POST /mcp, with the
// approving rep's email in the request's props. HubSpot is the stand-in API
// over FakeHubSpot; D1 is the real SQL on SQLite.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { d1CallLogStore, d1ConversationStore, d1DialStore, d1MeetingLogStore, setSetting } from '../src/lib/db.ts';
import { mcpApp } from '../src/mcp/app.ts';
import type { AppEnv } from '../src/types.ts';
import { callLogDone } from '../src/workflows/call-logged.ts';
import { loadCallQueue, planCalls } from '../src/workflows/call-queue.ts';
import { putThrough } from './call-fixtures.ts';
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
    'what_you_heard',
    'calls_to_review',
    'get_call_review',
  ]) {
    assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
  }
  for (const name of [
    'save_draft',
    'log_call',
    'snooze_call',
    'log_meeting',
    'book_interview',
    'mark_email_sent',
    'review_call',
  ]) {
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

test('log_call counts a real conversation when the rep says so, and only on a call that reached them', async () => {
  const counted = await callTool('log_call', {
    task_id: '1',
    outcome: 'connected',
    notes: 'Ana said quoting takes her an hour a load. Call back Thursday.',
    next_type: 'CALL',
    next_date: TOMORROW,
    real_conversation: true,
    learned: 'Quoting takes an hour a load',
  });
  assert.equal(counted.isError, false, counted.text);
  const row = await d1ConversationStore(db).get('call', '1');
  assert.equal(row?.contact_id, '10');
  assert.equal(row?.who, 'Ana Díaz at Acme');
  assert.equal(row?.learned, 'Quoting takes an hour a load');

  const voicemail = await callTool('log_call', {
    task_id: '3',
    outcome: 'left_voicemail',
    next_type: 'CALL',
    next_date: TOMORROW,
    real_conversation: true,
  });
  assert.equal(voicemail.isError, false, voicemail.text);
  assert.equal(await d1ConversationStore(db).get('call', '3'), null, 'a voicemail isn’t a conversation');

  const { data } = await callTool('today');
  assert.equal(data.counts.conversations.people, 1);
  assert.equal(data.counts.conversations.latest.learned, 'Quoting takes an hour a load');
});

test('calls are reviewed from here: the ones to review, one with its rules, and the review saved over the rules', async () => {
  const logged = await callTool('log_call', {
    task_id: '1',
    outcome: 'connected',
    notes: 'Talked with Ana. Busy at lunch, said call back tomorrow.',
    next_type: 'CALL',
    next_date: TOMORROW,
  });
  assert.equal(logged.isError, false, logged.text);
  // A recorded interview, its call over an hour ago, is reviewed from here too.
  const dials = d1DialStore(db);
  const nowSec = Math.floor(Date.now() / 1000);
  await dials.begin(
    {
      id: 'dm',
      task_id: 'm1',
      subject: 'meeting',
      contact_id: '10',
      contact_label: putThrough.label,
      to_number: '+13855550100',
      to_extension: null,
      from_number: '+13852557051',
      rep_number: '+18085550199',
      mode: 'phone',
      started_sec: nowSec - 3600,
      record: 1,
    },
    120
  );
  await dials.setRepStatus('dm', 'completed', nowSec - 3000);
  await dials.setProspectResult('dm', { sid: 'CA9', status: 'completed', durationSec: 543 });
  await dials.setRecording('dm', { sid: 'RE9', durationSec: 543, channels: 2 });
  await dials.beginTranscript('dm', nowSec - 3000, 300);
  await dials.saveTranscript('dm', JSON.stringify(putThrough.turns), null);
  // Opening coaching reads the calls not read yet, after it answers.
  await callTool('call_coaching');

  const list = await callTool('calls_to_review');
  assert.deepEqual(
    list.data.calls.map((call: { taskId: string; kind: string }) => [call.taskId, call.kind]),
    [
      ['1', 'call'],
      ['m1', 'interview'],
    ]
  );

  const call = await callTool('get_call_review', { task_id: '1' });
  assert.equal(call.isError, false, call.text);
  assert.match(call.data.rules, /Correct the tags/);
  assert.equal(call.data.call.repNotes, 'Talked with Ana. Busy at lunch, said call back tomorrow.');
  assert.equal(call.data.transcript, null, 'logged by hand: no recording');
  assert.match(call.data.rules, /stamped \[start–end\]/);
  assert.deepEqual(call.data.reviews, []);

  assert.match(call.data.rules, /## The Mom Test/);
  assert.deepEqual(call.data.reading.tags.momTest, {
    askedAboutLastTime: null,
    pitched: null,
    longestStorySec: null,
    fluffCaught: null,
    commitment: null,
  });

  const reviewed = await callTool('review_call', {
    task_id: '1',
    corrections: {
      stage: 'conversation',
      nextStep: { agreed: true, what: 'Call back tomorrow' },
      askedAboutLastTime: false,
      fluffCaught: false,
      commitment: 'time',
    },
    what_worked: 'Asked about her week before anything else.',
    adjust: 'Leave with a time, not “tomorrow”.',
  });
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(reviewed.data.reading.sources.stage.by, 'claude');
  assert.deepEqual(reviewed.data.reading.tags.momTest, {
    askedAboutLastTime: false,
    pitched: null,
    longestStorySec: null,
    fluffCaught: false,
    commitment: 'time',
  });
  assert.equal(reviewed.data.reading.sources.commitment.by, 'claude');
  assert.deepEqual(
    [reviewed.data.reading.review.whatWorkedBy, reviewed.data.reading.review.adjustBy],
    ['claude', 'claude']
  );
  assert.equal(reviewed.data.reading.review.adjust, 'Leave with a time, not “tomorrow”.');
  assert.ok(!reviewed.data.reading.unsure.includes('stage'));

  const interview = await callTool('get_call_review', { task_id: 'm1' });
  assert.equal(interview.isError, false, interview.text);
  assert.equal(interview.data.call.kind, 'interview');
  assert.match(interview.data.call.url, /\/meetings\/m1$/);
  assert.ok(interview.data.transcript.length > 10, 'turn by turn, with stamps');
  assert.equal(interview.data.reading.tags.reachedThem, true);
  // The interview logged with a follow-up: the review's answer keeps its time.
  await d1MeetingLogStore(db).create({
    log_id: 'm1@log',
    meeting_id: 'm1',
    contact_id: '10',
    company_id: '20',
    owner_id: null,
    outcome: 'COMPLETED',
    canceled_by: null,
    notes: '',
    internal_notes_html: '',
    new_start: null,
    new_end: null,
    next_type: 'CALL',
    next_subject: null,
    next_due: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    next_body: null,
    calendar_event_id: null,
  });
  const saved = await callTool('review_call', {
    task_id: 'm1',
    corrections: { commitment: 'time' },
    adjust: 'Ask about the last load before anything else.',
  });
  assert.equal(saved.isError, false, saved.text);
  assert.equal(saved.data.reading.tags.momTest.commitment, 'time');
  assert.ok(saved.data.reading.tags.nextStep.when, 'the follow-up’s time, from the interview’s log');
  assert.match(saved.data.url, /\/meetings\/m1$/);

  assert.deepEqual((await callTool('calls_to_review')).data.calls, [], 'both reviewed: off the list');

  const heard = await callTool('what_you_heard');
  assert.equal(heard.isError, false, heard.text);
  assert.equal(heard.data.ofCallsThatReachedThem, 2, 'the call and the interview');
  assert.ok(
    heard.data.byTheme.some((t: { theme: string }) => t.theme === 'software'),
    'Lyle on software, twice over'
  );
  assert.match(heard.data.callByCall[0].url, /\/meetings\/m1$/);
  const again = await callTool('get_call_review', { task_id: '1' });
  assert.equal(again.data.reviews[0].by, 'claude');

  const audit = await db
    .prepare(`SELECT action FROM audit_log WHERE task_id = '1' AND action LIKE 'review%'`)
    .all<{ action: string }>();
  assert.deepEqual(
    audit.results.map((r) => r.action),
    ['review for coaching (claude)']
  );

  const none = await callTool('review_call', { task_id: '2', corrections: {} });
  assert.equal(none.isError, true);
  assert.match(none.text, /nothing to review/);
});

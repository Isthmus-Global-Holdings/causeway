// Click-to-call and call logging: the workflows against the real SQL on
// SQLite (test/sqlite-d1.ts), a fake HubSpot, and a fake Twilio. The webhook
// routes run on a real Hono app with requests signed the way Twilio signs them.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { d1CallLogStore, d1DialStore, type Dial, type DialStore } from '../src/lib/db.ts';
import { createHubSpot, HubSpotApiError } from '../src/lib/hubspot.ts';
import { TwilioApiError, type NewCall, type Twilio } from '../src/lib/twilio.ts';
import { twilioRoute } from '../src/routes/twilio.ts';
import type { AppEnv } from '../src/types.ts';
import {
  callLogDone,
  nextLeadStatus,
  nextTaskSubject,
  parseCallLogForm,
  runCallLogged,
} from '../src/workflows/call-logged.ts';
import { callNowHref, callPage, type CallPageState } from '../src/views/calls.ts';
import { BOOKING_FIELDS, bookingFieldsOf, parseBookingForm } from '../src/workflows/book-interview.ts';
import { loadCallContext, historyTimeline, type CallContext } from '../src/workflows/call-context.ts';
import { dialState, startDial } from '../src/workflows/dial.ts';
import { loadCallQueue } from '../src/workflows/call-queue.ts';
import { recordingState, runTranscription, type Transcriber } from '../src/workflows/transcribe.ts';
import { FakeHubSpot } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const NOW = Date.parse('2026-09-25T15:00:00Z'); // 10:00 in Panama
const NOW_SEC = NOW / 1000;
const TZ = 'America/Panama';
const BASE = 'https://app.test';
const DIAL_ID = 'd'.repeat(32);
const LOG_OPTS = { now: NOW, timeZone: TZ, baseUrl: BASE };
const EMPTY_CONTEXT: CallContext = {
  notes: { items: [], failed: false, missingScopes: [] },
  calls: { items: [], failed: false, missingScopes: [] },
  emails: { items: [], failed: false, missingScopes: [] },
};

class FakeTwilio implements Twilio {
  calls: NewCall[] = [];
  fail: Error | null = null;
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
    if (this.fail) throw this.fail;
    this.calls.push(call);
    return { sid: `CA${this.calls.length}` };
  }
}

let db: D1Database;
let dials: DialStore;
let hs: FakeHubSpot;
let twilio: FakeTwilio;

beforeEach(() => {
  db = sqliteD1();
  dials = d1DialStore(db);
  hs = new FakeHubSpot();
  twilio = new FakeTwilio();
  hs.put('tasks', '1', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Call: Acme (Ana Díaz) — follow up on email',
    hs_timestamp: '2026-09-25T19:30:00Z', // 14:30 Panama
    hubspot_owner_id: '77',
  });
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Díaz', phone: '(385) 555-0100', mobilephone: 'n/a' });
  hs.put('companies', '20', { name: 'Acme', phone: '385-555-0190' });
  hs.link('tasks', '1', 'contacts', '10');
  hs.link('tasks', '1', 'companies', '20');
});

const dialOpts = (overrides: Partial<Parameters<typeof startDial>[3]> = {}) => ({
  now: NOW,
  baseUrl: `${BASE}/`,
  fromNumber: '+13852557051',
  mode: 'phone' as const,
  repNumber: '+18085550199' as string | null,
  newId: () => DIAL_ID,
  record: false,
  ...overrides,
});

// --- startDial ---

test("rings the rep from the Twilio number, with this dial's webhooks", async () => {
  const dial = await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts());

  assert.deepEqual(twilio.calls, [
    {
      to: '+18085550199',
      from: '+13852557051',
      url: `${BASE}/twilio/voice/answer?d=${DIAL_ID}`,
      statusCallback: `${BASE}/twilio/voice/rep-status?d=${DIAL_ID}`,
      timeoutSec: 25,
    },
  ]);
  assert.equal(dial.to_number, '+13855550100', 'the prospect number comes from HubSpot, as E.164');
  assert.equal(dial.contact_label, 'Ana Díaz at Acme');
  assert.equal(dial.rep_call_sid, 'CA1');
});

test("the number's extension is keyed in, and a call to an extension isn't recorded", async () => {
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Díaz', phone: '(385) 555-0100 x204' });
  const dial = await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ record: true }));
  assert.equal(dial.to_number, '+13855550100');
  assert.equal(dial.to_extension, '204');
  assert.equal(dial.record, 0, 'the notice would play to the phone menu, not to whoever picks up');

  await dials.setRepStatus(DIAL_ID, 'completed');
  const direct = await startDial(
    { hs, twilio, dials },
    '1',
    'company',
    dialOpts({ record: true, newId: () => 'e'.repeat(32) })
  );
  assert.equal(direct.to_extension, null);
  assert.equal(direct.record, 1);
});

test('a second click while the first is ringing is refused', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts());
  await assert.rejects(
    startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ newId: () => 'e'.repeat(32) })),
    /already ringing/
  );
  assert.equal(twilio.calls.length, 1);
});

test('once the first call has ended, dialling again works', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts());
  await dials.setRepStatus(DIAL_ID, 'completed');
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ newId: () => 'e'.repeat(32) }));
  assert.equal(twilio.calls.length, 2);
});

test('a Twilio refusal (4xx) frees the task to be dialled again straight away', async () => {
  twilio.fail = new TwilioApiError(400, '{"code":21211}', '/Accounts/AC1/Calls.json');
  await assert.rejects(startDial({ hs, twilio, dials }, '1', 'phone', dialOpts()), /Twilio API 400/);
  assert.equal((await dials.get(DIAL_ID))?.rep_status, 'failed');
  twilio.fail = null;
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ newId: () => 'e'.repeat(32) }));
  assert.equal(twilio.calls.length, 1);
});

test('an unclear Twilio failure keeps the guard, so a retry cannot ring the rep twice', async () => {
  twilio.fail = new Error('network connection lost'); // Twilio may have placed the call
  await assert.rejects(startDial({ hs, twilio, dials }, '1', 'phone', dialOpts()), /network connection lost/);
  const dial = (await dials.get(DIAL_ID))!;
  assert.equal(dial.rep_status, null, 'not marked over');
  twilio.fail = null;
  await assert.rejects(
    startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ newId: () => 'e'.repeat(32) })),
    /already ringing/
  );
  assert.equal(dialState(dial, NOW_SEC + 30).kind, 'ringing-rep');

  // Twilio never confirmed it, so after the guard window it stops counting as live...
  const later = NOW + 121_000;
  assert.equal(dialState(dial, later / 1000).kind, 'ended');
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ now: later, newId: () => 'e'.repeat(32) }));
  assert.equal(twilio.calls.length, 1);
  // ...unless the rep pressed 1 on it, which proves the call exists.
  assert.equal(dialState({ ...dial, connected_at: 'x' }, later / 1000).kind, 'on-call');
});

test("can dial the company's main line", async () => {
  const dial = await startDial({ hs, twilio, dials }, '1', 'company', dialOpts());
  assert.equal(dial.to_number, '+13855550190');
});

test('refuses numbers it cannot dial, completed tasks and non-CALL tasks', async () => {
  await assert.rejects(startDial({ hs, twilio, dials }, '1', 'mobilephone', dialOpts()), /"n\/a" isn't a number/);
  hs.put('tasks', '2', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED' });
  await assert.rejects(startDial({ hs, twilio, dials }, '2', 'phone', dialOpts()), /not CALL/);
  await hs.updateObject('tasks', '1', { hs_task_status: 'COMPLETED' });
  await assert.rejects(startDial({ hs, twilio, dials }, '1', 'phone', dialOpts()), /already completed/);
  assert.equal(twilio.calls.length, 0);
});

// --- dialState ---

const baseDial: Dial = {
  id: DIAL_ID,
  task_id: '1',
  contact_id: '10',
  contact_label: 'Ana Díaz at Acme',
  to_number: '+13855550100',
  to_extension: null,
  from_number: '+13852557051',
  rep_number: '+18085550199',
  mode: 'phone',
  started_sec: NOW_SEC,
  rep_call_sid: 'CA1',
  rep_status: null,
  connected_at: null,
  prospect_call_sid: null,
  prospect_status: null,
  prospect_duration_sec: null,
  rep_ended_sec: null,
  record: 0,
  recording_sid: null,
  recording_duration_sec: null,
  recording_channels: null,
  transcript_status: null,
  transcript_started_sec: null,
  transcript_json: null,
  summary: null,
  transcript_error: null,
};

test('dialState follows the call from ringing to ended', () => {
  assert.deepEqual(dialState(baseDial, NOW_SEC + 5), { kind: 'ringing-rep' });
  const connected = { ...baseDial, connected_at: 'x' };
  assert.deepEqual(dialState(connected, NOW_SEC + 30), { kind: 'on-call' });
  const talked = { ...connected, rep_status: 'completed', prospect_status: 'completed', prospect_duration_sec: 95 };
  const ended = dialState(talked, NOW_SEC + 200);
  assert.equal(ended.kind, 'ended');
  assert.match(ended.kind === 'ended' ? ended.summary : '', /Call length 1m 35s/);
});

test('dialState explains why nobody was dialled', () => {
  const summary = (d: Partial<Dial>) => {
    const s = dialState({ ...baseDial, ...d }, NOW_SEC + 60);
    return s.kind === 'ended' ? s.summary : s.kind;
  };
  assert.match(summary({ rep_status: 'no-answer' }), /Your phone didn’t pick up/);
  assert.match(summary({ rep_status: 'completed' }), /hung up before pressing 1/);
  assert.match(summary({ rep_status: 'completed', connected_at: 'x', prospect_status: 'no-answer' }), /didn’t answer/);
  // A dial whose webhook never came stops counting as live after two hours.
  assert.equal(dialState(baseDial, NOW_SEC + 3 * 3600).kind, 'ended');
});

// --- the webhooks ---

async function sign(token: string, url: string, params: Record<string, string>): Promise<string> {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64');
}

function webhookApp() {
  const app = new Hono<AppEnv>();
  app.route('/', twilioRoute);
  return app;
}

const env = () =>
  ({
    DB: db,
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_ACCOUNT_SID: 'AC1',
    PUBLIC_BASE_URL: BASE,
  }) as unknown as AppEnv['Bindings'];

async function post(path: string, params: Record<string, string>, signature?: string) {
  const url = `${BASE}${path}`;
  return webhookApp().request(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature ?? (await sign('tok', url, params)),
      },
      body: new URLSearchParams(params),
    },
    env()
  );
}

test('webhooks refuse requests without a valid Twilio signature', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts());
  const res = await post(`/twilio/voice/connect?d=${DIAL_ID}`, { Digits: '1' }, 'forged');
  assert.equal(res.status, 403);
  assert.equal((await dials.get(DIAL_ID))?.connected_at, null);
});

test('the rep hears who is next, and only pressing 1 dials them', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts());

  const answer = await post(`/twilio/voice/answer?d=${DIAL_ID}`, { CallStatus: 'in-progress' });
  assert.equal(answer.headers.get('Content-Type'), 'text/xml');
  assert.match(await answer.text(), /Call to Ana Díaz at Acme\. Press 1/);

  const timedOut = await post(`/twilio/voice/connect?d=${DIAL_ID}`, {});
  assert.doesNotMatch(await timedOut.text(), /<Dial/);
  assert.equal((await dials.get(DIAL_ID))?.connected_at, null);

  const connect = await post(`/twilio/voice/connect?d=${DIAL_ID}`, { Digits: '1' });
  const xml = await connect.text();
  assert.match(xml, /<Dial callerId="\+13852557051"/);
  assert.match(xml, /\+13855550100<\/Number>/);
  assert.match(xml, /prospect-status\?d=d{32}/);
  assert.ok((await dials.get(DIAL_ID))?.connected_at);
});

test('status callbacks record each leg, in either order', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts());
  await post(`/twilio/voice/rep-status?d=${DIAL_ID}`, { CallStatus: 'completed', CallSid: 'CA1' });
  await post(`/twilio/voice/prospect-status?d=${DIAL_ID}`, {
    CallStatus: 'completed',
    CallSid: 'CA2',
    CallDuration: '95',
  });
  const dial = await dials.get(DIAL_ID);
  assert.deepEqual(
    [dial?.rep_status, dial?.prospect_status, dial?.prospect_call_sid, dial?.prospect_duration_sec],
    ['completed', 'completed', 'CA2', 95]
  );
});

test('an unknown dial id gets a polite hang-up, not a dial', async () => {
  const res = await post(`/twilio/voice/answer?d=${'f'.repeat(32)}`, {});
  assert.match(await res.text(), /expired.*<Hangup\/>/);
});

// --- parseCallLogForm ---

test('parseCallLogForm checks the outcome and the follow-up date', () => {
  const today = '2026-09-25';
  assert.deepEqual(parseCallLogForm({ outcome: 'connected', notes: 'a\r\nb', next_type: '' }, today), {
    channel: 'phone',
    outcome: 'connected',
    notes: 'a\nb',
    whatsappField: null,
    next: null,
    booking: null,
  });
  assert.deepEqual(parseCallLogForm({ outcome: 'no_answer', next_type: 'CALL', next_date: '2026-09-27' }, today).next, {
    type: 'CALL',
    date: '2026-09-27',
  });
  assert.throws(() => parseCallLogForm({ outcome: 'nope' }, today), /Pick an outcome/);
  assert.throws(() => parseCallLogForm({ outcome: 'busy', next_type: 'CALL', next_date: '2026-09-24' }, today), /past/);
  assert.throws(() => parseCallLogForm({ outcome: 'busy', next_type: 'CALL', next_date: '' }, today), /Pick a date/);
  assert.throws(() => parseCallLogForm({ outcome: 'busy', next_type: 'MEETING', next_date: today }, today), /Unknown/);
});

test('parseCallLogForm takes a set time for a follow-up call only', () => {
  const today = '2026-09-25';
  const form = { outcome: 'connected', next_type: 'CALL', next_date: today, next_time: '14:30' };
  assert.deepEqual(parseCallLogForm(form, today).next, { type: 'CALL', date: today, time: { hour: 14, minute: 30 } });
  assert.deepEqual(parseCallLogForm({ ...form, next_time: '' }, today).next, { type: 'CALL', date: today });
  assert.deepEqual(parseCallLogForm({ ...form, next_type: 'EMAIL' }, today).next, { type: 'EMAIL', date: today });
  assert.deepEqual(parseCallLogForm({ ...form, next_time: '4pm' }, today).next, {
    type: 'CALL',
    date: today,
    time: { hour: 16, minute: 0 },
  });
  assert.throws(() => parseCallLogForm({ ...form, next_time: '4' }, today), /like 4pm/);
});

// --- runCallLogged ---

const dialed: Dial = {
  ...baseDial,
  rep_status: 'completed',
  connected_at: '2026-09-25T15:00:10Z',
  prospect_status: 'completed',
  prospect_duration_sec: 95,
};

test('logs the call with its outcome, completes the task, and creates the follow-up at the task time', async () => {
  const store = d1CallLogStore(db);
  const result = await runCallLogged(
    hs,
    store,
    '1',
    {
      outcome: 'connected',
      notes: 'Wants a quote\nCall Monday',
      next: { type: 'CALL', date: '2026-09-28' },
      dial: dialed,
    },
    LOG_OPTS
  );

  assert.equal(hs.calls.length, 1);
  const { call, links } = hs.calls[0];
  assert.deepEqual(links, { contactId: '10', companyId: '20' });
  assert.equal(call.title, 'Call with Ana Díaz (Acme)');
  assert.equal(call.status, 'COMPLETED');
  assert.equal(call.disposition, 'f240bbac-87c9-4f6e-bf70-924b57d47db7');
  assert.equal(call.durationMs, 95_000);
  assert.equal(call.ownerId, '77', 'the task owner shows as the caller');
  assert.deepEqual([call.fromNumber, call.toNumber], ['+13852557051', '+13855550100']);
  assert.match(call.bodyHtml, /Wants a quote<br>Call Monday/);

  assert.equal(hs.objects.get('tasks/1')!.properties.hs_task_status, 'COMPLETED');
  assert.deepEqual(hs.created, [
    {
      properties: {
        hs_task_type: 'CALL',
        hs_task_status: 'NOT_STARTED',
        hs_task_subject: nextTaskSubject('CALL', 'Acme', 'Ana Díaz'),
        hs_timestamp: '2026-09-28T19:30:00.000Z', // 14:30 Panama, the call task's time
        hubspot_owner_id: '77',
      },
      links: { contactId: '10', companyId: '20' },
    },
  ]);
  assert.equal(hs.objects.get('contacts/10')!.properties.hs_lead_status, 'CONNECTED');
  assert.deepEqual(result, {
    loggedCallId: 'call-1',
    loggedMessageId: null,
    completedNow: true,
    nextTaskId: '900',
    nextTaskCreated: true,
    leadStatus: 'CONNECTED',
    bookedMeetingId: null,
  });
});

test('a follow-up call at a set time is due then, with a reminder 5 minutes before; a time gone by is refused', async () => {
  const store = d1CallLogStore(db);
  const input = { outcome: 'connected' as const, notes: '', dial: null, transcript: null };
  await assert.rejects(
    runCallLogged(
      hs,
      store,
      '1',
      { ...input, next: { type: 'CALL', date: '2026-09-25', time: { hour: 9, minute: 30 } } },
      LOG_OPTS
    ),
    /already passed/
  );
  assert.equal(await store.get('1'), null, 'nothing recorded');

  await runCallLogged(
    hs,
    store,
    '1',
    { ...input, next: { type: 'CALL', date: '2026-09-25', time: { hour: 16, minute: 0 } } },
    LOG_OPTS
  );
  const due = Date.parse('2026-09-25T21:00:00Z'); // 16:00 Panama, later today
  assert.equal(hs.created[0].properties.hs_timestamp, new Date(due).toISOString());
  assert.equal(hs.created[0].properties.hs_task_reminders, String(due - 5 * 60_000));
});

test('a second submission writes nothing more', async () => {
  const store = d1CallLogStore(db);
  const input = { outcome: 'no_answer' as const, notes: '', next: null, dial: null, transcript: null };
  await runCallLogged(hs, store, '1', input, LOG_OPTS);
  const again = await runCallLogged(hs, store, '1', { ...input, notes: 'different' }, LOG_OPTS);
  assert.equal(hs.calls.length, 1);
  assert.deepEqual(again, {
    loggedCallId: 'call-1',
    loggedMessageId: null,
    completedNow: false,
    nextTaskId: null,
    nextTaskCreated: false,
    leadStatus: null,
    bookedMeetingId: null,
  });
});

test('a HubSpot 4xx on the log lets the retry log; a 5xx does not risk a duplicate', async () => {
  const store = d1CallLogStore(db);
  const input = { outcome: 'busy' as const, notes: '', next: null, dial: null, transcript: null };

  hs.failNextLogCall = new HubSpotApiError(400, 'bad', '/crm/objects/2026-09/calls');
  await assert.rejects(runCallLogged(hs, store, '1', input, LOG_OPTS), /HubSpot API 400/);
  await runCallLogged(hs, store, '1', input, LOG_OPTS);
  assert.equal(hs.calls.length, 1, 'retried after a definite rejection');

  hs.put('tasks', '3', { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED' });
  hs.link('tasks', '3', 'contacts', '10');
  hs.failNextLogCall = new HubSpotApiError(502, 'gateway', '/crm/objects/2026-09/calls');
  await assert.rejects(runCallLogged(hs, store, '3', input, LOG_OPTS), /HubSpot API 502/);
  const retry = await runCallLogged(hs, store, '3', input, LOG_OPTS);
  assert.equal(hs.calls.length, 1, 'no second log after an unclear failure');
  assert.equal(retry.loggedCallId, null);
  assert.equal(hs.objects.get('tasks/3')!.properties.hs_task_status, 'COMPLETED', 'the other steps still finish');
});

test('the first submission sticks, and an orphaned follow-up task is reused', async () => {
  const store = d1CallLogStore(db);
  const subject = nextTaskSubject('EMAIL', 'Acme', 'Ana Díaz');
  hs.put('tasks', '555', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED', hs_task_subject: subject });
  hs.link('contacts', '10', 'tasks', '555');
  hs.failNextCreate = true; // not reached: the orphan is found first

  const result = await runCallLogged(
    hs,
    store,
    '1',
    {
      outcome: 'left_voicemail',
      notes: 'first',
      next: { type: 'EMAIL', date: '2026-09-26' },
      dial: null,
      transcript: null,
    },
    LOG_OPTS
  );
  assert.equal(result.nextTaskId, '555');
  assert.equal(result.nextTaskCreated, false);
  assert.equal(hs.created.length, 0);
  assert.equal((await store.get('1'))?.notes, 'first');
  assert.equal(hs.calls[0].call.status, 'COMPLETED', 'no Twilio call: logged as a completed manual call');
  assert.equal(hs.calls[0].call.toNumber, '(385) 555-0100');
});

test('Lead Status only moves forward, and never over a status set by hand', () => {
  assert.equal(nextLeadStatus(null, 'no_answer'), 'ATTEMPTED_TO_CONTACT');
  assert.equal(nextLeadStatus('NEW', 'left_voicemail'), 'ATTEMPTED_TO_CONTACT');
  assert.equal(nextLeadStatus('OPEN', 'connected'), 'CONNECTED');
  assert.equal(nextLeadStatus('ATTEMPTED_TO_CONTACT', 'connected'), 'CONNECTED');
  assert.equal(nextLeadStatus('ATTEMPTED_TO_CONTACT', 'busy'), null, 'already there');
  assert.equal(nextLeadStatus('CONNECTED', 'no_answer'), null, 'no step back');
  for (const manual of ['IN_PROGRESS', 'OPEN_DEAL', 'UNQUALIFIED', 'BAD_TIMING']) {
    assert.equal(nextLeadStatus(manual, 'connected'), null, manual);
  }
  assert.equal(nextLeadStatus(null, 'wrong_number'), null);
});

test('a Lead Status set by hand in HubSpot survives logging a call', async () => {
  await hs.updateObject('contacts', '10', { hs_lead_status: 'IN_PROGRESS' });
  const result = await runCallLogged(
    hs,
    d1CallLogStore(db),
    '1',
    { outcome: 'no_answer', notes: '', next: null, dial: null, transcript: null },
    LOG_OPTS
  );
  assert.equal(result.leadStatus, null);
  assert.equal(hs.objects.get('contacts/10')!.properties.hs_lead_status, 'IN_PROGRESS');
});

test('refuses a task already completed in HubSpot, and a concurrent run', async () => {
  const store = d1CallLogStore(db);
  const input = { outcome: 'busy' as const, notes: '', next: null, dial: null, transcript: null };
  hs.put('tasks', '4', { hs_task_type: 'CALL', hs_task_status: 'COMPLETED' });
  hs.link('tasks', '4', 'contacts', '10');
  await assert.rejects(runCallLogged(hs, store, '4', input, LOG_OPTS), /already completed/);

  await store.create({
    call_task_id: '1',
    contact_id: '10',
    company_id: '20',
    owner_id: null,
    title: 't',
    channel: 'phone',
    outcome: 'busy',
    notes: '',
    twilio_status: null,
    duration_sec: null,
    from_number: null,
    to_number: null,
    next_type: null,
    next_subject: null,
    next_due: null,
    next_set_time: 0,
    next_body: null,
    dial_id: null,
    book_start: null,
    book_title: null,
    book_minutes: null,
    book_join_url: null,
    book_phone: null,
    book_invite: 0,
    book_invitee_email: null,
  });
  await store.acquireLock('1', NOW_SEC, 60);
  await assert.rejects(runCallLogged(hs, store, '1', input, LOG_OPTS), /already being logged/);
  assert.equal(hs.calls.length, 0);
});

// --- recording and transcription ---

const NOVA = {
  results: {
    channels: [
      { alternatives: [{ words: [{ word: 'Hi', start: 0.5, end: 0.8 }] }] },
      { alternatives: [{ words: [{ word: 'Send a quote.', start: 1.5, end: 2.5 }] }] },
    ],
  },
};

class FakeAi implements Transcriber {
  transcribed = 0;
  failTranscribe: Error | null = null;
  failSummary = false;
  async transcribe() {
    if (this.failTranscribe) throw this.failTranscribe;
    this.transcribed += 1;
    return NOVA;
  }
  async summarize() {
    if (this.failSummary) throw new Error('model busy');
    return '- Wants a quote\n- Call back Monday';
  }
}

async function recordedCall(ai: FakeAi) {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ record: true }));
  await dials.markConnected(DIAL_ID, 'x');
  await dials.setProspectResult(DIAL_ID, { sid: 'CA2', status: 'completed', durationSec: 95 });
  await dials.setRepStatus(DIAL_ID, 'completed');
  await dials.setRecording(DIAL_ID, { sid: 'RE1', durationSec: 90, channels: 2 });
  const recordings: { sid: string; channels: number | null }[] = [];
  const deps = {
    dials,
    callLogs: d1CallLogStore(db),
    hs,
    ai,
    recording: async (sid: string, channels: number | null) => {
      recordings.push({ sid, channels });
      return new Response('mp3 bytes');
    },
  };
  return { deps, recordings };
}

test('a recorded call: the notice plays first, then the app starts recording and connects the call', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ record: true }));
  const xml = await (await post(`/twilio/voice/connect?d=${DIAL_ID}`, { Digits: '1' })).text();
  assert.match(xml, /<Number [^>]*url="https:\/\/app\.test\/twilio\/voice\/notice\?d=d{32}"/);
  assert.doesNotMatch(xml, /record=/);

  const notice = await (await post(`/twilio/voice/notice?d=${DIAL_ID}`, {})).text();
  assert.match(
    notice,
    /<Say>This call may be recorded\.<\/Say><Gather [^>]*action="https:\/\/app\.test\/twilio\/voice\/after-notice\?d=d{32}"/
  );

  // After the notice, the app starts the recording on the parent (rep's) call.
  const realFetch = globalThis.fetch;
  const started: { url: string; body: URLSearchParams }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    started.push({ url, body: new URLSearchParams(String(init.body)) });
    return Response.json({ sid: 'RE1' }, { status: 201 });
  }) as unknown as typeof fetch;
  try {
    const after = await post(`/twilio/voice/after-notice?d=${DIAL_ID}`, { ParentCallSid: 'CA1', CallSid: 'CA2' });
    assert.match(await after.text(), /<Response><\/Response>$/, 'empty TwiML: connect the call');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(started.length, 1);
  assert.equal(started[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Calls/CA1/Recordings.json');
  assert.equal(started[0].body.get('RecordingStatusCallback'), `${BASE}/twilio/voice/recording?d=${DIAL_ID}`);
});

test("a recording that can't start still connects the call, and the page says why", async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ record: true }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"code":20003}', { status: 401 })) as unknown as typeof fetch;
  try {
    const after = await post(`/twilio/voice/after-notice?d=${DIAL_ID}`, { ParentCallSid: 'CA1' });
    assert.match(await after.text(), /<Response><\/Response>$/);
  } finally {
    globalThis.fetch = realFetch;
  }
  const state = recordingState((await dials.get(DIAL_ID))!, NOW_SEC + 60);
  assert.equal(state.kind, 'failed');
  assert.match(state.kind === 'failed' ? state.message : '', /The recording didn't start/);
  assert.equal(state.kind === 'failed' && state.canRetry, false, 'nothing to transcribe again');
});

test("a call that ended before its recording started says so, not Twilio's error", async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ record: true }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      { code: 21220, message: 'Requested resource is not eligible for recording', status: 400 },
      { status: 400 }
    )) as unknown as typeof fetch;
  try {
    await post(`/twilio/voice/after-notice?d=${DIAL_ID}`, { ParentCallSid: 'CA1' });
  } finally {
    globalThis.fetch = realFetch;
  }
  const state = recordingState((await dials.get(DIAL_ID))!, NOW_SEC + 60);
  assert.equal(
    state.kind === 'failed' ? state.message : '',
    'The call ended before the recording could start, so there’s nothing to transcribe.'
  );
});

test('an unrecorded call has no notice and no recording', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts());
  const xml = await (await post(`/twilio/voice/connect?d=${DIAL_ID}`, { Digits: '1' })).text();
  assert.doesNotMatch(xml, /record=|url=/);
  assert.equal(recordingState((await dials.get(DIAL_ID))!, NOW_SEC).kind, 'none');
});

test('transcribes both channels, summarises, and stores who said what', async () => {
  const ai = new FakeAi();
  const { deps, recordings } = await recordedCall(ai);
  assert.equal(await runTranscription(deps, DIAL_ID, { now: NOW, baseUrl: BASE }), 'done');

  assert.deepEqual(recordings, [{ sid: 'RE1', channels: 2 }]);
  const dial = (await dials.get(DIAL_ID))!;
  assert.deepEqual(JSON.parse(dial.transcript_json!), [
    { speaker: 'rep', start: 0.5, end: 0.8, text: 'Hi' },
    { speaker: 'prospect', start: 1.5, end: 2.5, text: 'Send a quote.' },
  ]);
  assert.equal(dial.summary, '- Wants a quote\n- Call back Monday');
  assert.equal(recordingState(dial, NOW_SEC).kind, 'done');

  assert.equal(await runTranscription(deps, DIAL_ID, { now: NOW, baseUrl: BASE }), 'skipped', 'never twice');
  assert.equal(ai.transcribed, 1);
});

test('a failed transcription can be retried; a failed summary keeps the transcript', async () => {
  const ai = new FakeAi();
  const { deps } = await recordedCall(ai);
  ai.failTranscribe = new Error('3036: daily free allocation used up');
  assert.equal(await runTranscription(deps, DIAL_ID, { now: NOW, baseUrl: BASE }), 'failed');
  const failed = recordingState((await dials.get(DIAL_ID))!, NOW_SEC);
  assert.deepEqual(failed, { kind: 'failed', message: '3036: daily free allocation used up', canRetry: true });

  ai.failTranscribe = null;
  ai.failSummary = true;
  assert.equal(await runTranscription(deps, DIAL_ID, { now: NOW, baseUrl: BASE }), 'done');
  const dial = (await dials.get(DIAL_ID))!;
  assert.equal(dial.summary, null);
  assert.ok(dial.transcript_json);
});

test('a transcript that lands after the call was logged is written onto that HubSpot call, once', async () => {
  const ai = new FakeAi();
  const { deps } = await recordedCall(ai);
  const dial = (await dials.get(DIAL_ID))!;
  await runCallLogged(
    hs,
    deps.callLogs,
    '1',
    { outcome: 'connected', notes: 'Good call', next: null, dial, transcript: null },
    LOG_OPTS
  );
  assert.doesNotMatch(hs.calls[0].call.bodyHtml, /Transcript/);

  await runTranscription(deps, DIAL_ID, { now: NOW, baseUrl: BASE });
  const patched = hs.objects.get('calls/call-1');
  assert.ok(patched, 'the logged call was updated');
  const body = patched.properties.hs_call_body!;
  assert.match(body, /Good call/);
  assert.match(body, /<li>Wants a quote<\/li>/);
  assert.match(body, /<strong>Prospect:<\/strong> Send a quote\./);
  assert.match(body, /href="https:\/\/app\.test\/calls\/1"/);
  assert.ok((await deps.callLogs.get('1'))?.transcript_synced_at);
});

test('a transcript that finished first goes into the call when it is logged', async () => {
  const ai = new FakeAi();
  const { deps } = await recordedCall(ai);
  await runTranscription(deps, DIAL_ID, { now: NOW, baseUrl: BASE });
  const dial = (await dials.get(DIAL_ID))!;
  const { dialTranscript } = await import('../src/lib/transcript.ts');
  await runCallLogged(
    hs,
    deps.callLogs,
    '1',
    { outcome: 'connected', notes: '', next: null, dial, transcript: dialTranscript(dial) },
    LOG_OPTS
  );
  assert.match(hs.calls[0].call.bodyHtml, /<strong>You:<\/strong> Hi/);
  assert.ok((await deps.callLogs.get('1'))?.transcript_synced_at);
});

test('recordingState waits for Twilio, then says when the recording never came', () => {
  const ended = {
    ...baseDial,
    record: 1,
    rep_status: 'completed',
    connected_at: 'x',
    prospect_status: 'completed',
    prospect_duration_sec: 60,
  };
  assert.equal(recordingState(ended, NOW_SEC + 90).kind, 'pending');
  assert.deepEqual(recordingState(ended, NOW_SEC + 60 + 11 * 60), {
    kind: 'failed',
    message: 'Twilio never sent the recording for this call.',
    canRetry: false,
  });
  assert.equal(
    recordingState({ ...ended, prospect_status: 'no-answer' }, NOW_SEC + 90).kind,
    'none',
    'nothing to record'
  );
  const unclaimed = { ...ended, recording_sid: 'RE1' };
  assert.equal(recordingState(unclaimed, NOW_SEC + 90).kind, 'pending', 'the background run gets a moment');
  assert.equal(recordingState(unclaimed, NOW_SEC + 60 + 5 * 60).kind, 'failed');
});

test('a HubSpot failure while adding the transcript keeps the transcript, and the next run finishes the write', async () => {
  const ai = new FakeAi();
  const { deps } = await recordedCall(ai);
  const dial = (await dials.get(DIAL_ID))!;
  await runCallLogged(
    hs,
    deps.callLogs,
    '1',
    { outcome: 'connected', notes: '', next: null, dial, transcript: null },
    LOG_OPTS
  );

  const realUpdate = hs.updateObject.bind(hs);
  hs.updateObject = async () => {
    throw new HubSpotApiError(502, 'gateway', '/crm/objects/2026-09/calls/call-1');
  };
  assert.equal(await runTranscription(deps, DIAL_ID, { now: NOW, baseUrl: BASE }), 'done');
  assert.equal((await deps.callLogs.get('1'))?.transcript_synced_at, null);

  hs.updateObject = realUpdate;
  assert.equal(await runTranscription(deps, DIAL_ID, { now: NOW, baseUrl: BASE }), 'skipped', 'not transcribed again');
  assert.equal(ai.transcribed, 1);
  assert.match(hs.objects.get('calls/call-1')!.properties.hs_call_body!, /Transcript/);
  assert.ok((await deps.callLogs.get('1'))?.transcript_synced_at);
});

test('a call log that stopped after completing the task still offers the form to finish it', async () => {
  const store = d1CallLogStore(db);
  hs.failNextCreate = true; // step 3 (the follow-up task) fails after step 2 completed the task
  await assert.rejects(
    runCallLogged(
      hs,
      store,
      '1',
      { outcome: 'no_answer', notes: '', next: { type: 'CALL', date: '2026-09-28' }, dial: null, transcript: null },
      LOG_OPTS
    ),
    /HubSpot 500/
  );
  const log = (await store.get('1'))!;
  assert.equal(hs.objects.get('tasks/1')!.properties.hs_task_status, 'COMPLETED');
  assert.equal(callLogDone(log), false);

  const render = async (logRow: typeof log) =>
    String(
      await callPage(
        {
          parties: {
            task: await hs.getObject('tasks', '1'),
            contact: await hs.getObject('contacts', '10'),
            company: await hs.getObject('companies', '20'),
          },
          dial: null,
          dialState: null,
          recordingState: null,
          log: logRow,
          lastEmail: null,
          context: EMPTY_CONTEXT,
          callScript: null,
          fromName: 'Anel Canto',
          scriptSaved: false,
          setup: {
            twilioReady: true,
            browserReady: false,
            callWith: 'phone',
            fromNumber: '+13852557051',
            repPhone: '+18085550199',
            whatsappOpens: 'app' as const,
            fromName: 'Anel Canto',
          },
          interviews: [],
          missedInterview: null,
          portalId: '1',
          now: NOW,
          timeZone: TZ,
          justLogged: false,
          nextCallId: null,
          callNow: false,
          coaching: { before: [], after: null },
        },
        'rep@example.com'
      )
    );
  const partial = await render(log);
  assert.match(partial, /action="\/calls\/1\/log"/, 'the log form is back');
  assert.match(partial, /An earlier attempt stopped partway/);

  // Finishing it completes the remaining steps; then the page says completed.
  await runCallLogged(
    hs,
    store,
    '1',
    { outcome: 'no_answer', notes: '', next: null, dial: null, transcript: null },
    LOG_OPTS
  );
  const finished = (await store.get('1'))!;
  assert.equal(callLogDone(finished), true);
  assert.equal(hs.created.length, 1, 'the follow-up was created on the retry');
  assert.doesNotMatch(await render(finished), /action="\/calls\/1\/log"/);
});

test('the log form waits briefly for the prospect leg after the rep hangs up', () => {
  const hungUp = { ...baseDial, connected_at: 'x', rep_status: 'completed', rep_ended_sec: NOW_SEC };
  assert.equal(dialState(hungUp, NOW_SEC + 5).kind, 'wrapping-up');
  assert.equal(dialState(hungUp, NOW_SEC + 25).kind, 'ended', 'gives up waiting after the grace');
  const reported = { ...hungUp, prospect_status: 'completed', prospect_duration_sec: 42 };
  assert.equal(dialState(reported, NOW_SEC + 5).kind, 'ended', "no wait once the prospect's leg is in");
});

test("the Calls list uses the contact's company when the task has none", async () => {
  hs.put('tasks', '7', { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED', hs_task_subject: 'Call Bo' });
  hs.put('contacts', '70', { firstname: 'Bo' });
  hs.put('companies', '71', { name: 'Bo Trucking', phone: '435-555-0180' });
  hs.link('tasks', '7', 'contacts', '70');
  hs.link('contacts', '70', 'companies', '71');

  const row = (await loadCallQueue(hs)).rows.find((r) => r.taskId === '7')!;
  assert.equal(row.companyName, 'Bo Trucking');
  assert.equal(row.phone, '+14355550180');
  assert.equal(row.fit, 'UNKNOWN');
});

test('logging is refused while the task has a call in progress (e.g. a stale form in another tab)', async () => {
  const { default: app } = await import('../src/index.ts');
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ now: Date.now() }));
  const res = await app.request(
    'http://localhost/calls/1/log',
    {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ outcome: 'no_answer', next_type: '' }),
    },
    {
      DB: db,
      DEV_BYPASS_ACCESS: 'true',
      TZ,
      HUBSPOT_ACCESS_TOKEN: 'unused',
      PUBLIC_BASE_URL: BASE,
    } as unknown as AppEnv['Bindings']
  );
  assert.equal(res.status, 409);
  assert.match(await res.text(), /still in progress/);
  assert.equal(await d1CallLogStore(db).get('1'), null, 'nothing logged');
});

test('while a call is live the page checks just its status, which says when the call is over', async () => {
  const { default: app } = await import('../src/index.ts');
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ now: Date.now() }));
  const status = async () => {
    const res = await app.request(`http://localhost/calls/1/dial/${DIAL_ID}/status`, {}, {
      DB: db,
      DEV_BYPASS_ACCESS: 'true',
      TZ,
      HUBSPOT_ACCESS_TOKEN: 'unused', // D1 only: no HubSpot request
      PUBLIC_BASE_URL: BASE,
    } as unknown as AppEnv['Bindings']);
    assert.equal(res.status, 200);
    return res.text();
  };

  const live = await status();
  assert.match(live, new RegExp(`<div id="dial-status" data-src="/calls/1/dial/${DIAL_ID}/status" data-live>`));
  assert.match(live, /Ringing your phone/);

  await db.prepare(`UPDATE dials SET rep_status = 'completed' WHERE id = ?`).bind(DIAL_ID).run();
  const over = await status();
  assert.doesNotMatch(over, /data-live/, 'the page reloads once, to show the log form');
  assert.match(over, /hung up before pressing 1/);
});

// --- calling from the browser ---

const BROWSER = { mode: 'browser' as const, repNumber: null };

test('a browser dial rings nothing: it records the dial for the page to start', async () => {
  const dial = await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts(BROWSER));
  assert.equal(twilio.calls.length, 0);
  assert.deepEqual([dial.mode, dial.rep_number, dial.rep_call_sid], ['browser', 'browser', null]);
  assert.equal(dial.to_number, '+13855550100', 'the number still comes from HubSpot');
  assert.deepEqual(dialState(dial, NOW_SEC + 5), { kind: 'ringing-rep' });
  await assert.rejects(
    startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ ...BROWSER, newId: () => 'e'.repeat(32) })),
    /already ringing or in progress/
  );
});

test('the browser call dials the prospect once, and only for a fresh browser dial', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ ...BROWSER, now: Date.now() }));

  const forged = await post('/twilio/voice/client', { d: DIAL_ID, CallSid: 'CA9' }, 'forged');
  assert.equal(forged.status, 403);

  const xml = await (await post('/twilio/voice/client', { d: DIAL_ID, CallSid: 'CA9' })).text();
  assert.match(xml, /<Dial callerId="\+13852557051"/);
  assert.match(xml, /\+13855550100<\/Number>/);
  assert.doesNotMatch(xml, /notice/, 'no recording notice on an unrecorded call');
  const dial = (await dials.get(DIAL_ID))!;
  assert.equal(dial.rep_call_sid, 'CA9');
  assert.ok(dial.connected_at);

  const again = await (await post('/twilio/voice/client', { d: DIAL_ID, CallSid: 'CA10' })).text();
  assert.doesNotMatch(again, /<Dial/, 'a second call on the same dial is refused');
  assert.equal((await dials.get(DIAL_ID))?.rep_call_sid, 'CA9');

  const unknown = await (await post('/twilio/voice/client', { d: 'f'.repeat(32), CallSid: 'CA11' })).text();
  assert.match(unknown, /expired.*<Hangup\/>/);
});

test('the browser webhook refuses phone dials, stale dials and cancelled ones', async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ now: Date.now() }));
  const phone = await (await post('/twilio/voice/client', { d: DIAL_ID, CallSid: 'CA9' })).text();
  assert.doesNotMatch(phone, /<Dial/, 'a phone dial waits for the rep to press 1');
  await dials.setRepStatus(DIAL_ID, 'completed');

  const stale = 'a'.repeat(32);
  await startDial(
    { hs, twilio, dials },
    '1',
    'phone',
    dialOpts({ ...BROWSER, now: Date.now() - 130_000, newId: () => stale })
  );
  assert.doesNotMatch(await (await post('/twilio/voice/client', { d: stale, CallSid: 'CA12' })).text(), /<Dial/);

  const cancelled = 'b'.repeat(32);
  await dials.setRepStatus(stale, 'canceled');
  await startDial(
    { hs, twilio, dials },
    '1',
    'phone',
    dialOpts({ ...BROWSER, now: Date.now(), newId: () => cancelled })
  );
  await dials.endBrowserCall(cancelled, Math.floor(Date.now() / 1000));
  assert.doesNotMatch(await (await post('/twilio/voice/client', { d: cancelled, CallSid: 'CA13' })).text(), /<Dial/);
  const summary = dialState((await dials.get(cancelled))!, Math.floor(Date.now() / 1000));
  assert.match(summary.kind === 'ended' ? summary.summary : summary.kind, /didn’t start in the browser/);
});

test("the page ending a connected browser call ends the dial, and Twilio's status still wins", async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ ...BROWSER, now: Date.now() }));
  await post('/twilio/voice/client', { d: DIAL_ID, CallSid: 'CA9' });
  const nowSec = Math.floor(Date.now() / 1000);
  await dials.endBrowserCall(DIAL_ID, nowSec);
  const ended = (await dials.get(DIAL_ID))!;
  assert.deepEqual([ended.rep_status, ended.rep_ended_sec], ['completed', nowSec]);
  assert.deepEqual(dialState(ended, nowSec + 1), { kind: 'wrapping-up' }, 'not shown as on the call');
  await post('/twilio/voice/client-status', { CallSid: 'CA9', CallStatus: 'failed' });
  assert.equal((await dials.get(DIAL_ID))?.rep_status, 'failed');
  await dials.endBrowserCall(DIAL_ID, nowSec + 5);
  assert.equal((await dials.get(DIAL_ID))?.rep_status, 'failed', 'a later end from the page changes nothing');
});

test("a recorded browser call plays the notice, and records the browser's leg after it", async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ ...BROWSER, now: Date.now(), record: true }));
  const xml = await (await post('/twilio/voice/client', { d: DIAL_ID, CallSid: 'CA9' })).text();
  assert.match(xml, /url="https:\/\/app\.test\/twilio\/voice\/notice\?d=d{32}"/);
});

test("the TwiML App's status callback ends the browser call by its sid", async () => {
  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ ...BROWSER, now: Date.now() }));
  await post('/twilio/voice/client', { d: DIAL_ID, CallSid: 'CA9' });
  const ringing = await post('/twilio/voice/client-status', { CallSid: 'CA9', CallStatus: 'ringing' });
  assert.equal(ringing.status, 204);
  assert.equal((await dials.get(DIAL_ID))?.rep_status, null, 'only final statuses count');
  await post('/twilio/voice/client-status', { CallSid: 'CA9', CallStatus: 'completed' });
  const dial = (await dials.get(DIAL_ID))!;
  assert.equal(dial.rep_status, 'completed');
  assert.ok(dial.rep_ended_sec);
});

test('the call page answers with JSON when browser calling is chosen but not set up, and can end a dial', async () => {
  const { default: app } = await import('../src/index.ts');
  const { setSetting } = await import('../src/lib/db.ts');
  await setSetting(db, 'call_with', 'browser');
  const env = {
    DB: db,
    DEV_BYPASS_ACCESS: 'true',
    TZ,
    HUBSPOT_ACCESS_TOKEN: 'unused',
    PUBLIC_BASE_URL: BASE,
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'tok',
  } as unknown as AppEnv['Bindings'];
  const request = (path: string, body: Record<string, string> = {}) =>
    app.request(
      `http://localhost${path}`,
      {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      },
      env
    );

  const res = await request('/calls/1/dial', { field: 'phone' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /isn’t set up on this Worker/);
  assert.equal(await dials.latestForTask('1'), null, 'no dial recorded');

  await startDial({ hs, twilio, dials }, '1', 'phone', dialOpts({ ...BROWSER, now: Date.now() }));
  assert.equal((await request(`/calls/1/dial/${DIAL_ID}/end`)).status, 204);
  assert.equal((await dials.get(DIAL_ID))?.rep_status, 'canceled');
  assert.equal((await request(`/calls/2/dial/${DIAL_ID}/end`)).status, 404, 'only for its own task');
});

// --- Call page context: the script, who they are, their HubSpot history ---

async function pageState(overrides: Partial<CallPageState> = {}): Promise<CallPageState> {
  return {
    parties: {
      task: await hs.getObject('tasks', '1'),
      contact: await hs.getObject('contacts', '10'),
      company: await hs.getObject('companies', '20'),
    },
    dial: null,
    dialState: null,
    recordingState: null,
    log: null,
    lastEmail: null,
    context: EMPTY_CONTEXT,
    callScript: 'Hi {first_name}, this is {my_name}. How does {company} handle {mystery} today?',
    fromName: 'Anel Canto',
    scriptSaved: false,
    setup: {
      twilioReady: true,
      browserReady: false,
      callWith: 'phone',
      fromNumber: '+13852557051',
      repPhone: '+18085550199',
      whatsappOpens: 'app' as const,
      fromName: 'Anel Canto',
    },
    interviews: [],
    missedInterview: null,
    portalId: '1',
    now: NOW,
    timeZone: TZ,
    coaching: { before: [], after: null },
    ...overrides,
  };
}

test('the call page shows the filled-in script first, with its editor', async () => {
  const page = String(await callPage(await pageState(), 'rep@example.com'));
  assert.match(page, /Hi Ana, this is Anel Canto\. How does Acme handle \{mystery\} today\?/);
  assert.ok(page.indexOf('Call script') < page.indexOf('<h2>Numbers</h2>'), 'the script comes before the numbers');
  assert.match(page, /action="\/calls\/1\/script"/);
  assert.match(page, />Hi \{first_name\}, this is \{my_name\}/, 'the editor holds the raw template');
});

test('with no script yet the editor starts open; during a live call it is hidden', async () => {
  const empty = String(await callPage(await pageState({ callScript: null }), 'rep@example.com'));
  assert.match(empty, /No call script yet/);
  assert.match(empty, /<details id="script-edit" open>/);

  const live = String(
    await callPage(await pageState({ dial: baseDial, dialState: { kind: 'on-call' } }), 'rep@example.com')
  );
  assert.match(live, /Hi Ana, this is Anel Canto/, 'the script stays readable on the call');
  assert.doesNotMatch(live, /action="\/calls\/1\/script"/);
});

test('browser calling gets a dial pad for phone menus; a phone call uses the phone keypad', async () => {
  const setup = { ...(await pageState()).setup, callWith: 'browser' as const, browserReady: true };
  const browser = String(await callPage(await pageState({ setup }), 'rep@example.com'));
  assert.match(browser, /aria-label="Dial pad"/);
  for (const key of ['1', '0', '*', '#']) assert.ok(browser.includes(`data-key="${key}"`), key);
  assert.match(browser, /call\.sendDigits\(key\)/);
  assert.match(browser, /class="card call-dock" id="browser-call"/, 'the controls dock over the page');
  assert.match(browser, /data-keypad-toggle/);

  const phone = String(await callPage(await pageState(), 'rep@example.com'));
  assert.doesNotMatch(phone, /Dial pad/);
  assert.doesNotMatch(phone, /call-dock"/);
  assert.match(phone, /keypad works for their phone menu/);
});

test('opened from the queue with Call, the page presses Call for its first number, once', async () => {
  assert.equal(callNowHref('1'), '/calls/1?call=1');
  const now = String(await callPage(await pageState({ callNow: true }), 'rep@example.com'));
  assert.match(now, /requestSubmit/);
  assert.match(now, /searchParams\.delete\('call'\)/, 'the query goes before dialling, so a reload never calls again');
  const setup = { ...(await pageState()).setup, callWith: 'browser' as const, browserReady: true };
  const browser = String(await callPage(await pageState({ setup, callNow: true }), 'rep@example.com'));
  assert.ok(
    browser.indexOf('requestSubmit') > browser.indexOf('form[data-browser-call]'),
    'after the browser call handler'
  );

  const opened = String(await callPage(await pageState(), 'rep@example.com'));
  assert.doesNotMatch(opened, /requestSubmit/, 'Open only opens');
  const live = String(
    await callPage(
      await pageState({ callNow: true, dial: baseDial, dialState: { kind: 'on-call' } }),
      'rep@example.com'
    )
  );
  assert.doesNotMatch(live, /requestSubmit/, 'never a second call while one is live');
  assert.match(
    live,
    /searchParams\.delete\('call'\)/,
    'the query still goes, so the reload when the live call ends does not dial'
  );
  const notSetUp = { ...(await pageState()).setup, fromNumber: null };
  const blocked = String(await callPage(await pageState({ setup: notSetUp, callNow: true }), 'rep@example.com'));
  assert.doesNotMatch(blocked, /requestSubmit/);
  assert.match(blocked, /searchParams\.delete\('call'\)/);
});

test('an extension in HubSpot is shown next to the number it belongs to', async () => {
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Díaz', phone: '(385) 555-0100 x204', mobilephone: 'n/a' });
  const page = String(await callPage(await pageState(), 'rep@example.com'));
  assert.match(page, /\+1 385-555-0100<\/strong> <span class="muted">ext\. 204, dialled for you<\/span>/);
  // The edit form splits it back into the number and its extension.
  assert.match(page, /name="phone" value="\+1 385-555-0100"/);
  assert.match(page, /name="phone_ext" value="204"/);
  assert.match(page, /name="phone_was" value="\(385\) 555-0100 x204"/);
  assert.match(page, /<form id="numbers-form" method="post" action="\/calls\/1\/numbers"/);
});

test('the script is escaped, not rendered as HTML', async () => {
  const page = String(await callPage(await pageState({ callScript: '<b>{first_name}</b>' }), 'rep@example.com'));
  assert.match(page, /&lt;b&gt;Ana&lt;\/b&gt;/);
});

test('call context: notes, calls and emails, newest first, capped per kind', async () => {
  hs.put('notes', 'n1', {
    hs_note_body: '<p>Prep: ask about <b>fleet size</b></p>',
    hs_timestamp: '2026-09-20T12:00:00Z',
  });
  hs.link('contacts', '10', 'notes', 'n1');
  hs.put('calls', 'c1', {
    hs_call_title: 'Call with Ana',
    hs_call_body: '<p>Left a voicemail</p>',
    hs_call_disposition: 'b2cf5968-551e-4856-9783-52b3da59a7d0',
    hs_call_direction: 'OUTBOUND',
    hs_call_duration: '65000',
    hs_timestamp: '2026-09-22T12:00:00Z',
  });
  hs.link('contacts', '10', 'calls', 'c1');
  for (let i = 1; i <= 12; i++) {
    const day = String(i).padStart(2, '0');
    hs.put('emails', `e${i}`, {
      hs_email_subject: `Email ${i}`,
      hs_email_direction: i === 12 ? 'INCOMING_EMAIL' : 'EMAIL',
      hs_email_text: 'x'.repeat(400),
      hs_timestamp: `2026-09-${day}T12:00:00Z`,
    });
    hs.link('contacts', '10', 'emails', `e${i}`);
  }

  const parties = {
    task: await hs.getObject('tasks', '1'),
    contact: await hs.getObject('contacts', '10'),
    company: await hs.getObject('companies', '20'),
  };
  const ctx = await loadCallContext(hs, parties);

  assert.equal(ctx.notes.items[0].text, 'Prep: ask about fleet size');
  assert.deepEqual(
    { title: ctx.calls.items[0].title, detail: ctx.calls.items[0].detail, text: ctx.calls.items[0].text },
    { title: 'Call with Ana', detail: 'Outbound · Left voicemail · 1:05', text: 'Left a voicemail' }
  );
  assert.equal(ctx.emails.items.length, 10, 'ten emails at most');
  assert.equal(ctx.emails.items[0].title, 'Email 12');
  assert.equal(ctx.emails.items[0].detail, 'Received');
  assert.ok(ctx.emails.items[0].text.length <= 301 && ctx.emails.items[0].text.endsWith('…'));
  assert.equal(ctx.emails.items[0].fullText, 'x'.repeat(400), 'the whole email, for the page to open');
  assert.equal(ctx.calls.items[0].fullText, null, 'nothing more when nothing was cut');

  const timeline = historyTimeline(ctx);
  assert.deepEqual(
    timeline.slice(0, 4).map((i) => i.id),
    ['c1', 'n1', 'e12', 'e11'],
    'all kinds in one timeline, newest first'
  );
});

test('call context: one kind failing leaves the others, and the page says which', async () => {
  hs.put('notes', 'n1', { hs_note_body: 'Knows our CTO', hs_timestamp: '2026-09-20T12:00:00Z' });
  hs.link('contacts', '10', 'notes', 'n1');
  hs.link('contacts', '10', 'emails', 'e1');
  const realBatchRead = hs.batchRead.bind(hs);
  hs.batchRead = async (type, ids) => {
    if (type === 'emails') {
      const body = JSON.stringify({
        category: 'MISSING_SCOPES',
        errors: [{ context: { requiredGranularScopes: ['crm.objects.emails.read', 'sales-email-read'] } }],
      });
      throw new HubSpotApiError(403, body, '/crm/objects/2026-09/emails/batch/read');
    }
    return realBatchRead(type, ids);
  };
  const parties = {
    task: await hs.getObject('tasks', '1'),
    contact: await hs.getObject('contacts', '10'),
    company: await hs.getObject('companies', '20'),
  };
  const context = await loadCallContext(hs, parties);
  assert.equal(context.emails.failed, true);
  assert.deepEqual(context.emails.missingScopes, ['crm.objects.emails.read', 'sales-email-read']);
  assert.equal(context.notes.items.length, 1);

  const page = String(await callPage(await pageState({ context }), 'rep@example.com'));
  assert.match(page, /Knows our CTO/);
  assert.match(page, /Couldn't load emails from HubSpot: the HubSpot app is missing the scope/);
  assert.match(page, /<code>crm\.objects\.emails\.read<\/code> or <code>sales-email-read<\/code>/);
});

test('a clipped history item opens to its whole text, a short one shows as is', async () => {
  const transcript = `Summary\n${'Rep: How do you dispatch? Drew: By phone. '.repeat(30)}Drew: Call me at 9.`;
  hs.put('calls', 'c1', {
    hs_call_title: 'Call with Drew',
    hs_call_body: transcript,
    hs_timestamp: '2026-09-24T18:32:00Z',
  });
  hs.link('contacts', '10', 'calls', 'c1');
  hs.put('notes', 'n1', { hs_note_body: 'Knows our CTO', hs_timestamp: '2026-09-20T12:00:00Z' });
  hs.link('contacts', '10', 'notes', 'n1');
  const parties = {
    task: await hs.getObject('tasks', '1'),
    contact: await hs.getObject('contacts', '10'),
    company: await hs.getObject('companies', '20'),
  };
  const context = await loadCallContext(hs, parties);
  const page = String(await callPage(await pageState({ context }), 'rep@example.com'));
  assert.match(page, /<details class="clipped">\s*<summary><pre>Summary\n[^<]*…<\/pre>/);
  assert.match(page, /<span class="more">Show all<\/span>/);
  assert.ok(page.includes('Drew: Call me at 9.</pre>'), 'the end of the call is on the page');
  assert.match(page, /<pre>Knows our CTO<\/pre>/);
  assert.equal(page.match(/<details class="clipped">/g)?.length, 1, 'only the clipped item opens');
});

test('placeholders stay as written when the contact or company has no name', async () => {
  hs.put('contacts', '10', { email: 'ana@acme.test', phone: '(385) 555-0100' });
  const page = String(
    await callPage(
      await pageState({
        parties: {
          task: await hs.getObject('tasks', '1'),
          contact: await hs.getObject('contacts', '10'),
          company: null,
        },
        callScript: 'Hi {name} from {company}',
      }),
      'rep@example.com'
    )
  );
  assert.match(page, /<pre class="script">Hi \{name\} from \{company\}<\/pre>/);
});

test('associatedIds follows the paging cursor to the last page', async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return url.includes('after=')
      ? Response.json({ results: [{ toObjectId: 3 }] })
      : Response.json({ results: [{ toObjectId: 1 }, { toObjectId: '2' }], paging: { next: { after: 'MjAw' } } });
  }) as unknown as typeof fetch;
  try {
    assert.deepEqual(await createHubSpot('token').associatedIds('contacts', '10', 'emails'), ['1', '2', '3']);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(urls.length, 2);
  assert.match(urls[1], /\/crm\/objects\/2026-09\/contacts\/10\/associations\/emails\?limit=500&after=MjAw$/);
});

test('booking on the call page defaults to a phone call on the contact’s number', async () => {
  const page = String(await callPage(await pageState(), 'rep@example.com'));
  assert.match(page, /name="book_format" value="phone" checked \/> Phone call: you call them at \+1 /);
  assert.match(page, /data-video-only/, 'the join link is only for a video call');

  hs.objects.get('contacts/10')!.properties.phone = null;
  hs.objects.get('contacts/10')!.properties.mobilephone = null;
  hs.objects.get('companies/20')!.properties.phone = null;
  const none = String(await callPage(await pageState(), 'rep@example.com'));
  assert.match(none, /value="phone" disabled \/> Phone call <span class="muted">\(no phone number in HubSpot\)/);
  assert.match(none, /value="video" checked/);
});

test('after a missed interview the call page offers the last-try email', async () => {
  const missedInterview = {
    meetingId: 'm9',
    title: 'Interview: Acme (Ana)',
    startAt: NOW - 86_400_000,
    endAt: NOW - 84_600_000,
    outcome: 'NO_SHOW' as const,
    joinUrl: null,
    contactId: '10',
    contactName: null,
    companyName: null,
    phoneCall: true,
    phone: null,
  };
  const page = String(await callPage(await pageState({ missedInterview }), 'rep@example.com'));
  assert.match(page, /missed <a href="\/meetings\/m9">their interview<\/a>/);
  assert.match(page, /<option value="EMAIL_LAST" selected>/);
  assert.match(page, /<option value="CALL" >Call again/);

  const usual = String(await callPage(await pageState(), 'rep@example.com'));
  assert.match(usual, /<option value="CALL" selected>Call again/);
});

test('every booking input on the call page reaches the booking parser', async () => {
  const page = String(await callPage(await pageState(), 'rep@example.com'));
  const names = new Set([...page.matchAll(/name="(book_[a-z_]+)"/g)].map((m) => m[1]));
  assert.ok(names.has('book_format'), 'the page asks phone or video');
  for (const name of names) {
    assert.ok((BOOKING_FIELDS as readonly string[]).includes(name), `${name} is passed on by the routes`);
  }
  const form = Object.fromEntries(
    [...names].map((n) => [n, { book_date: '2026-09-28', book_time: '09:00', book_format: 'phone' }[n] ?? ''])
  );
  const input = parseBookingForm(
    bookingFieldsOf((key) => form[key]),
    '2026-09-25'
  );
  assert.equal(input.byPhone, true);
});

// --- WhatsApp (the rep's own, through click-to-chat) ---

test('parseCallLogForm: a WhatsApp message has its own outcomes and needs the message', () => {
  const today = '2026-09-25';
  const message = { channel: 'whatsapp_message', outcome: 'sent', notes: 'Hi Ana', whatsapp_field: 'phone' };
  assert.deepEqual(parseCallLogForm(message, today), {
    channel: 'whatsapp_message',
    outcome: 'sent',
    notes: 'Hi Ana',
    whatsappField: 'phone',
    next: null,
    booking: null,
  });
  assert.equal(parseCallLogForm({ ...message, whatsapp_field: '' }, today).whatsappField, 'mobilephone');
  assert.throws(() => parseCallLogForm({ ...message, outcome: 'connected' }, today), /how the message went/);
  assert.throws(() => parseCallLogForm({ ...message, notes: ' ' }, today), /message you sent/);
  assert.throws(() => parseCallLogForm({ ...message, whatsapp_field: 'company' }, today), /Unknown WhatsApp/);
  assert.throws(() => parseCallLogForm({ ...message, channel: 'telegram' }, today), /how you reached them/);
  assert.throws(() => parseCallLogForm({ channel: 'whatsapp_call', outcome: 'sent' }, today), /Pick an outcome/);
  assert.equal(parseCallLogForm({ channel: 'whatsapp_call', outcome: 'connected' }, today).channel, 'whatsapp_call');
});

test('a WhatsApp message goes on the timeline as a message, not a call, and only once', async () => {
  const store = d1CallLogStore(db);
  const input = {
    channel: 'whatsapp_message' as const,
    whatsappField: 'phone' as const,
    outcome: 'sent' as const,
    notes: 'Hi Ana, this is Anel.',
    next: { type: 'CALL' as const, date: '2026-09-28' },
    booking: null,
    dial: dialed, // a dial left on the page isn't this message's
    transcript: null,
  };
  hs.failNextCreate = true; // the follow-up fails after the message landed
  await assert.rejects(runCallLogged(hs, store, '1', input, LOG_OPTS));
  const result = await runCallLogged(hs, store, '1', input, LOG_OPTS);

  assert.equal(hs.calls.length, 0, 'no call');
  assert.equal(hs.messages.length, 1, 'one message, even across the retry');
  const { message, links } = hs.messages[0];
  assert.equal(message.channel, 'WHATS_APP');
  assert.equal(message.ownerId, '77');
  assert.deepEqual(links, { contactId: '10', companyId: '20' });
  assert.match(message.bodyHtml, /Hi Ana, this is Anel\./);
  assert.match(message.bodyHtml, /Sent, no reply yet\. Sent on WhatsApp/);
  assert.equal(result.loggedMessageId, 'message-1');
  assert.equal(result.loggedCallId, null);
  assert.ok(result.nextTaskId, 'the follow-up was created on the retry');
  assert.equal(hs.objects.get('contacts/10')!.properties.hs_lead_status, 'ATTEMPTED_TO_CONTACT');

  const row = (await store.get('1'))!;
  assert.equal(row.title, 'WhatsApp message to Ana Díaz (Acme)');
  assert.equal(row.to_number, '+13855550100', 'the WhatsApp number, as E.164');
  assert.equal(row.dial_id, null);
  assert.ok(callLogDone(row));
});

test('a HubSpot 4xx on the WhatsApp message lets the retry log it', async () => {
  const store = d1CallLogStore(db);
  const input = {
    channel: 'whatsapp_message' as const,
    whatsappField: 'phone' as const,
    outcome: 'replied' as const,
    notes: 'Hi',
    next: null,
    booking: null,
    dial: null,
    transcript: null,
  };
  hs.failNextLogMessage = new HubSpotApiError(400, 'bad', '/crm/objects/2026-09/communications');
  await assert.rejects(runCallLogged(hs, store, '1', input, LOG_OPTS), /HubSpot API 400/);
  await runCallLogged(hs, store, '1', input, LOG_OPTS);
  assert.equal(hs.messages.length, 1);
  assert.equal(hs.objects.get('contacts/10')!.properties.hs_lead_status, 'CONNECTED', 'they replied');
});

test('a WhatsApp call is logged as a call, titled so, without a Twilio dial’s numbers', async () => {
  const store = d1CallLogStore(db);
  await runCallLogged(
    hs,
    store,
    '1',
    {
      channel: 'whatsapp_call',
      whatsappField: 'phone',
      outcome: 'connected',
      notes: 'Talked 10 minutes',
      next: null,
      booking: null,
      dial: dialed,
      transcript: null,
    },
    LOG_OPTS
  );
  assert.equal(hs.messages.length, 0);
  const { call } = hs.calls[0];
  assert.equal(call.title, 'WhatsApp call with Ana Díaz (Acme)');
  assert.equal(call.durationMs, null);
  assert.deepEqual([call.fromNumber, call.toNumber], [null, '+13855550100']);
  assert.match(call.bodyHtml, /Called on WhatsApp, logged from Causeway\./);
});

test('WhatsApp is refused for a number it can’t reach', async () => {
  const input = {
    channel: 'whatsapp_message' as const,
    whatsappField: 'mobilephone' as const, // 'n/a' in HubSpot
    outcome: 'sent' as const,
    notes: 'Hi',
    next: null,
    booking: null,
    dial: null,
    transcript: null,
  };
  await assert.rejects(runCallLogged(hs, d1CallLogStore(db), '1', input, LOG_OPTS), /isn’t one WhatsApp can reach/);
  assert.equal(await d1CallLogStore(db).get('1'), null, 'nothing recorded');
});

test('the call page offers WhatsApp on the contact’s numbers, and the log form asks how they were reached', async () => {
  const page = String(await callPage(await pageState(), 'rep@example.com'));
  const links = [...page.matchAll(/href="(whatsapp:[^"]+)"[^>]*data-whatsapp="(\w+)"/g)];
  assert.equal(links.length, 1, 'the contact’s phone only: not "n/a", not the company line');
  assert.match(links[0][1], /^whatsapp:\/\/send\?phone=13855550100&amp;text=Hi%20Ana%2C%20this%20is%20Anel\./);
  assert.equal(links[0][2], 'phone');
  assert.match(page, /<select id="channel" name="channel">/);
  assert.match(page, /<input type="hidden" name="whatsapp_field" value="phone" \/>/);
  assert.match(page, /<optgroup label="WhatsApp message" data-channel="message" hidden disabled>/);

  const web = { ...(await pageState()).setup, whatsappOpens: 'web' as const };
  assert.match(
    String(await callPage(await pageState({ setup: web }), 'rep@example.com')),
    /href="https:\/\/web\.whatsapp\.com\/send\?phone=13855550100[^"]*" target="_blank"/
  );

  hs.put('contacts', '10', { firstname: 'Ana', phone: '385.555.0100 x12' });
  const office = String(await callPage(await pageState(), 'rep@example.com'));
  assert.doesNotMatch(office, /data-whatsapp=/, 'no WhatsApp for an office line');
  assert.doesNotMatch(office, /name="channel"/);
});

test('late in the day the WhatsApp button warns about the hours', async () => {
  const late = Date.parse('2026-09-26T02:00:00Z'); // 21:00 in Panama
  assert.match(String(await callPage(await pageState({ now: late }), 'rep@example.com')), /outside 8am to 8pm/);
  assert.doesNotMatch(String(await callPage(await pageState(), 'rep@example.com')), /outside 8am to 8pm/);
});

test('the log form offers a real conversation on a connect, ticked after a long one', async () => {
  const box = (page: string) =>
    /<input type="checkbox" id="conversation" name="conversation" value="1" ?(checked)? \/>/.exec(page);
  const short = String(await callPage(await pageState(), 'rep@example.com'));
  assert.ok(box(short), 'the box is there');
  assert.equal(box(short)![1], undefined, 'not ticked without a long call');
  assert.match(short, /data-outcomes="connected replied"/);
  const long = { ...baseDial, prospect_status: 'completed', prospect_duration_sec: 543 };
  const ticked = String(
    await callPage(await pageState({ dial: long, dialState: { kind: 'ended' } as never }), 'rep@example.com')
  );
  assert.equal(box(ticked)?.[1], 'checked');
});

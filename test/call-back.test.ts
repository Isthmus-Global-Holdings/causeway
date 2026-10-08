// Calling back someone who rang the Twilio number, from its Inbound page: the
// workflow against the real SQL on SQLite, a fake HubSpot and a fake Twilio,
// the webhooks on a real Hono app with requests signed the way Twilio signs
// them, and the page.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import {
  d1CallLogStore,
  d1DialStore,
  d1InboundCallStore,
  type DialStore,
  type InboundCallStore,
} from '../src/lib/db.ts';
import { HubSpotApiError } from '../src/lib/hubspot.ts';
import type { NewCall, Twilio } from '../src/lib/twilio.ts';
import { twilioRoute } from '../src/routes/twilio.ts';
import type { AppEnv } from '../src/types.ts';
import { inboundCallPage, type InboundCallPageState } from '../src/views/inbound.ts';
import { callBackFrom, logCallBack, startCallBack } from '../src/workflows/call-back.ts';
import { dialState, type DialOptions } from '../src/workflows/dial.ts';
import { inboundRecordingState, startInbound } from '../src/workflows/inbound.ts';
import { recordingState, runTranscription, type Transcriber } from '../src/workflows/transcribe.ts';
import { FakeHubSpot } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const NOW_SEC = NOW / 1000;
const BASE = 'https://app.test';
const INBOUND_ID = 'a'.repeat(32);
const DIAL_ID = 'd'.repeat(32);
const OPTS = { now: NOW, baseUrl: BASE };

class FakeTwilio implements Twilio {
  calls: NewCall[] = [];
  voice = ['+13852557051', '+13852550000'];
  listFails = false;
  async listNumbers() {
    if (this.listFails) throw new Error('Twilio 503');
    return { voice: this.voice.map((phoneNumber) => ({ phoneNumber, friendlyName: phoneNumber })), verified: [] };
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

let db: D1Database;
let dials: DialStore;
let calls: InboundCallStore;
let hs: FakeHubSpot;
let twilio: FakeTwilio;

beforeEach(() => {
  db = sqliteD1();
  dials = d1DialStore(db);
  calls = d1InboundCallStore(db);
  hs = new FakeHubSpot();
  twilio = new FakeTwilio();
  hs.put('contacts', '10', { firstname: 'Jesse', lastname: 'Ferris', phone: '801-555-0164', hubspot_owner_id: '77' });
  hs.put('companies', '20', { name: 'Ferris Freight' });
  hs.link('contacts', '10', 'companies', '20');
});

const dialOpts = (overrides: Partial<DialOptions> = {}): DialOptions => ({
  now: NOW + 60_000,
  baseUrl: BASE,
  fromNumber: '+13852557051',
  mode: 'phone',
  repNumber: '+18085550142',
  record: false,
  newId: () => DIAL_ID,
  ...overrides,
});

async function inbound(from = '+18015550164') {
  const call = await startInbound(
    { hs, calls },
    {
      callSid: 'CA-in',
      from,
      to: '+13852557051',
      repNumber: '+18085550142',
      record: false,
      now: NOW,
      newId: () => INBOUND_ID,
    }
  );
  await calls.setStatus(call.id, 'completed', NOW_SEC + 20);
  return (await calls.get(call.id))!;
}

// --- dialling them back ---

test('calls back the number Twilio reported, ringing the rep first, from the Twilio number', async () => {
  await inbound();
  const dial = await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts());
  assert.equal(dial.subject, 'inbound');
  assert.equal(dial.task_id, INBOUND_ID);
  assert.equal(dial.to_number, '+18015550164');
  assert.equal(dial.contact_id, '10');
  assert.equal(dial.contact_label, 'Jesse Ferris at Ferris Freight');
  assert.equal(twilio.calls.length, 1);
  assert.equal(twilio.calls[0].to, '+18085550142', 'the rep’s phone rings first');
  assert.equal(twilio.calls[0].from, '+13852557051');

  await assert.rejects(
    startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts({ newId: () => 'e'.repeat(32) })),
    /already ringing/,
    'a double click rings the rep once'
  );
});

test('a call back shows the number they called, while it is still one of the account’s', async () => {
  await inbound();
  await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts({ fromNumber: '+13852550000' }));
  assert.equal(twilio.calls[0].from, '+13852557051', 'the number they called, not the one now in Settings');
  assert.equal((await dials.get(DIAL_ID))?.from_number, '+13852557051');

  twilio.voice = ['+13852550000'];
  assert.equal(await callBackFrom(twilio, '+13852557051', '+13852550000'), '+13852550000', 'released since');
  twilio.listFails = true;
  assert.equal(await callBackFrom(twilio, '+13852557051', '+13852550000'), '+13852550000', 'Twilio down');
});

test('a caller not in HubSpot can be called back; a hidden number cannot', async () => {
  await inbound('+13855550171');
  const dial = await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts({ mode: 'browser' }));
  assert.equal(dial.contact_id, '');
  assert.equal(dial.contact_label, '+1 385-555-0171');
  assert.equal(twilio.calls.length, 0, 'a browser call rings nothing');

  db = sqliteD1();
  dials = d1DialStore(db);
  calls = d1InboundCallStore(db);
  await inbound('anonymous');
  await assert.rejects(startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts()), /hidden number/);
  await assert.rejects(startCallBack({ twilio, dials, calls }, 'f'.repeat(32), dialOpts()), /isn’t in the app/);
});

// --- logging it on the contact ---

async function calledBack(status: string, durationSec: number | null) {
  await inbound();
  await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts());
  await dials.markConnected(DIAL_ID, 'x');
  await dials.setProspectResult(DIAL_ID, { sid: 'CA-out', status, durationSec });
}

test('a call back to a contact is logged on them as an outbound call, once', async () => {
  await calledBack('completed', 125);
  assert.equal(await logCallBack(hs, { dials, calls }, DIAL_ID, OPTS), 'call-1');
  const { call, links } = hs.calls[0];
  assert.equal(call.title, 'Call back to Jesse Ferris at Ferris Freight');
  assert.equal(call.direction, 'OUTBOUND');
  assert.equal(call.status, 'COMPLETED');
  assert.equal(call.durationMs, 125_000);
  assert.equal(call.toNumber, '+18015550164');
  assert.equal(call.ownerId, '77');
  assert.deepEqual(links, { contactId: '10', companyId: '20' });
  assert.match(call.bodyHtml, /They picked up.*Call length 2m 05s\. Called back from Causeway/);
  assert.match(call.bodyHtml, new RegExp(`/inbound/${INBOUND_ID}`));

  assert.equal(await logCallBack(hs, { dials, calls }, DIAL_ID, OPTS), null);
  assert.equal(hs.calls.length, 1);
});

test('a busy line or no answer is logged as such', async () => {
  await calledBack('busy', null);
  await logCallBack(hs, { dials, calls }, DIAL_ID, OPTS);
  assert.equal(hs.calls[0].call.status, 'BUSY');
  assert.equal(hs.calls[0].call.durationMs, null);
});

test('nothing is logged before they were dialled, or for a caller not in HubSpot', async () => {
  await inbound();
  await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts());
  await dials.setRepStatus(DIAL_ID, 'completed', NOW_SEC + 90); // the rep hung up before pressing 1
  assert.equal(await logCallBack(hs, { dials, calls }, DIAL_ID, OPTS), null);

  db = sqliteD1();
  dials = d1DialStore(db);
  calls = d1InboundCallStore(db);
  await inbound('+13855550171');
  await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts());
  await dials.setProspectResult(DIAL_ID, { sid: 'CA-out', status: 'completed', durationSec: 30 });
  assert.equal(await logCallBack(hs, { dials, calls }, DIAL_ID, OPTS), null);
  assert.equal(hs.calls.length, 0);
});

test('a HubSpot refusal can be retried; an unclear failure is not', async () => {
  await calledBack('completed', 30);
  hs.failNextLogCall = new HubSpotApiError(400, 'bad', 'POST /calls');
  await assert.rejects(logCallBack(hs, { dials, calls }, DIAL_ID, OPTS));
  assert.equal(await logCallBack(hs, { dials, calls }, DIAL_ID, OPTS), 'call-1');

  db = sqliteD1();
  dials = d1DialStore(db);
  calls = d1InboundCallStore(db);
  hs = new FakeHubSpot();
  hs.put('contacts', '10', { firstname: 'Jesse', lastname: 'Ferris', phone: '801-555-0164' });
  await calledBack('completed', 30);
  hs.failNextLogCall = new Error('connection reset');
  await assert.rejects(logCallBack(hs, { dials, calls }, DIAL_ID, OPTS));
  assert.equal(await logCallBack(hs, { dials, calls }, DIAL_ID, OPTS), null, 'it may have landed: never twice');
});

const ai: Transcriber = {
  async transcribe() {
    return {
      results: {
        channels: [
          { alternatives: [{ words: [{ word: 'Hi, Jesse.', start: 0, end: 1 }] }] },
          { alternatives: [{ words: [{ word: 'Hello there.', start: 1, end: 2 }] }] },
        ],
      },
    };
  },
  async summarize() {
    return '- They want a quote';
  },
};

test('a transcript that lands after the call back was logged is written onto that call', async () => {
  await calledBack('completed', 30);
  await logCallBack(hs, { dials, calls }, DIAL_ID, OPTS);
  await dials.setRecording(DIAL_ID, { sid: 'RE1', durationSec: 30, channels: 2 });
  const deps = { dials, callLogs: d1CallLogStore(db), hs, ai, recording: async () => new Response('mp3') };
  assert.equal(await runTranscription(deps, DIAL_ID, OPTS), 'done');
  const body = hs.objects.get('calls/call-1')!.properties.hs_call_body ?? '';
  assert.match(body, /They want a quote/);
  assert.match(body, /Transcript/);
  assert.ok((await dials.get(DIAL_ID))?.transcript_synced_at);
});

// --- the webhooks ---

async function sign(url: string, params: Record<string, string>): Promise<string> {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('tok'),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64');
}

async function post(path: string, params: Record<string, string>, background: Promise<unknown>[] = []) {
  const url = `${BASE}${path}`;
  const app = new Hono<AppEnv>();
  app.route('/', twilioRoute);
  const env = {
    DB: db,
    TWILIO_AUTH_TOKEN: 'tok',
    TWILIO_ACCOUNT_SID: 'AC1',
    PUBLIC_BASE_URL: BASE,
    HUBSPOT_ACCESS_TOKEN: 'hs',
  } as unknown as AppEnv['Bindings'];
  const ctx = { waitUntil: (p: Promise<unknown>) => background.push(p), passThroughOnException() {}, props: {} };
  return app.request(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': await sign(url, params) },
      body: new URLSearchParams(params),
    },
    env,
    ctx as unknown as ExecutionContext
  );
}

test('the rep hears an unknown caller’s number digit by digit before pressing 1', async () => {
  await inbound('+13855550171');
  await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts());
  const xml = await (await post(`/twilio/voice/answer?d=${DIAL_ID}`, { CallSid: 'CA1' })).text();
  assert.match(xml, /Call to 3 8 5, 5 5 5, 0 1 7 1\. Press 1 to connect\./);
});

test('the prospect leg’s final status logs the call back on the contact', async () => {
  await inbound();
  await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts());
  await dials.markConnected(DIAL_ID, 'x');
  const hubspot: { url: string; body: { properties: Record<string, string> } }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    hubspot.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ id: 'HSCALL' }, { status: 201 });
  }) as unknown as typeof fetch;
  try {
    const background: Promise<unknown>[] = [];
    const res = await post(
      `/twilio/voice/prospect-status?d=${DIAL_ID}`,
      { CallSid: 'CA-out', CallStatus: 'completed', CallDuration: '42' },
      background
    );
    assert.equal(res.status, 204);
    await Promise.all(background);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(hubspot.length, 1);
  assert.equal(hubspot[0].body.properties.hs_call_direction, 'OUTBOUND');
  assert.equal(hubspot[0].body.properties.hs_call_duration, '42000');
  assert.equal((await dials.get(DIAL_ID))?.logged_call_id, 'HSCALL');
});

// --- the page ---

async function page(overrides: Partial<InboundCallPageState> = {}) {
  const call = (await calls.get(INBOUND_ID))!;
  const dial = await dials.get(DIAL_ID);
  const nowSec = NOW_SEC + 300;
  return String(
    await inboundCallPage(
      {
        call,
        recording: inboundRecordingState(call, nowSec),
        others: [],
        dial,
        dialState: dial ? dialState(dial, nowSec) : null,
        dialRecording: dial ? recordingState(dial, nowSec) : null,
        setup: {
          twilioReady: true,
          browserReady: true,
          callWith: 'phone',
          fromNumber: '+13852557051',
          repPhone: '+18085550142',
        },
        portalId: '1',
        timeZone: 'America/Denver',
        ...overrides,
      },
      'rep@example.com'
    )
  );
}

test('the page offers a call back from the Twilio number, and says where it was logged', async () => {
  await inbound('+13855550171');
  let body = await page();
  assert.match(body, /<form method="post" action="\/inbound\/a{32}\/dial" class="row" >/);
  assert.match(body, /<button type="submit" class="primary" >Call back<\/button>/);
  assert.match(body, /press 1 to dial them from \+1 385-255-7051/);
  assert.match(body, /format-detection" content="telephone=no"/, 'no tap-to-call from the rep’s own phone');

  await startCallBack({ twilio, dials, calls }, INBOUND_ID, dialOpts());
  body = await page({ dialState: { kind: 'ringing-rep' } });
  assert.match(body, /class="primary" disabled>Call back/, 'no second call while one is live');
  assert.match(body, /Ringing your phone/);
});

test('the page says when the number was hidden, and lists the other calls from the number', async () => {
  await inbound('anonymous');
  const body = await page();
  assert.match(body, /hidden number, so there’s no number to call back/);
  assert.doesNotMatch(body, />Call back</);

  const other = { ...(await calls.get(INBOUND_ID))!, id: 'b'.repeat(32), started_sec: NOW_SEC - 180 };
  const withOthers = await page({ others: [other] });
  assert.match(withOthers, /Other calls from this number/);
  assert.match(withOthers, new RegExp(`href="/inbound/${'b'.repeat(32)}"`));
});

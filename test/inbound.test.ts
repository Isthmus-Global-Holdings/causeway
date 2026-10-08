// Calls to the Twilio number: the workflow against the real SQL on SQLite and
// a fake HubSpot, and the webhooks on a real Hono app with requests signed
// the way Twilio signs them.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { d1InboundCallStore, type InboundCall, type InboundCallStore } from '../src/lib/db.ts';
import { HubSpotApiError } from '../src/lib/hubspot.ts';
import { forwardToRep, inboundWhisper, spokenNumber, voicemail } from '../src/lib/twiml.ts';
import { twilioRoute } from '../src/routes/twilio.ts';
import type { AppEnv } from '../src/types.ts';
import {
  callerIdName,
  callerName,
  callerPlace,
  findCaller,
  inboundCallFields,
  inboundOutcome,
  inboundSummary,
  inboundRecordingState,
  logInboundCall,
  phoneCandidates,
  reconcileInboundCall,
  refreshCaller,
  runInboundTranscription,
  startInbound,
  type InboundInput,
} from '../src/workflows/inbound.ts';
import type { Transcriber } from '../src/workflows/transcribe.ts';
import { FakeHubSpot } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const NOW_SEC = NOW / 1000;
const BASE = 'https://app.test';
const ID = 'a'.repeat(32);
const OPTS = { now: NOW, baseUrl: BASE };

let db: D1Database;
let calls: InboundCallStore;
let hs: FakeHubSpot;

beforeEach(() => {
  db = sqliteD1();
  calls = d1InboundCallStore(db);
  hs = new FakeHubSpot();
  hs.put('contacts', '10', {
    firstname: 'Jesse',
    lastname: 'Ferris',
    phone: '801-555-0164',
    mobilephone: null,
    hubspot_owner_id: '77',
  });
  hs.put('companies', '20', { name: 'Ferris Freight' });
  hs.link('contacts', '10', 'companies', '20');
});

const input = (overrides: Partial<InboundInput> = {}): InboundInput => ({
  callSid: 'CA1',
  from: '+18015550164',
  to: '+13852557051',
  repNumber: '+18085550142',
  record: true,
  now: NOW,
  newId: () => ID,
  ...overrides,
});

// --- finding the caller ---

test('phone candidates: a US number is its 10 digits; otherwise each country code length', () => {
  assert.deepEqual(phoneCandidates('+18015550164'), ['8015550164']);
  assert.deepEqual(phoneCandidates('+50761112222'), ['0761112222', '761112222', '61112222']);
  assert.deepEqual(phoneCandidates('+1234'), [], 'too short to match anything');
});

test('finds the contact by the number however it was typed, with their company', async () => {
  const caller = await findCaller(hs, '+18015550164');
  assert.equal(caller?.contact.id, '10');
  assert.equal(caller?.company?.id, '20');
  assert.deepEqual(hs.searches[0], [
    [{ propertyName: 'hs_searchable_calculated_phone_number', operator: 'IN', values: ['8015550164'] }],
    [{ propertyName: 'hs_searchable_calculated_mobile_number', operator: 'IN', values: ['8015550164'] }],
  ]);
});

test('a number that only shares its last digits with a contact is not them', async () => {
  hs.put('contacts', '11', { firstname: 'Leo', phone: '+507 6111-2222' });
  assert.equal((await findCaller(hs, '+50761112222'))?.contact.id, '11');
  assert.equal(await findCaller(hs, '+4461112222'), null, 'same national digits, different country');
});

test('a new call is stored once, with who the caller is', async () => {
  const call = await startInbound({ hs, calls }, input());
  assert.equal(call.contact_id, '10');
  assert.equal(call.company_id, '20');
  assert.equal(call.owner_id, '77');
  assert.equal(call.contact_label, 'Jesse Ferris at Ferris Freight');
  assert.equal(call.record, 1);

  const again = await startInbound({ hs, calls }, input({ newId: () => 'b'.repeat(32) }));
  assert.equal(again.id, ID, 'a repeated webhook gets the same call');
  assert.equal(hs.searches.length, 1, 'and does not search HubSpot again');
});

test('an unknown or hidden caller, or a HubSpot failure, still rings through', async () => {
  const unknown = await startInbound({ hs, calls }, input({ from: '+13855550000' }));
  assert.equal(unknown.contact_id, null);

  const hidden = await startInbound(
    { hs, calls },
    input({ callSid: 'CA2', from: 'anonymous', newId: () => 'b'.repeat(32) })
  );
  assert.equal(hidden.from_number, 'anonymous');

  hs.failNextSearch = new Error('HubSpot 502');
  const down = await startInbound({ hs, calls }, input({ callSid: 'CA3', newId: () => 'c'.repeat(32) }));
  assert.equal(down.contact_id, null);
});

test('what Twilio says about a caller is kept: where the number is from, and a caller ID name', async () => {
  const call = await startInbound(
    { hs, calls },
    input({
      from: '+13855550171',
      details: { city: 'SALT LAKE CITY', state: 'UT', country: 'US', name: 'ACME FREIGHT' },
    })
  );
  assert.equal(callerPlace(call), 'Salt Lake City, UT');
  assert.equal(call.caller_name, 'ACME FREIGHT');
  assert.equal(callerName(call), 'ACME FREIGHT', 'the caller ID name when they aren’t in HubSpot');
  assert.equal(callerName({ ...call, contact_label: 'Jesse Ferris' }), 'Jesse Ferris', 'HubSpot’s name first');
  assert.equal(callerName({ ...call, caller_name: null }), '+1 385-555-0171');
});

test('caller ID placeholders are not names, and a country is only shown outside the US', () => {
  for (const placeholder of ['WIRELESS CALLER', 'Unavailable', 'unknown', '+13855550171', '', null]) {
    assert.equal(callerIdName(placeholder), null, String(placeholder));
  }
  assert.equal(callerIdName(' FERRIS JESSE '), 'FERRIS JESSE');
  assert.equal(callerPlace({ from_city: 'PANAMA', from_state: null, from_country: 'PA' }), 'Panama, PA');
  assert.equal(callerPlace({ from_city: null, from_state: 'UT', from_country: 'US' }), 'UT');
  assert.equal(callerPlace({ from_city: null, from_state: null, from_country: null }), null);
});

test('a missed call says how long they stayed on the line', async () => {
  await startInbound({ hs, calls }, input());
  await calls.markVoicemail(ID);
  await calls.setStatus(ID, 'completed', NOW_SEC + 18);
  assert.equal(inboundSummary((await calls.get(ID))!), 'Missed. No voicemail left. They hung up after 18s.');
});

test('a caller who was unknown is found once their number is on a contact, and only then', async () => {
  const call = await startInbound({ hs, calls }, input({ from: '+13855550171' }));
  assert.equal((await refreshCaller(hs, calls, call)).contact_id, null);

  hs.put('contacts', '11', { firstname: 'Ana', lastname: 'Díaz', phone: '(385) 555-0171' });
  const found = await refreshCaller(hs, calls, call);
  assert.equal(found.contact_id, '11');
  assert.equal(found.contact_label, 'Ana Díaz');

  const searches = hs.searches.length;
  await refreshCaller(hs, calls, found);
  assert.equal(hs.searches.length, searches, 'a known caller is not looked up again');
});

// --- logging on the contact ---

async function endedCall(setup: (id: string) => Promise<void>): Promise<InboundCall> {
  await startInbound({ hs, calls }, input());
  await setup(ID);
  await calls.setStatus(ID, 'completed', NOW_SEC + 120);
  return (await calls.get(ID))!;
}

test('an answered call is logged on the contact as an inbound call, once', async () => {
  await endedCall(async (id) => {
    await calls.markAnswered(id, 'x');
    await calls.setTalk(id, 95);
  });
  assert.equal(await logInboundCall(hs, calls, ID, OPTS), 'call-1');
  assert.equal(await logInboundCall(hs, calls, ID, OPTS), null, 'never twice');

  assert.equal(hs.calls.length, 1);
  const { call, links } = hs.calls[0];
  assert.deepEqual(links, { contactId: '10', companyId: '20' });
  assert.equal(call.direction, 'INBOUND');
  assert.equal(call.title, 'Call from Jesse Ferris at Ferris Freight');
  assert.equal(call.status, 'COMPLETED');
  assert.equal(call.durationMs, 95_000);
  assert.equal(call.fromNumber, '+18015550164');
  assert.equal(call.toNumber, '+13852557051');
  assert.equal(call.ownerId, '77');
  assert.equal(call.at, new Date(NOW).toISOString());
  assert.match(call.bodyHtml, /You answered\. Call length 1m 35s\./);
  assert.match(call.bodyHtml, /href="https:\/\/app\.test\/inbound\/a{32}"/);
});

test('a voicemail and a missed call are logged as such', async () => {
  const vm = await endedCall(async (id) => {
    await calls.markVoicemail(id);
    await calls.setRecording(id, { sid: 'RE1', durationSec: 25, channels: 1 });
  });
  assert.equal(inboundCallFields(vm, null, BASE).title, 'Voicemail from Jesse Ferris at Ferris Freight');

  const missed = { ...vm, recording_sid: null };
  const fields = inboundCallFields(missed, null, BASE);
  assert.equal(fields.title, 'Missed call from Jesse Ferris at Ferris Freight');
  assert.match(fields.bodyHtml, /Missed\. No voicemail left\./);
});

test('unknown callers and live calls are not logged', async () => {
  await startInbound({ hs, calls }, input({ from: '+13855550000' }));
  await calls.setStatus(ID, 'completed', NOW_SEC);
  assert.equal(await logInboundCall(hs, calls, ID, OPTS), null);

  await startInbound({ hs, calls }, input({ callSid: 'CA2', newId: () => 'b'.repeat(32) }));
  assert.equal(await logInboundCall(hs, calls, 'b'.repeat(32), OPTS), null, 'still ringing');
  assert.equal(hs.calls.length, 0);
});

test('a HubSpot refusal can be retried; an unclear failure is not retried', async () => {
  await endedCall(async () => {});
  hs.failNextLogCall = new HubSpotApiError(400, 'bad', '/crm/objects/2026-09/calls');
  await assert.rejects(logInboundCall(hs, calls, ID, OPTS));
  assert.equal(await logInboundCall(hs, calls, ID, OPTS), 'call-1');

  await startInbound({ hs, calls }, input({ callSid: 'CA2', newId: () => 'b'.repeat(32) }));
  await calls.setStatus('b'.repeat(32), 'completed', NOW_SEC);
  hs.failNextLogCall = new HubSpotApiError(502, 'gateway', '/crm/objects/2026-09/calls');
  await assert.rejects(logInboundCall(hs, calls, 'b'.repeat(32), OPTS));
  assert.equal(await logInboundCall(hs, calls, 'b'.repeat(32), OPTS), null, 'a missing log beats a duplicate');
});

test('a voicemail that arrives after the call was logged as missed corrects it, transcript or not', async () => {
  await endedCall(async (id) => {
    await calls.markVoicemail(id);
  });
  await logInboundCall(hs, calls, ID, OPTS);
  assert.equal(hs.calls[0].call.title, 'Missed call from Jesse Ferris at Ferris Freight');

  await calls.setRecording(ID, { sid: 'RE1', durationSec: 25, channels: 1 });
  assert.equal(await reconcileInboundCall(hs, calls, (await calls.get(ID))!, OPTS), true);
  const props = hs.objects.get('calls/call-1')!.properties;
  assert.equal(props.hs_call_title, 'Voicemail from Jesse Ferris at Ferris Freight');
  assert.equal(props.hs_call_status, 'NO_ANSWER');
  assert.equal(props.hs_call_duration, '25000');
  assert.match(props.hs_call_body!, /They left a voicemail \(25s\)\./);
  assert.equal((await calls.get(ID))?.transcript_synced_at, null, 'the transcript is still to come');
});

test('reconciling a call that is not logged yet writes nothing', async () => {
  const call = await endedCall(async () => {});
  assert.equal(await reconcileInboundCall(hs, calls, call, OPTS), false);
  assert.equal(hs.calls.length, 0);
});

// --- transcripts ---

const NOVA = {
  results: {
    channels: [
      { alternatives: [{ words: [{ word: 'Hi, it is Jesse.', start: 0.5, end: 1.2 }] }] },
      { alternatives: [{ words: [{ word: 'Hey Jesse.', start: 1.5, end: 2 }] }] },
    ],
  },
};

class FakeAi implements Transcriber {
  result: object = NOVA;
  async transcribe() {
    return this.result;
  }
  async summarize() {
    return '- Wants a quote';
  }
}

const transcribeDeps = (ai: FakeAi) => ({
  calls,
  hs,
  ai,
  recording: async () => new Response('mp3 bytes'),
});

test('an answered call has the caller on the first channel; the transcript lands on the logged call', async () => {
  await endedCall(async (id) => {
    await calls.markAnswered(id, 'x');
    await calls.setTalk(id, 95);
    await calls.setRecording(id, { sid: 'RE1', durationSec: 95, channels: 2 });
  });
  await logInboundCall(hs, calls, ID, OPTS);
  assert.equal(await runInboundTranscription(transcribeDeps(new FakeAi()), ID, OPTS), 'done');

  const call = (await calls.get(ID))!;
  assert.deepEqual(JSON.parse(call.transcript_json!), [
    { speaker: 'prospect', start: 0.5, end: 1.2, text: 'Hi, it is Jesse.' },
    { speaker: 'rep', start: 1.5, end: 2, text: 'Hey Jesse.' },
  ]);
  const body = hs.objects.get('calls/call-1')!.properties.hs_call_body!;
  assert.match(body, /<li>Wants a quote<\/li>/);
  assert.match(body, /<strong>Prospect:<\/strong> Hi, it is Jesse\./);
  assert.ok(call.transcript_synced_at);
});

test('a voicemail is all the caller', async () => {
  await endedCall(async (id) => {
    await calls.markVoicemail(id);
    await calls.setRecording(id, { sid: 'RE1', durationSec: 25, channels: 1 });
  });
  const ai = new FakeAi();
  ai.result = { results: { channels: [NOVA.results.channels[0]] } };
  await runInboundTranscription(transcribeDeps(ai), ID, OPTS);
  const call = (await calls.get(ID))!;
  assert.deepEqual(JSON.parse(call.transcript_json!), [
    { speaker: 'prospect', start: 0.5, end: 1.2, text: 'Hi, it is Jesse.' },
  ]);
  // Logged after the transcript: it goes in with the call.
  await logInboundCall(hs, calls, ID, OPTS);
  assert.match(hs.calls[0].call.bodyHtml, /Hi, it is Jesse\./);
  assert.equal(hs.calls[0].call.title, 'Voicemail from Jesse Ferris at Ferris Freight');
});

test('recording state: nothing expected, waiting, and a caller who left no message', async () => {
  const base = await endedCall(async () => {});
  assert.equal(inboundRecordingState({ ...base, record: 0, answered_at: 'x' }, NOW_SEC + 130).kind, 'none');
  const answered = { ...base, answered_at: 'x' };
  assert.equal(inboundRecordingState(answered, NOW_SEC + 130).kind, 'pending');
  assert.equal(inboundRecordingState(answered, NOW_SEC + 120 + 11 * 60).kind, 'failed');
  const noMessage = { ...base, voicemail: 1 };
  assert.equal(inboundRecordingState(noMessage, NOW_SEC + 130).kind, 'pending');
  assert.equal(inboundRecordingState(noMessage, NOW_SEC + 120 + 90).kind, 'none');
  assert.equal(inboundRecordingState({ ...noMessage, status: null }, NOW_SEC).kind, 'pending', 'still leaving it');
});

// --- TwiML ---

test('forwarding plays the notice only when recording, and asks the app when the rep leg ends', () => {
  const opts = { repNumber: '+18085550142', whisperUrl: `${BASE}/w?d=1&x=2`, doneUrl: `${BASE}/d?d=1` };
  const recorded = forwardToRep({ ...opts, notice: true });
  assert.match(recorded, /^<\?xml[^>]*><Response><Say>This call may be recorded\.<\/Say><Dial /);
  assert.match(recorded, /<Dial timeout="20" action="https:\/\/app\.test\/d\?d=1" method="POST">/);
  assert.match(recorded, /<Number url="https:\/\/app\.test\/w\?d=1&amp;x=2" method="POST">\+18085550142<\/Number>/);
  assert.doesNotMatch(recorded, /callerId|record=/, "the rep sees the caller's number; recording starts later");
  assert.doesNotMatch(forwardToRep({ ...opts, notice: false }), /<Say>/);
});

test('the whisper hangs up unless the rep presses 1, and voicemail always has somewhere to go next', () => {
  assert.match(
    inboundWhisper('Jesse <Ferris>', `${BASE}/a`),
    /<Gather numDigits="1" [^>]*action="https:\/\/app\.test\/a"[^>]*><Say>Call from Jesse &lt;Ferris&gt;\. Press 1 to answer\.<\/Say><\/Gather><Hangup\/>/
  );
  const vm = voicemail(`${BASE}/r`, `${BASE}/h`);
  assert.match(vm, /<Record [^>]*action="https:\/\/app\.test\/h"/);
  assert.match(vm, /recordingStatusCallback="https:\/\/app\.test\/r"/);
});

test('an unknown number is read out digit by digit', () => {
  assert.equal(spokenNumber('+18015550164'), '8 0 1, 5 5 5, 0 1 6 4');
  assert.equal(spokenNumber('+50761112222'), '5 0 7 6 1 1 1 2 2 2 2');
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

const settings: Record<string, string> = {};
const background: Promise<unknown>[] = [];

async function post(path: string, params: Record<string, string>) {
  const url = `${BASE}${path}`;
  const app = new Hono<AppEnv>();
  app.route('/', twilioRoute);
  for (const [key, value] of Object.entries(settings)) {
    await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
  }
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

// Stands in for HubSpot's and Twilio's APIs while a webhook runs.
async function withFetch<T>(handler: (url: string, init: RequestInit) => Response, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => handler(url, init)) as unknown as typeof fetch;
  try {
    const result = await run();
    await Promise.all(background.splice(0));
    return result;
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('a call from a contact: notice, ring the rep, press 1, record, then log it on the contact', async () => {
  Object.assign(settings, { rep_phone: '+18085550142', record_calls: '1' });
  const hubspot: { url: string; body: unknown }[] = [];
  const twilio: string[] = [];
  const fetchStub = (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.twilio.com')) {
      twilio.push(url);
      return Response.json({ sid: 'RE1' }, { status: 201 });
    }
    hubspot.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/contacts/search')) {
      return Response.json({
        results: [{ id: '10', properties: { firstname: 'Jesse', lastname: 'Ferris', phone: '801-555-0164' } }],
      });
    }
    if (url.includes('/associations/companies')) return Response.json({ results: [] });
    if (url.endsWith('/crm/objects/2026-09/calls')) return Response.json({ id: 'HSCALL' }, { status: 201 });
    return new Response('not stubbed', { status: 500 });
  };

  const xml = await withFetch(fetchStub, async () =>
    (await post('/twilio/voice/inbound', { CallSid: 'CA1', From: '+18015550164', To: '+13852557051' })).text()
  );
  const call = (await calls.byCallSid('CA1'))!;
  assert.equal(call.contact_label, 'Jesse Ferris');
  assert.match(xml, /<Say>This call may be recorded\.<\/Say><Dial /);
  assert.match(xml, new RegExp(`/twilio/voice/inbound/whisper\\?d=${call.id}`));

  const whisper = await (await post(`/twilio/voice/inbound/whisper?d=${call.id}`, { CallSid: 'CA2' })).text();
  assert.match(whisper, /Call from Jesse Ferris\. Press 1 to answer\./);

  const accepted = await withFetch(fetchStub, async () =>
    (await post(`/twilio/voice/inbound/accept?d=${call.id}`, { Digits: '1', CallSid: 'CA2' })).text()
  );
  assert.match(accepted, /<Response><\/Response>$/, 'connect the caller');
  assert.deepEqual(twilio, ['https://api.twilio.com/2010-04-01/Accounts/AC1/Calls/CA1/Recordings.json']);

  const done = await (await post(`/twilio/voice/inbound/done?d=${call.id}`, { DialCallDuration: '61' })).text();
  assert.match(done, /<Hangup\/>/);

  await withFetch(fetchStub, () => post('/twilio/voice/inbound/status', { CallSid: 'CA1', CallStatus: 'completed' }));
  const logged = hubspot.find((h) => h.url.endsWith('/crm/objects/2026-09/calls'));
  assert.ok(logged, 'logged on the contact');
  const props = (logged.body as { properties: Record<string, string> }).properties;
  assert.equal(props.hs_call_direction, 'INBOUND');
  assert.equal(props.hs_call_duration, '61000');
  assert.equal((await calls.get(call.id))?.logged_call_id, 'HSCALL');
});

test('when the rep does not press 1, the caller gets voicemail', async () => {
  Object.assign(settings, { rep_phone: '+18085550142', record_calls: '0' });
  const xml = await withFetch(
    () => Response.json({ results: [] }),
    async () =>
      (await post('/twilio/voice/inbound', { CallSid: 'CA9', From: '+13855550000', To: '+13852557051' })).text()
  );
  assert.doesNotMatch(xml, /<Say>/, 'no recording notice when recording is off');
  const call = (await calls.byCallSid('CA9'))!;
  assert.match(
    await (await post(`/twilio/voice/inbound/whisper?d=${call.id}`, {})).text(),
    /Call from 3 8 5, 5 5 5, 0 0 0 0\./
  );
  assert.match(await (await post(`/twilio/voice/inbound/accept?d=${call.id}`, {})).text(), /<Hangup\/>/);
  const vm = await (await post(`/twilio/voice/inbound/done?d=${call.id}`, { DialCallStatus: 'completed' })).text();
  assert.match(vm, /Please leave a message after the tone\.<\/Say><Record /);
  assert.equal((await calls.get(call.id))?.voicemail, 1);
});

test('with no phone picked in Settings, callers go straight to voicemail', async () => {
  delete settings.rep_phone;
  await db.prepare("DELETE FROM settings WHERE key = 'rep_phone'").run();
  const xml = await withFetch(
    () => Response.json({ results: [] }),
    async () =>
      (await post('/twilio/voice/inbound', { CallSid: 'CA8', From: '+13855550000', To: '+13852557051' })).text()
  );
  assert.match(xml, /<Record /);
  assert.doesNotMatch(xml, /<Dial/);
});

test('a caller who hangs up before the call is stored is still a missed call, not ringing', async () => {
  Object.assign(settings, { rep_phone: '+18085550142', record_calls: '1' });
  const caller = { CallSid: 'CA6', From: '+61491570156', To: '+13852557051', FromCountry: 'AU' };
  // Twilio's final status lands before the voice webhook has stored the call.
  const res = await withFetch(
    () => Response.json({ results: [] }),
    () => post('/twilio/voice/inbound/status', { ...caller, CallStatus: 'no-answer' })
  );
  assert.equal(res.status, 204);
  const call = (await calls.byCallSid('CA6'))!;
  assert.equal(call.status, 'no-answer');
  assert.equal(call.from_country, 'AU');
  assert.equal(inboundOutcome(call), 'missed');

  const xml = await withFetch(
    () => Response.json({ results: [] }),
    async () => (await post('/twilio/voice/inbound', caller)).text()
  );
  assert.match(xml, /<Hangup\/>/);
  assert.doesNotMatch(xml, /<Dial/, 'the rep is not rung for a caller who is gone');
  assert.equal((await calls.byCallSid('CA6'))?.id, call.id, 'still the one row');
});

test('a retried key press starts only one recording', async () => {
  Object.assign(settings, { rep_phone: '+18085550142', record_calls: '1' });
  const started: string[] = [];
  const stub = (url: string) => {
    if (url.startsWith('https://api.twilio.com')) {
      started.push(url);
      return Response.json({ sid: 'RE1' }, { status: 201 });
    }
    return Response.json({ results: [] });
  };
  await withFetch(stub, () =>
    post('/twilio/voice/inbound', { CallSid: 'CA7', From: '+13855550000', To: '+13852557051' })
  );
  const call = (await calls.byCallSid('CA7'))!;
  for (let i = 0; i < 2; i++) {
    const xml = await withFetch(stub, async () =>
      (await post(`/twilio/voice/inbound/accept?d=${call.id}`, { Digits: '1' })).text()
    );
    assert.match(xml, /<Response><\/Response>$/, 'both deliveries connect the call');
  }
  assert.equal(started.length, 1);
});

test('a late voicemail recording corrects the logged call even when transcription fails', async () => {
  await endedCall(async (id) => {
    await calls.markVoicemail(id);
  });
  await calls.setLoggedCall(ID, 'HSCALL');
  const patches: Record<string, string>[] = [];
  const stub = (url: string, init: RequestInit) => {
    if (url.endsWith('/crm/objects/2026-09/calls/HSCALL') && init.method === 'PATCH') {
      patches.push((JSON.parse(String(init.body)) as { properties: Record<string, string> }).properties);
      return new Response('{}');
    }
    return new Response('not stubbed', { status: 500 });
  };
  // No AI binding in this env, so transcription fails after the reconcile.
  const res = await withFetch(stub, () =>
    post(`/twilio/voice/inbound/recording?d=${ID}`, {
      RecordingSid: 'RE1',
      RecordingStatus: 'completed',
      RecordingDuration: '25',
      RecordingChannels: '1',
    })
  );
  assert.equal(res.status, 204);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].hs_call_title, 'Voicemail from Jesse Ferris at Ferris Freight');
  assert.equal(patches[0].hs_call_duration, '25000');
});

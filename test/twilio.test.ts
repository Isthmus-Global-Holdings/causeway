import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTwilio, listedNumber, TwilioApiError, validTwilioSignature } from '../src/lib/twilio.ts';
import { bridgePrompt, connect, dialProspect, recordingNotice, sayAndHangUp } from '../src/lib/twiml.ts';

// The worked example from https://www.twilio.com/docs/usage/security
const EXAMPLE = {
  token: '12345',
  url: 'https://example.com/myapp.php?foo=1&bar=2',
  params: {
    Digits: '1234',
    To: '+18005551212',
    From: '+14158675310',
    Caller: '+14158675310',
    CallSid: 'CA1234567890ABCDE',
  },
  signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=',
};

test("accepts Twilio's own worked example", async () => {
  assert.equal(await validTwilioSignature(EXAMPLE.token, EXAMPLE.url, EXAMPLE.params, EXAMPLE.signature), true);
});

test('rejects a changed parameter, URL, token or signature, and a missing one', async () => {
  const { token, url, params, signature } = EXAMPLE;
  assert.equal(await validTwilioSignature(token, url, { ...params, Digits: '1' }, signature), false);
  assert.equal(await validTwilioSignature(token, url.replace('foo=1', 'foo=2'), params, signature), false);
  assert.equal(await validTwilioSignature('54321', url, params, signature), false);
  assert.equal(await validTwilioSignature(token, url, params, signature.replace('L', 'M')), false);
  assert.equal(await validTwilioSignature(token, url, params, undefined), false);
  assert.equal(await validTwilioSignature(token, url, params, ''), false);
});

test('createCall posts a form to the Calls resource with basic auth', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return Response.json({ sid: 'CA123' }, { status: 201 });
  }) as unknown as typeof fetch;

  const call = await createTwilio('AC1', 'secret', fetchImpl).createCall({
    to: '+13855550100',
    from: '+13852557051',
    url: 'https://app.test/twilio/voice/answer?d=abc',
    statusCallback: 'https://app.test/twilio/voice/rep-status?d=abc',
    timeoutSec: 25,
  });

  assert.equal(call.sid, 'CA123');
  assert.equal(seen!.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json');
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${btoa('AC1:secret')}`);
  const body = new URLSearchParams(String(seen!.init.body));
  assert.equal(body.get('To'), '+13855550100');
  assert.equal(body.get('From'), '+13852557051');
  assert.equal(body.get('Url'), 'https://app.test/twilio/voice/answer?d=abc');
  assert.equal(body.get('StatusCallback'), 'https://app.test/twilio/voice/rep-status?d=abc');
  assert.equal(body.get('Timeout'), '25');
});

test('createCall turns an error answer into TwilioApiError', async () => {
  const fetchImpl = (async () =>
    new Response('{"code":21211,"message":"Invalid To"}', { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(
    createTwilio('AC1', 'secret', fetchImpl).createCall({
      to: 'x',
      from: 'y',
      url: 'u',
      statusCallback: 's',
      timeoutSec: 1,
    }),
    (err: unknown) => err instanceof TwilioApiError && err.status === 400
  );
});

test('the prompt only dials on a keypress, and escapes names', () => {
  const xml = bridgePrompt('Ana <Díaz> & Co', 'https://app.test/twilio/voice/connect?d=abc');
  assert.match(xml, /<Gather numDigits="1"[^>]*action="https:\/\/app\.test\/twilio\/voice\/connect\?d=abc"/);
  assert.match(xml, /Call to Ana &lt;Díaz&gt; &amp; Co\. Press 1 to connect\./);
  assert.doesNotMatch(xml, /<Dial/);
});

test('the dial uses the Twilio number as caller ID and reports the prospect leg', () => {
  const xml = dialProspect({
    to: '+13855550100',
    callerId: '+13852557051',
    statusCallbackUrl: 'https://app.test/twilio/voice/prospect-status?d=abc',
  });
  assert.match(xml, /<Dial callerId="\+13852557051"/);
  assert.match(
    xml,
    /<Number statusCallback="https:\/\/app\.test\/twilio\/voice\/prospect-status\?d=abc" statusCallbackMethod="POST">\+13855550100<\/Number>/
  );
  assert.match(sayAndHangUp('Bye'), /<Say>Bye<\/Say><Hangup\/>/);
});

test('an extension is keyed in two seconds after the line answers', () => {
  const xml = dialProspect({
    to: '+13855550100',
    callerId: '+13852557051',
    statusCallbackUrl: 'https://app.test/s',
    extension: '204',
  });
  assert.match(xml, /<Number [^>]*sendDigits="wwww204">\+13855550100<\/Number>/);
  for (const extension of [null, '', '2"04']) {
    const plain = dialProspect({
      to: '+13855550100',
      callerId: '+1',
      statusCallbackUrl: 'https://app.test/s',
      extension,
    });
    assert.doesNotMatch(plain, /sendDigits/, String(extension));
  }
});

test("listNumbers offers the account's voice numbers and its verified caller IDs", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.includes('/IncomingPhoneNumbers.json')) {
      return Response.json({
        incoming_phone_numbers: [
          { phone_number: '+13852557051', friendly_name: '(385) 255-7051', capabilities: { voice: true } },
          { phone_number: '+18885550100', friendly_name: 'SMS only', capabilities: { voice: false } },
        ],
      });
    }
    if (url.includes('/OutgoingCallerIds.json')) {
      return Response.json({ outgoing_caller_ids: [{ phone_number: '+18085550142', friendly_name: 'My cell' }] });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const numbers = await createTwilio('AC1', 'secret', fetchImpl).listNumbers();
  assert.deepEqual(numbers, {
    voice: [{ phoneNumber: '+13852557051', friendlyName: '(385) 255-7051' }],
    verified: [{ phoneNumber: '+18085550142', friendlyName: 'My cell' }],
  });
});

test('listedNumber accepts only a number Twilio listed', () => {
  const options = [{ phoneNumber: '+18085550142', friendlyName: 'My cell' }];
  assert.equal(listedNumber('+18085550142', options), '+18085550142');
  assert.equal(listedNumber('+19005550100', options), null, 'a posted number that is not on the account');
  assert.equal(listedNumber('', options), null);
});

test('a recorded call plays the notice first; recording starts only after it', () => {
  const dial = dialProspect({
    to: '+13855550100',
    callerId: '+13852557051',
    statusCallbackUrl: 'https://app.test/s',
    noticeUrl: 'https://app.test/twilio/voice/notice?d=abc',
  });
  assert.match(dial, /<Number [^>]*url="https:\/\/app\.test\/twilio\/voice\/notice\?d=abc" method="POST">/);
  assert.doesNotMatch(dial, /record=/, 'nothing records from the answer');

  const notice = recordingNotice('https://app.test/twilio/voice/after-notice?d=abc');
  assert.match(
    notice,
    /^<\?xml[^>]*\?><Response><Say>This call may be recorded\.<\/Say><Gather numDigits="1" timeout="1" actionOnEmptyResult="true" action="https:\/\/app\.test\/twilio\/voice\/after-notice\?d=abc" method="POST"\/><\/Response>$/
  );
  assert.match(connect(), /<Response><\/Response>$/);
});

test('startRecording asks Twilio for a two-channel recording of the call', async () => {
  let seen: { url: string; body: URLSearchParams } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, body: new URLSearchParams(String(init.body)) };
    return Response.json({ sid: 'RE1' }, { status: 201 });
  }) as unknown as typeof fetch;
  const rec = await createTwilio('AC1', 'secret', fetchImpl).startRecording(
    'CA9',
    'https://app.test/twilio/voice/recording?d=abc'
  );
  assert.equal(rec.sid, 'RE1');
  assert.equal(seen!.url, 'https://api.twilio.com/2010-04-01/Accounts/AC1/Calls/CA9/Recordings.json');
  assert.equal(seen!.body.get('RecordingChannels'), 'dual');
  assert.equal(seen!.body.get('RecordingStatusCallback'), 'https://app.test/twilio/voice/recording?d=abc');
});

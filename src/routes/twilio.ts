// Public webhooks Twilio calls during a call: a bridged call, a call from the
// browser, and a call to the Twilio number (/twilio/voice/inbound*). They sit
// outside Cloudflare Access (see middleware/access.ts and the README), so
// every request must carry a valid X-Twilio-Signature, and names its dial or
// inbound call by the random id the app put in the URL (or, for a call from
// the browser, in the call's params).

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { inboundTranscribeDeps, insightDeps, loadAppSettings, transcribeDeps, twilioClient } from '../lib/app-settings';
import { d1DialStore, d1InboundCallStore, type Dial } from '../lib/db';
import { recordingNotStarted } from '../lib/errors';
import { createHubSpot } from '../lib/hubspot';
import { validTwilioSignature } from '../lib/twilio';
import {
  bridgePrompt,
  connect,
  dialProspect,
  forwardToRep,
  hangUp,
  inboundWhisper,
  recordingNotice,
  sayAndHangUp,
  spokenNumber,
  voicemail,
} from '../lib/twiml';
import { logCallBack } from '../workflows/call-back';
import { logInboundCall, reconcileInboundCall, runInboundTranscription, startInbound } from '../workflows/inbound';
import { DIAL_GUARD_SEC } from '../workflows/dial';
import { readDialCall } from '../workflows/call-insight';
import { runTranscription } from '../workflows/transcribe';
import type { AppEnv, Env } from '../types';

export const twilioRoute = new Hono<AppEnv>();

const DIAL_ID = /^[0-9a-f]{32}$/;
// Final statuses of a leg. Twilio only sends the final one to our callbacks.
const FINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

async function formParams(c: Context<AppEnv>): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

const twilioSignature: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = c.env.TWILIO_AUTH_TOKEN;
  if (!token) return c.text('Twilio is not configured on this Worker.', 500);
  const ok = await validTwilioSignature(token, c.req.url, await formParams(c), c.req.header('X-Twilio-Signature'));
  if (!ok) return c.text('Invalid Twilio signature', 403);
  return next();
};

function twiml(body: string) {
  return new Response(body, { headers: { 'Content-Type': 'text/xml' } });
}

function dialId(url: string): string | null {
  const id = new URL(url).searchParams.get('d');
  return id && DIAL_ID.test(id) ? id : null;
}

function publicUrl(base: string, path: string, id: string): string {
  return `${base.replace(/\/+$/, '')}${path}?d=${id}`;
}

// Dials the prospect, with the recording notice first when the dial records,
// and keys in their extension once the line answers.
function prospectTwiml(env: Env, dial: Dial) {
  return twiml(
    dialProspect({
      to: dial.to_number,
      callerId: dial.from_number,
      statusCallbackUrl: publicUrl(env.PUBLIC_BASE_URL, '/twilio/voice/prospect-status', dial.id),
      noticeUrl: dial.record ? publicUrl(env.PUBLIC_BASE_URL, '/twilio/voice/notice', dial.id) : null,
      extension: dial.to_extension,
    })
  );
}

twilioRoute.use('/twilio/*', twilioSignature);

// The rep answered their phone.
twilioRoute.post('/twilio/voice/answer', async (c) => {
  const id = dialId(c.req.url);
  const dial = id ? await d1DialStore(c.env.DB).get(id) : null;
  if (!dial) return twiml(sayAndHangUp('This call has expired. Start it again from the app.'));
  // A call back to someone not in HubSpot has only their number to go by.
  const who = dial.contact_id ? dial.contact_label : spokenNumber(dial.to_number);
  return twiml(bridgePrompt(who, publicUrl(c.env.PUBLIC_BASE_URL, '/twilio/voice/connect', dial.id)));
});

// The rep pressed a key (or the prompt timed out, which sends no Digits).
twilioRoute.post('/twilio/voice/connect', async (c) => {
  const id = dialId(c.req.url);
  const dials = d1DialStore(c.env.DB);
  const dial = id ? await dials.get(id) : null;
  const { Digits } = await formParams(c);
  if (!dial || Digits !== '1') return twiml(sayAndHangUp('Not connected. Goodbye.'));
  await dials.markConnected(dial.id, new Date().toISOString());
  return prospectTwiml(c.env, dial);
});

// A call from the call page, in the browser: the TwiML App's Voice URL. The
// page passes the dial's id to device.connect, and Twilio posts it here as a
// parameter. Clicking Call was the rep's go-ahead, so the prospect is dialled
// straight away, but only once per dial, and only for a dial that started
// moments ago and hasn't been cancelled.
twilioRoute.post('/twilio/voice/client', async (c) => {
  const { d, CallSid } = await formParams(c);
  const id = d && DIAL_ID.test(d) ? d : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const dial =
    id && CallSid
      ? await d1DialStore(c.env.DB).claimBrowserCall(id, CallSid, new Date().toISOString(), nowSec - DIAL_GUARD_SEC)
      : null;
  if (!dial) return twiml(sayAndHangUp('This call has expired. Start it again from the app.'));
  return prospectTwiml(c.env, dial);
});

// Final status of a browser call: the TwiML App's status callback. It's set
// once for the app, so it names the call only by its sid. The page also
// reports the end (POST /calls/:id/dial/:dialId/end), so a callback that
// never arrives doesn't leave the dial live; this one, from Twilio, wins.
twilioRoute.post('/twilio/voice/client-status', async (c) => {
  const { CallSid, CallStatus } = await formParams(c);
  if (CallSid && FINAL.has(CallStatus)) {
    const dials = d1DialStore(c.env.DB);
    const dial = await dials.getByRepCallSid(CallSid);
    if (dial?.mode === 'browser') await dials.setRepStatus(dial.id, CallStatus, Math.floor(Date.now() / 1000));
  }
  return c.body(null, 204);
});

// Final status of the rep's leg: the whole bridged call is over.
twilioRoute.post('/twilio/voice/rep-status', async (c) => {
  const id = dialId(c.req.url);
  const { CallStatus } = await formParams(c);
  if (id && FINAL.has(CallStatus)) {
    await d1DialStore(c.env.DB).setRepStatus(id, CallStatus, Math.floor(Date.now() / 1000));
  }
  return c.body(null, 204);
});

// Final status of the prospect's leg, with how long they talked. A call back
// to a HubSpot contact is logged on them after answering.
twilioRoute.post('/twilio/voice/prospect-status', async (c) => {
  const id = dialId(c.req.url);
  const { CallStatus, CallSid, CallDuration } = await formParams(c);
  if (id && FINAL.has(CallStatus)) {
    const duration = Number(CallDuration);
    const dials = d1DialStore(c.env.DB);
    await dials.setProspectResult(id, {
      sid: CallSid ?? '',
      status: CallStatus,
      durationSec: CallDuration && Number.isFinite(duration) ? duration : null,
    });
    c.executionCtx.waitUntil(
      logCallBack(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), { dials, calls: d1InboundCallStore(c.env.DB) }, id, {
        now: Date.now(),
        baseUrl: c.env.PUBLIC_BASE_URL,
      }).catch((err) => console.error('call back log', err))
    );
  }
  return c.body(null, 204);
});

// The prospect answered a recorded call: tell them before they're connected.
twilioRoute.post('/twilio/voice/notice', (c) => {
  const id = dialId(c.req.url);
  if (!id) return twiml(connect());
  return twiml(recordingNotice(publicUrl(c.env.PUBLIC_BASE_URL, '/twilio/voice/after-notice', id)));
});

// The notice has played: start recording, then let Twilio connect the call.
// The recording is of the parent call (the rep's leg), one channel per side.
// If it can't start, the call still connects, unrecorded, and the call page
// says why.
twilioRoute.post('/twilio/voice/after-notice', async (c) => {
  const id = dialId(c.req.url);
  const dials = d1DialStore(c.env.DB);
  const dial = id ? await dials.get(id) : null;
  const { ParentCallSid } = await formParams(c);
  const parent = ParentCallSid || dial?.rep_call_sid;
  if (dial && parent) {
    try {
      await twilioClient(c.env).startRecording(
        parent,
        publicUrl(c.env.PUBLIC_BASE_URL, '/twilio/voice/recording', dial.id)
      );
    } catch (err) {
      console.error('start recording', err);
      await dials.failTranscript(dial.id, recordingNotStarted(err));
    }
  }
  return twiml(connect());
});

// The recording is ready. Store it on the dial, answer Twilio straight away,
// and transcribe after responding.
twilioRoute.post('/twilio/voice/recording', async (c) => {
  const id = dialId(c.req.url);
  const { RecordingSid, RecordingStatus, RecordingDuration, RecordingChannels } = await formParams(c);
  if (!id || RecordingStatus !== 'completed' || !RecordingSid) return c.body(null, 204);
  const duration = Number(RecordingDuration);
  const channels = Number(RecordingChannels);
  await d1DialStore(c.env.DB).setRecording(id, {
    sid: RecordingSid,
    durationSec: RecordingDuration && Number.isFinite(duration) ? duration : null,
    channels: RecordingChannels && Number.isFinite(channels) ? channels : null,
  });
  // Anything that goes wrong from here (including a missing AI binding) shows
  // on the call page, where the rep can retry. Twilio only needs the 204.
  c.executionCtx.waitUntil(
    Promise.resolve()
      .then(() => runTranscription(transcribeDeps(c.env), id, { now: Date.now(), baseUrl: c.env.PUBLIC_BASE_URL }))
      // A call the rep already logged is read again for coaching, from the
      // transcript this time (one this misses is read when Coaching opens).
      .then((outcome) => (outcome === 'done' ? readDialCall(insightDeps(c.env), id, Date.now()) : null))
      .catch((err) => console.error('transcription', err))
  );
  return c.body(null, 204);
});

// --- Calls to the Twilio number (workflows/inbound.ts) ---

// Stores the call from what either of the number's webhooks says about it.
// Both carry the caller; whichever lands first stores the row.
async function storeInbound(c: Context<AppEnv>, params: Record<string, string>) {
  const { CallSid, From, To, FromCity, FromState, FromCountry, CallerName } = params;
  const settings = await loadAppSettings(c.env);
  return startInbound(
    { hs: createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), calls: d1InboundCallStore(c.env.DB) },
    {
      callSid: CallSid,
      from: From ?? '',
      to: To ?? '',
      details: {
        city: FromCity ?? null,
        state: FromState ?? null,
        country: FromCountry ?? null,
        name: CallerName ?? null,
      },
      repNumber: settings.repPhone,
      record: settings.recordCalls,
      now: Date.now(),
    }
  );
}

// Twilio's voice webhook for the number: someone is calling. Look them up,
// then ring the rep (or go straight to voicemail if no phone is picked).
twilioRoute.post('/twilio/voice/inbound', async (c) => {
  const params = await formParams(c);
  if (!params.CallSid) return twiml(sayAndHangUp('Sorry, this call could not be connected.'));
  const call = await storeInbound(c, params);
  // The caller already hung up: the status callback got here first.
  if (call.status !== null) return twiml(hangUp());
  const url = (path: string) => publicUrl(c.env.PUBLIC_BASE_URL, `/twilio/voice/inbound/${path}`, call.id);
  if (!call.rep_number) {
    await d1InboundCallStore(c.env.DB).markVoicemail(call.id);
    return twiml(voicemail(url('recording'), url('hangup')));
  }
  return twiml(
    forwardToRep({
      repNumber: call.rep_number,
      notice: Boolean(call.record),
      whisperUrl: url('whisper'),
      doneUrl: url('done'),
    })
  );
});

// The rep's phone picked up (the rep, or their voicemail): say who's calling.
twilioRoute.post('/twilio/voice/inbound/whisper', async (c) => {
  const id = dialId(c.req.url);
  const call = id ? await d1InboundCallStore(c.env.DB).get(id) : null;
  if (!call) return twiml(hangUp());
  const who =
    call.contact_label ??
    call.caller_name ??
    (call.from_number.startsWith('+') ? spokenNumber(call.from_number) : 'an unknown number');
  return twiml(inboundWhisper(who, publicUrl(c.env.PUBLIC_BASE_URL, '/twilio/voice/inbound/accept', call.id)));
});

// The rep pressed a key. 1 connects the caller, recording from here on when
// recording is on (the caller heard the notice before the rep's phone rang).
// Anything else hangs up the rep's leg, and the caller gets voicemail.
twilioRoute.post('/twilio/voice/inbound/accept', async (c) => {
  const id = dialId(c.req.url);
  const calls = d1InboundCallStore(c.env.DB);
  const call = id ? await calls.get(id) : null;
  const { Digits } = await formParams(c);
  if (!call || Digits !== '1') return twiml(hangUp());
  // Only the first delivery starts the recording: Twilio retries a webhook
  // whose answer it didn't get, and each start is a separate, billed recording.
  const first = await calls.markAnswered(call.id, new Date().toISOString());
  if (first && call.record) {
    try {
      // The caller's leg is the parent: channel 0 is the caller, 1 the rep.
      await twilioClient(c.env).startRecording(
        call.call_sid,
        publicUrl(c.env.PUBLIC_BASE_URL, '/twilio/voice/inbound/recording', call.id)
      );
    } catch (err) {
      console.error('start inbound recording', err);
      await calls.failTranscript(call.id, recordingNotStarted(err));
    }
  }
  return twiml(connect());
});

// The <Dial> to the rep is over. If the rep took the call, it's done;
// otherwise the caller can leave a voicemail.
twilioRoute.post('/twilio/voice/inbound/done', async (c) => {
  const id = dialId(c.req.url);
  const calls = d1InboundCallStore(c.env.DB);
  const call = id ? await calls.get(id) : null;
  if (!call) return twiml(hangUp());
  if (call.answered_at) {
    const { DialCallDuration } = await formParams(c);
    const talk = Number(DialCallDuration);
    await calls.setTalk(call.id, DialCallDuration && Number.isFinite(talk) ? talk : null);
    return twiml(hangUp());
  }
  await calls.markVoicemail(call.id);
  const url = (path: string) => publicUrl(c.env.PUBLIC_BASE_URL, `/twilio/voice/inbound/${path}`, call.id);
  return twiml(voicemail(url('recording'), url('hangup')));
});

// The caller finished their voicemail.
twilioRoute.post('/twilio/voice/inbound/hangup', () => twiml(hangUp()));

// The call's recording, or the voicemail, is ready. Transcribe it after
// answering Twilio, as for a dial.
twilioRoute.post('/twilio/voice/inbound/recording', async (c) => {
  const id = dialId(c.req.url);
  const { RecordingSid, RecordingStatus, RecordingDuration, RecordingChannels } = await formParams(c);
  if (!id || RecordingStatus !== 'completed' || !RecordingSid) return c.body(null, 204);
  const duration = Number(RecordingDuration);
  const channels = Number(RecordingChannels);
  const calls = d1InboundCallStore(c.env.DB);
  await calls.setRecording(id, {
    sid: RecordingSid,
    durationSec: RecordingDuration && Number.isFinite(duration) ? duration : null,
    channels: RecordingChannels && Number.isFinite(channels) ? channels : null,
  });
  const opts = { now: Date.now(), baseUrl: c.env.PUBLIC_BASE_URL };
  // Twilio may report the call ended before the voicemail's recording was
  // ready, so the call can already be logged as missed. Correct it first,
  // whether or not the transcription works, then transcribe: one after the
  // other, so the transcript's write to HubSpot is always the later one.
  c.executionCtx.waitUntil(
    Promise.resolve()
      .then(async () => {
        const call = await calls.get(id);
        if (call) await reconcileInboundCall(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), calls, call, opts);
      })
      .catch((err) => console.error('inbound reconcile', err))
      .then(() => runInboundTranscription(inboundTranscribeDeps(c.env), id, opts))
      .catch((err) => console.error('inbound transcription', err))
  );
  return c.body(null, 204);
});

// The number's status callback: the caller's leg ended. Twilio names the call
// only by its sid here. Log it on the contact after answering. A caller who
// hangs up at once can beat the voice webhook here, before the call is
// stored: store it now, or it would show as ringing forever.
twilioRoute.post('/twilio/voice/inbound/status', async (c) => {
  const params = await formParams(c);
  const { CallSid, CallStatus } = params;
  if (!CallSid || !FINAL.has(CallStatus)) return c.body(null, 204);
  const calls = d1InboundCallStore(c.env.DB);
  const call = (await calls.byCallSid(CallSid)) ?? (await storeInbound(c, params));
  await calls.setStatus(call.id, CallStatus, Math.floor(Date.now() / 1000));
  c.executionCtx.waitUntil(
    logInboundCall(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), calls, call.id, {
      now: Date.now(),
      baseUrl: c.env.PUBLIC_BASE_URL,
    }).catch((err) => console.error('inbound log', err))
  );
  return c.body(null, 204);
});

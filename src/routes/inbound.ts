import { Hono } from 'hono';
import { inboundTranscribeDeps, loadAppSettings, twilioClient } from '../lib/app-settings';
import { dismissWaitingCaller } from '../actions/calls';
import { d1DialStore, d1InboundCallStore, insertAudit, type InboundCall } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import type { AppEnv, Env } from '../types';
import { inboundCallPage, inboundRecordingCard } from '../views/inbound';
import { logCallBack, syncCallBack } from '../workflows/call-back';
import { dialState } from '../workflows/dial';
import {
  inboundRecordingState,
  logInboundCall,
  refreshCaller,
  runInboundTranscription,
  syncInboundCall,
} from '../workflows/inbound';
import { WorkflowError } from '../workflows/parties';
import { recordingState } from '../workflows/transcribe';
import { latestDial, mountDialRoutes, retryDialTranscription, setupOf } from './dialing';

export const inboundRoute = new Hono<AppEnv>();

// How many other calls from the same number a call's page lists.
const SAME_NUMBER = 10;

async function callOr404(env: Env, id: string): Promise<InboundCall> {
  const call = await d1InboundCallStore(env.DB).get(id);
  if (!call) throw new WorkflowError('That call isn’t in the app.', 404);
  return call;
}

// GET /inbound — the calls to the Twilio number are listed on Calls now.
inboundRoute.get('/', (c) => c.redirect('/calls?dir=in', 301));

// GET /inbound/:id — one call: who it was from, its outcome, recording and
// transcript, the other calls from that number, and calling them back. A
// caller who wasn't in HubSpot is looked up again, in case the number was
// added to a contact since. A call that ended but never reached HubSpot (its
// webhook was lost, or HubSpot failed) is logged now, and a transcript that
// never reached the logged call is written; the same for the latest call
// back. Those writes are idempotent, and run after the page is sent.
inboundRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  const calls = d1InboundCallStore(c.env.DB);
  const [found, settings, dial] = await Promise.all([
    callOr404(c.env, id),
    loadAppSettings(c.env),
    latestDial(c.env, 'inbound', id),
  ]);
  const [call, others] = await Promise.all([
    refreshCaller(hs, calls, found).catch((err: unknown) => {
      console.error('inbound caller lookup', err);
      return found;
    }),
    calls.fromNumber(found.from_number, SAME_NUMBER + 1),
  ]);
  const now = Date.now();
  const opts = { now, baseUrl: c.env.PUBLIC_BASE_URL };
  if (dial?.contact_id && dial.prospect_status && !dial.log_attempted_at) {
    c.executionCtx.waitUntil(
      logCallBack(hs, { dials: d1DialStore(c.env.DB), calls }, dial.id, opts).catch((err) =>
        console.error('call back log on view', err)
      )
    );
  } else if (dial?.logged_call_id && !dial.transcript_synced_at && dial.transcript_status === 'done') {
    c.executionCtx.waitUntil(
      syncCallBack(hs, d1DialStore(c.env.DB), dial, opts).catch((err) => console.error('call back sync on view', err))
    );
  }
  if (call.contact_id && call.status !== null && !call.log_attempted_at) {
    c.executionCtx.waitUntil(
      logInboundCall(hs, calls, call.id, opts).catch((err) => console.error('inbound log on view', err))
    );
  } else if (call.logged_call_id && !call.transcript_synced_at && call.transcript_status === 'done') {
    c.executionCtx.waitUntil(
      syncInboundCall(hs, calls, call, opts).catch((err) => console.error('inbound sync on view', err))
    );
  }
  const nowSec = Math.floor(now / 1000);
  return c.html(
    inboundCallPage(
      {
        call,
        recording: inboundRecordingState(call, nowSec),
        others: others.filter((o) => o.id !== call.id && o.from_number.startsWith('+')).slice(0, SAME_NUMBER),
        dial,
        dialState: dial ? dialState(dial, nowSec) : null,
        dialRecording: dial ? recordingState(dial, nowSec) : null,
        setup: setupOf(c.env, settings),
        portalId: c.env.HUBSPOT_PORTAL_ID,
        timeZone: settings.timeZone,
      },
      c.get('actor')
    )
  );
});

// POST /inbound/:id/dial and the rest: calling them back (routes/dialing.ts).
mountDialRoutes(inboundRoute, 'inbound');

// GET /inbound/:id/recording — the call's audio (or the voicemail), streamed
// from Twilio for the page's player. Only reachable through Access.
inboundRoute.get('/:id/recording', async (c) => {
  const call = await callOr404(c.env, c.req.param('id'));
  if (!call.recording_sid) throw new WorkflowError('This call has no recording.', 404);
  const upstream = await twilioClient(c.env).recording(call.recording_sid, {
    channels: null, // one mixed channel plays best in a browser
    range: c.req.header('Range') ?? null,
  });
  const headers = new Headers({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' });
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
});

// GET /inbound/:id/transcript — just the transcript card, for the page to poll.
inboundRoute.get('/:id/transcript', async (c) => {
  const call = await callOr404(c.env, c.req.param('id'));
  return c.html(inboundRecordingCard(call, inboundRecordingState(call, Math.floor(Date.now() / 1000))));
});

// POST /inbound/:id/transcribe — the rep retries a failed or stuck
// transcription: of the inbound call, or of a call back (with its dial_id).
inboundRoute.post('/:id/transcribe', async (c) => {
  const form = await c.req.parseBody();
  if (typeof form.dial_id === 'string') return retryDialTranscription(c, 'inbound', form.dial_id);
  const call = await callOr404(c.env, c.req.param('id'));
  const outcome = await runInboundTranscription(inboundTranscribeDeps(c.env), call.id, {
    now: Date.now(),
    baseUrl: c.env.PUBLIC_BASE_URL,
  });
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: 'call',
    taskId: call.id, // no task: the inbound call's id
    action: 'retry inbound transcription',
    outcome: outcome === 'failed' ? 'failed' : 'success',
    detail: { inboundCallId: call.id, outcome },
  });
  return c.redirect(`/inbound/${encodeURIComponent(call.id)}`, 303);
});

// POST /inbound/:id/dismiss — take the caller off the call queue's "Waiting
// on a call back" without calling them: a wrong number, a robocall. Only D1.
inboundRoute.post('/:id/dismiss', async (c) => {
  await dismissWaitingCaller(c, c.req.param('id'));
  return c.redirect('/queue/calls', 303);
});

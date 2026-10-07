// Click-to-call routes, shared by the pages a call starts from: a CALL task
// (/calls/:id), an interview (/meetings/:id) and a call to the Twilio number,
// called back (/inbound/:id). Each is mounted on its page's routes, so the
// paths below are relative to /calls, /meetings or /inbound.

import type { Context, Hono } from 'hono';
import {
  browserCallingConfigured,
  browserCallToken,
  insightDeps,
  loadAppSettings,
  transcribeDeps,
  twilioClient,
  twilioConfigured,
  type AppSettings,
} from '../lib/app-settings';
import { afterResponse } from '../lib/background';
import { saveNumbers } from '../actions/records';
import { dialPagePath } from '../lib/call-history';
import { d1DialStore, d1InboundCallStore, insertAudit, type Dial, type DialSubject } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import type { AppEnv, Env } from '../types';
import { liveDialStatus, transcriptCard, type CallsSetup } from '../views/calls';
import { startCallBack } from '../workflows/call-back';
import { readDialCall } from '../workflows/call-insight';
import { dialState, PHONE_FIELDS, startDial, startMeetingDial } from '../workflows/dial';
import { loadMeeting } from '../workflows/meeting-queue';
import { CONTACT_PHONE_FIELDS, type NumbersInput } from '../workflows/numbers';
import { loadTask, WorkflowError } from '../workflows/parties';
import { recordingState, runTranscription } from '../workflows/transcribe';

export function setupOf(env: Env, settings: AppSettings): CallsSetup {
  return {
    twilioReady: twilioConfigured(env),
    browserReady: browserCallingConfigured(env),
    callWith: settings.callWith,
    fromNumber: settings.twilioFromNumber,
    repPhone: settings.repPhone,
    whatsappOpens: settings.whatsappOpens,
    fromName: settings.fromName,
  };
}

const NOUNS: Record<DialSubject, string> = { task: 'task', meeting: 'interview', inbound: 'inbound call' };

// Looks up a dial started from this task, interview or inbound call, or fails
// with a 404.
export async function dialFor(env: Env, subject: DialSubject, id: string, dialId: string): Promise<Dial> {
  const dial = await d1DialStore(env.DB).get(dialId);
  if (!dial || dial.task_id !== id || dial.subject !== subject) {
    throw new WorkflowError(`That call isn’t on this ${NOUNS[subject]}.`, 404);
  }
  return dial;
}

// The latest dial started from this page's task, interview or inbound call.
export async function latestDial(env: Env, subject: DialSubject, id: string): Promise<Dial | null> {
  const dial = await d1DialStore(env.DB).latestForTask(id);
  return dial?.subject === subject ? dial : null;
}

async function dialFromForm(c: Context<AppEnv>, settings: AppSettings, subject: DialSubject): Promise<Dial> {
  const id = c.req.param('id') ?? '';
  const actor = c.get('actor');
  const form = await c.req.parseBody();
  // A call back dials the number the inbound call came from; the others, the
  // HubSpot number picked.
  const field = PHONE_FIELDS.find((f) => f.field === form.field)?.field;
  if (!field && subject !== 'inbound') throw new WorkflowError('Pick which number to call.');
  const twilio = twilioClient(c.env);
  const mode = settings.callWith;
  if (!settings.twilioFromNumber || (mode === 'phone' && !settings.repPhone)) {
    throw new WorkflowError(
      mode === 'phone'
        ? 'Pick the number to call from and your phone in Settings first.'
        : 'Pick the number to call from in Settings first.'
    );
  }

  const workflow = subject === 'meeting' ? 'meeting' : 'call';
  try {
    const deps = { hs: createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), twilio, dials: d1DialStore(c.env.DB) };
    const opts = {
      now: Date.now(),
      baseUrl: c.env.PUBLIC_BASE_URL,
      fromNumber: settings.twilioFromNumber,
      mode,
      repNumber: settings.repPhone,
      record: settings.recordCalls,
    };
    const dial =
      subject === 'inbound'
        ? await startCallBack({ ...deps, calls: d1InboundCallStore(c.env.DB) }, id, opts)
        : subject === 'task'
          ? await startDial(deps, id, field!, opts)
          : await startMeetingDial(deps, id, field!, opts);
    await insertAudit(c.env.DB, {
      actor,
      workflow,
      taskId: id,
      action: `dial ${dial.to_number} via ${dial.rep_number}`,
      outcome: 'success',
      detail: { dialId: dial.id, repCallSid: dial.rep_call_sid },
    });
    return dial;
  } catch (err) {
    await insertAudit(c.env.DB, {
      actor,
      workflow,
      taskId: id,
      action: 'dial',
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function mountDialRoutes(route: Hono<AppEnv>, subject: DialSubject): void {
  // POST /:id/dial — ring the rep's phone; pressing 1 dials the contact.
  // Calling from the browser, it only records the dial, and answers the page's
  // script with JSON: the dial's id and a token for Twilio's Voice SDK, with
  // which the page starts the call itself.
  route.post('/:id/dial', async (c) => {
    const id = c.req.param('id');
    const settings = await loadAppSettings(c.env);
    if (settings.callWith === 'phone') {
      await dialFromForm(c, settings, subject);
      return c.redirect(dialPagePath(subject, id), 303);
    }
    try {
      // The token first, so a dial the page can't start doesn't hold up the task.
      const token = await browserCallToken(c.env, c.get('actor'), Date.now());
      const dial = await dialFromForm(c, settings, subject);
      return c.json({ dialId: dial.id, label: dial.contact_label, token });
    } catch (err) {
      // The page shows the message by the Call buttons; nothing was dialled.
      if (err instanceof WorkflowError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // POST /:id/numbers — save the contact's phone and mobile (each with an
  // extension) in HubSpot, typed on the page. The contact is the task's or
  // the interview's, never one named by the form. The page posts it in the
  // background, since leaving the page would end a browser call and lose the
  // notes being typed: it gets JSON back. Without the page's script, it
  // lands back on the page.
  if (subject !== 'inbound') {
    route.post('/:id/numbers', async (c) => {
      const id = c.req.param('id');
      const form = await c.req.parseBody();
      const text = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : null);
      const input: NumbersInput = {};
      for (const { field } of CONTACT_PHONE_FIELDS) {
        const number = text(field);
        const was = text(`${field}_was`) ?? undefined;
        if (number !== null) input[field] = { number, ext: text(`${field}_ext`) ?? '', was };
      }
      const json = (c.req.header('Accept') ?? '').includes('application/json');
      try {
        const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
        const { contact } = subject === 'task' ? await loadTask(hs, id, 'CALL') : await loadMeeting(hs, id);
        const changes = await saveNumbers(c, contact.id, input, {
          workflow: subject === 'meeting' ? 'meeting' : 'call',
          taskId: id,
        });
        return json ? c.json({ saved: Object.keys(changes).length }) : c.redirect(dialPagePath(subject, id), 303);
      } catch (err) {
        if (json && err instanceof WorkflowError) return c.json({ error: err.message }, err.status);
        throw err;
      }
    });
  }

  // POST /:id/dial/:dialId/end — the page's browser call is over. If it never
  // connected (the mic was refused, the SDK failed), that frees the task to be
  // dialled again. If it did, the page shows the log form without waiting on
  // the TwiML App's status callback, which still corrects the status.
  route.post('/:id/dial/:dialId/end', async (c) => {
    const dial = await dialFor(c.env, subject, c.req.param('id'), c.req.param('dialId'));
    await d1DialStore(c.env.DB).endBrowserCall(dial.id, Math.floor(Date.now() / 1000));
    return c.body(null, 204);
  });

  // GET /:id/recording/:dialId — the call's audio for the page's player.
  // Streamed from Twilio, which keeps the recording and requires auth; the rep
  // reaches it only through Access. Range is passed through so the player seeks.
  route.get('/:id/recording/:dialId', async (c) => {
    const dial = await dialFor(c.env, subject, c.req.param('id'), c.req.param('dialId'));
    if (!dial.recording_sid) throw new WorkflowError('This call has no recording.', 404);
    const upstream = await twilioClient(c.env).recording(dial.recording_sid, {
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

  // GET /:id/dial/:dialId/status — just the call's status, which the page
  // fetches again while the call is live (D1 only, no HubSpot).
  route.get('/:id/dial/:dialId/status', async (c) => {
    const id = c.req.param('id');
    const dial = await dialFor(c.env, subject, id, c.req.param('dialId'));
    c.header('Cache-Control', 'no-store');
    return c.html(
      liveDialStatus(dialPagePath(subject, id), { dial, dialState: dialState(dial, Math.floor(Date.now() / 1000)) })
    );
  });

  // GET /:id/transcript/:dialId — just the transcript card, which the page
  // swaps in while it waits, so notes being typed aren't lost.
  route.get('/:id/transcript/:dialId', async (c) => {
    const id = c.req.param('id');
    const dial = await dialFor(c.env, subject, id, c.req.param('dialId'));
    return c.html(transcriptCard(dialPagePath(subject, id), dial, recordingState(dial, Math.floor(Date.now() / 1000))));
  });

  // POST /:id/transcribe — the rep retries a failed or stuck transcription.
  // An inbound call's page has its own, which also retries the inbound
  // call's recording, and hands a dial's retry to retryDialTranscription.
  if (subject !== 'inbound') {
    route.post('/:id/transcribe', async (c) => {
      const form = await c.req.parseBody();
      return retryDialTranscription(c, subject, typeof form.dial_id === 'string' ? form.dial_id : '');
    });
  }
}

export async function retryDialTranscription(c: Context<AppEnv>, subject: DialSubject, dialId: string) {
  const id = c.req.param('id') ?? '';
  const dial = await dialFor(c.env, subject, id, dialId);
  const outcome = await runTranscription(transcribeDeps(c.env), dial.id, {
    now: Date.now(),
    baseUrl: c.env.PUBLIC_BASE_URL,
  });
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: subject === 'meeting' ? 'meeting' : 'call',
    taskId: id,
    action: 'retry transcription',
    outcome: outcome === 'failed' ? 'failed' : 'success',
    detail: { dialId: dial.id, outcome },
  });
  if (outcome === 'done')
    afterResponse(c, 'reading call for coaching', () => readDialCall(insightDeps(c.env), dial.id, Date.now()));
  return c.redirect(dialPagePath(subject, id), 303);
}

// Calling back someone who rang the Twilio number, from the call's Inbound
// page, through Twilio like any other dial (dial.ts): the rep's phone rings
// first and pressing 1 dials them, or the rep talks through the browser. The
// caller sees the Twilio number, not the rep's own.
//   1. startCallBack dials the number Twilio reported for the inbound call,
//      never one from the form, from the number they called (callBackFrom).
//   2. When Twilio reports how the caller's leg ended, a call back to a
//      HubSpot contact is logged on them (logCallBack), once, like an
//      inbound call. There's no form: the outcome is what Twilio saw.
//   3. A transcript that finishes later is added to that call (syncCallBack).
// A caller who isn't in HubSpot is only called; nothing is logged.

import type { Dial, DialStore, InboundCallStore } from '../lib/db';
import { HubSpotApiError, type HubSpot } from '../lib/hubspot';
import { formatPhone, toE164 } from '../lib/phone';
import { escapeHtml } from '../lib/richtext';
import type { Twilio } from '../lib/twilio';
import { dialTranscript, transcriptHtml, type CallTranscript } from '../lib/transcript';
import { CALL_OUTCOMES, HUBSPOT_STATUS } from './call-logged';
import { beginDial, dialState, type DialDeps, type DialOptions } from './dial';
import { WorkflowError } from './parties';
import type { TranscribeOptions } from './transcribe';

export async function startCallBack(
  deps: Pick<DialDeps, 'twilio' | 'dials'> & { calls: InboundCallStore },
  inboundId: string,
  opts: DialOptions
): Promise<Dial> {
  const call = await deps.calls.get(inboundId);
  if (!call) throw new WorkflowError('That call isn’t in the app.', 404);
  const to = toE164(call.from_number);
  if (!to) throw new WorkflowError('They called from a hidden number, so there’s no number to call back.');
  const fromNumber = await callBackFrom(deps.twilio, call.to_number, opts.fromNumber);
  return beginDial(
    deps,
    { subject: 'inbound', id: call.id },
    { to, contactId: call.contact_id ?? '', label: call.contact_label ?? formatPhone(to) },
    { ...opts, fromNumber }
  );
}

// The caller ID for a call back: the number they called, so they recognise
// it, as long as it's still one of the account's voice numbers (Settings may
// have moved to another). Otherwise, or if Twilio can't list them, the
// number picked in Settings.
export async function callBackFrom(twilio: Twilio, calledNumber: string, settingsNumber: string): Promise<string> {
  if (calledNumber === settingsNumber) return settingsNumber;
  try {
    const { voice } = await twilio.listNumbers();
    return voice.some((n) => n.phoneNumber === calledNumber) ? calledNumber : settingsNumber;
  } catch (err) {
    console.error('call back caller ID', err);
    return settingsNumber;
  }
}

const OUTCOME = {
  connected: CALL_OUTCOMES.find((o) => o.value === 'connected')!.disposition,
  busy: CALL_OUTCOMES.find((o) => o.value === 'busy')!.disposition,
  no_answer: CALL_OUTCOMES.find((o) => o.value === 'no_answer')!.disposition,
};

// The logged HubSpot call's notes: the summary, what happened, a link back
// to the app, and the transcript. Built whole from the dial every time, so
// writing it again (a transcript that lands later) replaces it.
export function callBackBody(dial: Dial, transcript: CallTranscript | null, baseUrl: string): string {
  // Logged once Twilio reported the caller's leg, so the dial has ended: any
  // time far enough past it reads it as such.
  const state = dialState(dial, Number.MAX_SAFE_INTEGER);
  const summary = state.kind === 'ended' ? state.summary : '';
  const link = `${baseUrl.replace(/\/+$/, '')}/inbound/${encodeURIComponent(dial.task_id)}`;
  const line = `<p>${escapeHtml(summary)} Called back from Causeway after they rang ${escapeHtml(formatPhone(dial.from_number))}. <a href="${escapeHtml(link)}">${dial.recording_sid ? 'Recording in the app' : 'Details in the app'}</a>.</p>`;
  const lines = transcript?.summary.length
    ? `<p><strong>Summary</strong></p><ul>${transcript.summary.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
    : '';
  const turns = transcript ? `<p><strong>Transcript</strong></p>${transcriptHtml(transcript.turns)}` : '';
  return `${lines}${line}${turns}`;
}

// Logs a finished call back on the caller's HubSpot contact, once: only a
// dial to a contact whose leg Twilio reported (they were dialled). The marker
// goes in before the write, as for an inbound call. Returns the HubSpot call
// id, or null if there was nothing to log.
export async function logCallBack(
  hs: HubSpot,
  deps: { dials: DialStore; calls: InboundCallStore },
  dialId: string,
  opts: TranscribeOptions
): Promise<string | null> {
  const dial = await deps.dials.get(dialId);
  if (dial?.subject !== 'inbound' || !dial.contact_id || !dial.prospect_status || dial.logged_call_id) return null;
  const inbound = await deps.calls.get(dial.task_id);
  if (!inbound) return null;
  const at = new Date(opts.now).toISOString();
  if (!(await deps.dials.markLogAttempted(dial.id, at))) return null;

  const transcript = dialTranscript(dial);
  const answered = dial.prospect_status === 'completed';
  let loggedId: string;
  try {
    loggedId = await hs.logCall(
      {
        title: `Call back to ${dial.contact_label}`,
        bodyHtml: callBackBody(dial, transcript, opts.baseUrl),
        status: HUBSPOT_STATUS[dial.prospect_status] ?? 'COMPLETED',
        disposition: answered ? OUTCOME.connected : dial.prospect_status === 'busy' ? OUTCOME.busy : OUTCOME.no_answer,
        durationMs: dial.prospect_duration_sec === null ? null : dial.prospect_duration_sec * 1000,
        fromNumber: dial.from_number,
        toNumber: dial.to_number,
        ownerId: inbound.owner_id,
        at: new Date(dial.started_sec * 1000).toISOString(),
        direction: 'OUTBOUND',
      },
      { contactId: dial.contact_id, companyId: inbound.company_id }
    );
  } catch (err) {
    // A 4xx answer means HubSpot created nothing, so a retry may log.
    if (err instanceof HubSpotApiError && err.status >= 400 && err.status < 500)
      await deps.dials.clearLogAttempt(dial.id);
    throw err;
  }
  await deps.dials.setLoggedCall(dial.id, loggedId);
  if (transcript) {
    await deps.dials.markTranscriptSynced(dial.id, at);
  } else {
    // The transcript may have landed while the call was being logged.
    const latest = await deps.dials.get(dial.id);
    if (latest) await syncCallBack(hs, deps.dials, latest, opts);
  }
  return loggedId;
}

// Writes a finished transcript onto the logged call back, once. Safe to call
// from both sides: after transcription, and after logging.
export async function syncCallBack(
  hs: HubSpot,
  dials: DialStore,
  dial: Dial,
  opts: TranscribeOptions
): Promise<boolean> {
  const transcript = dialTranscript(dial);
  if (!transcript || !dial.logged_call_id || dial.transcript_synced_at) return false;
  await hs.updateObject('calls', dial.logged_call_id, { hs_call_body: callBackBody(dial, transcript, opts.baseUrl) });
  await dials.markTranscriptSynced(dial.id, new Date(opts.now).toISOString());
  return true;
}

// Calls to the Twilio number, forwarded to the rep's phone:
//   1. Twilio posts the call to /twilio/voice/inbound. The app looks the
//      caller up in HubSpot by number (findCaller), stores the call, and
//      answers with the recording notice (when recording is on) and a <Dial>
//      to the rep's phone.
//   2. The rep picks up and hears who's calling. Pressing 1 connects them and
//      starts the recording; otherwise the caller can leave a voicemail.
//   3. When the caller hangs up, Twilio reports the final status (the
//      number's status callback), and the call is logged on the contact's
//      HubSpot timeline (logInboundCall). A transcript that finishes later is
//      added to that call (syncInboundCall).
// A caller who isn't in HubSpot is only listed in the app.

import type { InboundCall, InboundCaller, InboundCallStore } from '../lib/db';
import { HubSpotApiError, type CallStatus, type HubSpot, type HubSpotObject, type SearchFilter } from '../lib/hubspot';
import { formatPhone, toE164 } from '../lib/phone';
import { escapeHtml } from '../lib/richtext';
import { dialTranscript, transcriptHtml, type CallTranscript } from '../lib/transcript';
import { randomToken } from '../lib/tracking';
import { CALL_OUTCOMES } from './call-logged';
import { formatDuration } from './dial';
import { COMPANY_PROPS, CONTACT_PROPS, companyName, contactName } from './parties';
import {
  transcribeRecording,
  type RecordingDeps,
  type RecordingState,
  type TranscribeOptions,
  type TranscribeOutcome,
} from './transcribe';

// HubSpot keeps each number's digits without the country code in these
// properties, whatever format it was typed in.
const SEARCHABLE_PHONE = ['hs_searchable_calculated_phone_number', 'hs_searchable_calculated_mobile_number'];

// What the searchable properties could hold for this number. A North
// American number is its 10 digits; for anything else the country code's
// length (1 to 3 digits) isn't known, so each is tried, and findCaller checks
// the match against the number as typed.
export function phoneCandidates(e164: string): string[] {
  const digits = e164.replace(/\D/g, '');
  if (/^1\d{10}$/.test(digits)) return [digits.slice(1)];
  return [1, 2, 3].map((n) => digits.slice(n)).filter((d) => d.length >= 6);
}

export interface Caller {
  contact: HubSpotObject;
  company: HubSpotObject | null;
}

// The HubSpot contact whose phone or mobile is this number, the most recently
// changed if there are several.
export async function findCaller(hs: HubSpot, e164: string): Promise<Caller | null> {
  const values = phoneCandidates(e164);
  if (!values.length) return null;
  const groups: SearchFilter[][] = SEARCHABLE_PHONE.map((propertyName) => [{ propertyName, operator: 'IN', values }]);
  const found = await hs.searchContacts(groups, [...CONTACT_PROPS, 'hubspot_owner_id'], 10);
  const contact = found.find((c) => toE164(c.properties.phone) === e164 || toE164(c.properties.mobilephone) === e164);
  if (!contact) return null;
  const companyIds = await hs.associatedIds('contacts', contact.id, 'companies');
  const company = companyIds.length ? await hs.getObject('companies', companyIds[0], COMPANY_PROPS) : null;
  return { contact, company };
}

// The row's columns for a caller found in HubSpot, or none.
export function callerColumns(caller: Caller | null): InboundCaller {
  const company = caller ? companyName(caller.company) : null;
  return {
    contact_id: caller?.contact.id ?? null,
    company_id: caller?.company?.id ?? null,
    owner_id: caller?.contact.properties.hubspot_owner_id || null,
    contact_label: caller
      ? company
        ? `${contactName(caller.contact)} at ${company}`
        : contactName(caller.contact)
      : null,
  };
}

// What Twilio's webhook says about the caller, beyond their number. Twilio
// sends where the number is registered with every call, and the caller ID
// name only when Caller Name Lookup is on for the number (a paid add-on).
export interface CallerDetails {
  city: string | null;
  state: string | null;
  country: string | null;
  name: string | null;
}

export interface InboundInput {
  callSid: string;
  from: string; // as Twilio reports it: E.164, or a word like "anonymous"
  to: string;
  details?: CallerDetails;
  repNumber: string | null; // null: nobody to ring, straight to voicemail
  record: boolean;
  now: number; // epoch ms
  newId?: () => string;
}

// Stores a new call to the Twilio number, with the HubSpot contact it's from.
// Twilio may post the same call twice; the second gets the first's row. A
// HubSpot failure doesn't stop the call: it rings through as an unknown caller.
export async function startInbound(
  deps: { hs: HubSpot; calls: InboundCallStore },
  input: InboundInput
): Promise<InboundCall> {
  const existing = await deps.calls.byCallSid(input.callSid);
  if (existing) return existing;

  const e164 = toE164(input.from);
  let caller: Caller | null = null;
  if (e164) {
    try {
      caller = await findCaller(deps.hs, e164);
    } catch (err) {
      console.error('caller lookup', err);
    }
  }
  await deps.calls.create({
    id: (input.newId ?? randomToken)(),
    call_sid: input.callSid,
    from_number: e164 ?? input.from,
    to_number: input.to,
    rep_number: input.repNumber,
    started_sec: Math.floor(input.now / 1000),
    ...callerColumns(caller),
    record: input.record ? 1 : 0,
    from_city: input.details?.city || null,
    from_state: input.details?.state || null,
    from_country: input.details?.country || null,
    caller_name: callerIdName(input.details?.name),
  });
  const saved = await deps.calls.byCallSid(input.callSid);
  if (!saved) throw new Error(`inbound call ${input.callSid} missing right after insert`);
  return saved;
}

// Looks an unknown caller up in HubSpot again, for their call's page: the
// number may have been added to a contact since they called. Returns the call
// with its contact filled in, or as it was. Logging it (logInboundCall) then
// puts the call on that contact's timeline.
export async function refreshCaller(hs: HubSpot, calls: InboundCallStore, call: InboundCall): Promise<InboundCall> {
  if (call.contact_id) return call;
  const e164 = toE164(call.from_number);
  if (!e164) return call;
  const caller = await findCaller(hs, e164);
  if (!caller || !(await calls.setCaller(call.id, callerColumns(caller)))) return call;
  return (await calls.get(call.id)) ?? call;
}

// Twilio's caller ID name, when it's a name. Carriers send placeholders for
// numbers they have no name for, and the number itself for some.
export function callerIdName(raw: string | null | undefined): string | null {
  const name = raw?.trim();
  if (!name || !/[a-z]/i.test(name)) return null;
  if (/^(unknown|unavailable|anonymous|private|restricted|wireless caller|out of area)$/i.test(name)) return null;
  return name;
}

// Where the caller's number is registered: "Salt Lake City, UT". The country
// only for a number from outside the US.
export function callerPlace(call: Pick<InboundCall, 'from_city' | 'from_state' | 'from_country'>): string | null {
  const country = call.from_country && call.from_country !== 'US' ? call.from_country : null;
  const parts = [titleCase(call.from_city), call.from_state, country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Twilio sends cities in capitals: "SALT LAKE CITY".
function titleCase(value: string | null): string | null {
  if (!value) return null;
  return value.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

// Who's calling, for the rep's page and HubSpot: the HubSpot contact, else
// the caller ID name, else the number.
export function callerName(call: Pick<InboundCall, 'contact_label' | 'caller_name' | 'from_number'>): string {
  return (
    call.contact_label ??
    call.caller_name ??
    (call.from_number.startsWith('+') ? formatPhone(call.from_number) : 'Unknown caller')
  );
}

// The caller's number, when their name is shown instead of it.
export function shownNumber(call: Pick<InboundCall, 'contact_label' | 'caller_name' | 'from_number'>): string | null {
  if (!call.from_number.startsWith('+')) return null;
  return callerName(call) === formatPhone(call.from_number) ? null : formatPhone(call.from_number);
}

export type InboundOutcome = 'live' | 'answered' | 'voicemail' | 'missed';

// The outcome as a one-word tag, for lists of calls.
export const INBOUND_TAGS: Record<InboundOutcome, string> = {
  live: 'Live',
  answered: 'Inbound',
  voicemail: 'Voicemail',
  missed: 'Missed',
};

export function inboundOutcome(call: InboundCall): InboundOutcome {
  if (call.answered_at) return call.status === null ? 'live' : 'answered';
  if (call.voicemail && call.recording_sid) return 'voicemail';
  return call.status === null ? 'live' : 'missed';
}

export function inboundSummary(call: InboundCall): string {
  switch (inboundOutcome(call)) {
    case 'live':
      return call.answered_at ? 'On the call.' : 'Ringing.';
    case 'answered':
      return call.talk_sec === null ? 'You answered.' : `You answered. Call length ${formatDuration(call.talk_sec)}.`;
    case 'voicemail':
      return call.recording_duration_sec === null
        ? 'They left a voicemail.'
        : `They left a voicemail (${formatDuration(call.recording_duration_sec)}).`;
    case 'missed': {
      const rang =
        call.ended_sec === null ? '' : ` They hung up after ${formatDuration(call.ended_sec - call.started_sec)}.`;
      return call.voicemail ? `Missed. No voicemail left.${rang}` : `Missed.${rang}`;
    }
  }
}

const OUTCOME_DISPOSITION: Record<Exclude<InboundOutcome, 'live'>, string> = {
  answered: CALL_OUTCOMES.find((o) => o.value === 'connected')!.disposition,
  voicemail: CALL_OUTCOMES.find((o) => o.value === 'left_voicemail')!.disposition,
  missed: CALL_OUTCOMES.find((o) => o.value === 'no_answer')!.disposition,
};

const OUTCOME_TITLE: Record<Exclude<InboundOutcome, 'live'>, string> = {
  answered: 'Call from',
  voicemail: 'Voicemail from',
  missed: 'Missed call from',
};

const HUBSPOT_STATUS: Record<Exclude<InboundOutcome, 'live'>, CallStatus> = {
  answered: 'COMPLETED',
  voicemail: 'NO_ANSWER',
  missed: 'NO_ANSWER',
};

export interface InboundCallFields {
  title: string;
  disposition: string;
  status: CallStatus;
  durationMs: number | null; // talk time, or the voicemail's length
  bodyHtml: string;
}

// The HubSpot call's title, outcome, length and notes. Built whole from the
// row every time, so writing it again (a voicemail or transcript that lands
// after the call was logged) replaces it.
export function inboundCallFields(
  call: InboundCall,
  transcript: CallTranscript | null,
  baseUrl: string
): InboundCallFields {
  const outcome = inboundOutcome(call);
  const key = outcome === 'live' ? 'missed' : outcome;
  const link = `${baseUrl.replace(/\/+$/, '')}/inbound/${encodeURIComponent(call.id)}`;
  const line = `<p>${escapeHtml(inboundSummary(call))} Inbound call to ${escapeHtml(formatPhone(call.to_number))}, forwarded by Causeway. <a href="${escapeHtml(link)}">${call.recording_sid ? 'Recording in the app' : 'Details in the app'}</a>.</p>`;
  const summary = transcript?.summary.length
    ? `<p><strong>Summary</strong></p><ul>${transcript.summary.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
    : '';
  const turns = transcript ? `<p><strong>Transcript</strong></p>${transcriptHtml(transcript.turns)}` : '';
  const seconds = key === 'answered' ? call.talk_sec : key === 'voicemail' ? call.recording_duration_sec : null;
  return {
    title: `${OUTCOME_TITLE[key]} ${callerName(call)}`,
    disposition: OUTCOME_DISPOSITION[key],
    status: HUBSPOT_STATUS[key],
    durationMs: seconds === null ? null : seconds * 1000,
    bodyHtml: `${summary}${line}${turns}`,
  };
}

// Logs an ended call on the caller's HubSpot contact, once. The marker goes
// in before the write, like runCallLogged: if HubSpot created the call but
// the response was lost, it isn't logged twice. Returns the HubSpot call id,
// or null if there was nothing to log (unknown caller, still live, done).
export async function logInboundCall(
  hs: HubSpot,
  calls: InboundCallStore,
  id: string,
  opts: TranscribeOptions
): Promise<string | null> {
  const call = await calls.get(id);
  if (!call?.contact_id || call.status === null || call.logged_call_id) return null;
  const at = new Date(opts.now).toISOString();
  if (!(await calls.markLogAttempted(id, at))) return null;

  const transcript = dialTranscript(call);
  let loggedId: string;
  try {
    loggedId = await hs.logCall(
      {
        ...inboundCallFields(call, transcript, opts.baseUrl),
        fromNumber: call.from_number,
        toNumber: call.to_number,
        ownerId: call.owner_id,
        at: new Date(call.started_sec * 1000).toISOString(),
        direction: 'INBOUND',
      },
      { contactId: call.contact_id, companyId: call.company_id }
    );
  } catch (err) {
    // A 4xx answer means HubSpot created nothing, so a retry may log.
    if (err instanceof HubSpotApiError && err.status >= 400 && err.status < 500) await calls.clearLogAttempt(id);
    throw err;
  }
  await calls.setLoggedCall(id, loggedId);
  if (transcript) await calls.markTranscriptSynced(id, at);
  // The recording or transcript may have landed while the call was being
  // logged; this call was built from the row as it was before.
  const latest = await calls.get(id);
  if (latest && (latest.recording_sid !== call.recording_sid || latest.transcript_status !== call.transcript_status)) {
    await reconcileInboundCall(hs, calls, latest, opts);
  }
  return loggedId;
}

// Rewrites the logged HubSpot call from the row as it is now: its title,
// outcome, length and notes. For a voicemail whose recording arrived after
// the call was logged as missed, and for a finished transcript. Returns
// false if the call isn't logged yet (logging will write it all).
export async function reconcileInboundCall(
  hs: HubSpot,
  calls: InboundCallStore,
  call: InboundCall,
  opts: TranscribeOptions
): Promise<boolean> {
  if (!call.logged_call_id) return false;
  const transcript = dialTranscript(call);
  const fields = inboundCallFields(call, transcript, opts.baseUrl);
  await hs.updateObject('calls', call.logged_call_id, {
    hs_call_title: fields.title,
    hs_call_disposition: fields.disposition,
    hs_call_status: fields.status,
    ...(fields.durationMs === null ? {} : { hs_call_duration: String(fields.durationMs) }),
    hs_call_body: fields.bodyHtml,
  });
  if (transcript) await calls.markTranscriptSynced(call.id, new Date(opts.now).toISOString());
  return true;
}

// Writes the finished transcript onto the logged HubSpot call, once. Safe to
// call from both sides: after transcription, and after logging.
export async function syncInboundCall(
  hs: HubSpot,
  calls: InboundCallStore,
  call: InboundCall,
  opts: TranscribeOptions
): Promise<boolean> {
  if (call.transcript_status !== 'done' || !call.logged_call_id || call.transcript_synced_at) return false;
  return reconcileInboundCall(hs, calls, call, opts);
}

export interface InboundTranscribeDeps extends RecordingDeps<InboundCall> {
  calls: InboundCallStore;
  hs: HubSpot;
}

// An answered call's recording has the caller on the first channel (theirs
// is the leg that's recorded) and the rep on the second. A voicemail is just
// the caller.
export function runInboundTranscription(
  deps: InboundTranscribeDeps,
  id: string,
  opts: TranscribeOptions
): Promise<TranscribeOutcome> {
  return transcribeRecording(
    deps,
    id,
    opts.now,
    (call) => ({
      speakers: call.answered_at ? ['prospect', 'rep'] : ['prospect'],
      label: callerName(call),
    }),
    (call) => syncInboundCall(deps.hs, deps.calls, call, opts)
  );
}

// Same waits as a dial's recordingState.
const RECORDING_WAIT_SEC = 10 * 60;
const TRANSCRIBE_START_GRACE_SEC = 2 * 60;
const TRANSCRIBE_STALE_SEC = 5 * 60;

// Where an inbound call's recording (of the call, or the voicemail) and its
// transcript stand, for the page. Pure.
export function inboundRecordingState(call: InboundCall, nowSec: number): RecordingState {
  if (call.transcript_status === 'done') return { kind: 'done' };
  if (call.transcript_status === 'failed') {
    const message = call.transcript_error ?? 'Transcription failed.';
    return { kind: 'failed', message, canRetry: call.recording_sid !== null };
  }
  if (call.transcript_status === 'transcribing') {
    const stuck = nowSec - (call.transcript_started_sec ?? nowSec) > TRANSCRIBE_STALE_SEC;
    return stuck
      ? { kind: 'failed', message: 'Transcription stopped without finishing.', canRetry: true }
      : { kind: 'pending', message: 'Transcribing the call…' };
  }
  const endedSec = call.ended_sec ?? nowSec;
  if (call.recording_sid) {
    return nowSec - endedSec < TRANSCRIBE_START_GRACE_SEC
      ? { kind: 'pending', message: 'Transcribing the call…' }
      : { kind: 'failed', message: 'The recording is in, but transcription never started.', canRetry: true };
  }
  const expected = (call.record && call.answered_at) || call.voicemail;
  if (!expected) return { kind: 'none' };
  if (call.status === null) {
    return { kind: 'pending', message: call.answered_at ? 'Recording the call…' : 'Waiting for their voicemail…' };
  }
  // A caller who hangs up without speaking leaves no voicemail.
  if (!call.answered_at)
    return nowSec - endedSec < 60 ? { kind: 'pending', message: 'Waiting for the voicemail…' } : { kind: 'none' };
  return nowSec - endedSec < RECORDING_WAIT_SEC
    ? { kind: 'pending', message: 'Waiting for the recording from Twilio…' }
    : { kind: 'failed', message: 'Twilio never sent the recording for this call.', canRetry: false };
}

import { html, raw } from 'hono/html';
import { formatLocal } from '../lib/dates';
import type { Dial, InboundCall } from '../lib/db';
import { formatPhone, toE164 } from '../lib/phone';
import { isLive, type DialState } from '../workflows/dial';
import { callerName, callerPlace, inboundOutcome, inboundSummary, shownNumber } from '../workflows/inbound';
import type { RecordingState } from '../workflows/transcribe';
import {
  browserCallPanel,
  browserCallScripts,
  dialStatus,
  LIVE_STATUS_SCRIPT,
  liveDialStatus,
  POLL_SCRIPT,
  recordingCard,
  setupReady,
  setupWarning,
  transcriptCard,
  type CallsSetup,
} from './calls';
import { flash as flashBox, layout, recordUrl, type Html } from './layout';

// While a call is live, the page reloads itself this often to show its status.
export const LIVE_REFRESH_SEC = 4;

export interface InboundSetup {
  twilioReady: boolean;
  fromNumber: string | null; // the Twilio number people call
  repPhone: string | null;
}

export function setupNote(setup: InboundSetup): Html | '' {
  if (!setup.twilioReady) {
    return flashBox('warn', html`Twilio isn’t connected yet. See <a href="/settings">Settings</a>.`);
  }
  if (!setup.repPhone) {
    return flashBox(
      'warn',
      html`No phone is picked in <a href="/settings">Settings</a>, so callers go straight to voicemail.`
    );
  }
  return '';
}

export function inboundRecordingCard(call: InboundCall, state: RecordingState): Html {
  return recordingCard(call, state, {
    id: 'inbound-recording', // the call back's card, if any, is 'transcript'
    poll: `/inbound/${call.id}/transcript`,
    audio: `/inbound/${call.id}/recording`,
    retry: `/inbound/${call.id}/transcribe`,
    retryField: null,
    pendingNote: call.contact_id ? 'It’s added to the call in HubSpot when it’s ready.' : '',
  });
}

export interface InboundCallPageState {
  call: InboundCall;
  recording: RecordingState;
  others: InboundCall[]; // the other calls from this number, newest first
  dial: Dial | null; // the latest call back
  dialState: DialState | null;
  dialRecording: RecordingState | null;
  setup: CallsSetup;
  portalId: string;
  timeZone: string;
}

// Where the latest call back stands in HubSpot, once it's over.
function callBackLog(state: InboundCallPageState): Html | '' {
  const { dial, call } = state;
  if (!dial || !state.dialState || isLive(state.dialState)) return '';
  if (!dial.contact_id) return html`<p class="muted">They aren’t in HubSpot, so the call back is only here.</p>`;
  const contact = recordUrl(state.portalId, '0-1', dial.contact_id);
  if (dial.logged_call_id) {
    return html`<p class="muted">The call back is logged on the <a href="${contact}" target="_blank" rel="noopener">contact’s timeline</a>.</p>`;
  }
  if (!dial.prospect_status) return html`<p class="muted">They were never dialled, so nothing was logged.</p>`;
  if (dial.log_attempted_at) {
    return html`<p class="muted">Logging the call back stopped without an answer from HubSpot. Check the <a href="${contact}" target="_blank" rel="noopener">contact’s timeline</a> and add it by hand if it’s missing.</p>`;
  }
  return call.contact_id ? html`<p class="muted">Logging the call back on the contact. Refresh in a moment.</p>` : '';
}

// Calling them back from the Twilio number, the same way as a call task.
function callBackCard(state: InboundCallPageState, canDial: boolean, browser: boolean): Html {
  const { call, setup } = state;
  const e164 = toE164(call.from_number);
  const from = setup.fromNumber ? formatPhone(setup.fromNumber) : 'your Twilio number';
  if (!e164) {
    return html`<div class="card">
      <h2>Call them back</h2>
      <p class="muted">They called from a hidden number, so there’s no number to call back.</p>
    </div>`;
  }
  return html`<div class="card" id="call-back">
    <h2>Call them back</h2>
    ${setupWarning(setup)}
    <form method="post" action="/inbound/${call.id}/dial" class="row" ${browser ? 'data-browser-call' : ''}>
      <span><strong>${formatPhone(e164)}</strong></span>
      <button type="submit" class="primary" ${canDial ? '' : 'disabled'}>Call back</button>
    </form>
    <p class="muted">${
      browser
        ? `You talk through this page, calling from ${from}, so they see the number they called. Allow the microphone when the browser asks, and keep the page open until you hang up.`
        : `Your phone rings first. Answer and press 1 to dial them from ${from}, so they see the number they called, not yours.`
    } ${call.contact_id ? 'It’s logged on their HubSpot contact when it ends.' : ''}</p>
    ${callBackLog(state)}
  </div>`;
}

function othersCard(state: InboundCallPageState): Html | '' {
  if (!state.others.length) return '';
  return html`<div class="card">
    <h2>Other calls from this number</h2>
    <ul class="summary">
      ${state.others.map(
        (o) =>
          html`<li><a href="/inbound/${o.id}">${formatLocal(o.started_sec * 1000, state.timeZone)}</a> <span class="muted">${inboundSummary(o)}</span></li>`
      )}
    </ul>
  </div>`;
}

export function inboundCallPage(state: InboundCallPageState, actor: string): Html {
  const { call, recording, portalId, timeZone } = state;
  const page = `/inbound/${call.id}`;
  const live = inboundOutcome(call) === 'live';
  const dialLive = state.dialState !== null && isLive(state.dialState);
  const canDial = setupReady(state.setup) && !live && !dialLive && toE164(call.from_number) !== null;
  const browserCalls = canDial && state.setup.callWith === 'browser';
  const details = [
    shownNumber(call) ?? (call.from_number.startsWith('+') ? null : call.from_number),
    callerPlace(call),
    call.contact_label && call.caller_name ? `Caller ID: ${call.caller_name}` : null,
    formatLocal(call.started_sec * 1000, timeZone),
  ].filter((d): d is string => d !== null);
  const hubspot = !call.contact_id
    ? html`<p class="muted">This number isn’t on a HubSpot contact, so the call wasn’t logged. Add it to a contact’s Phone or Mobile and open this page again: the call is logged on them then, and future calls are too.</p>`
    : call.logged_call_id
      ? html`<p>Logged on the <a href="${recordUrl(portalId, '0-1', call.contact_id)}" target="_blank" rel="noopener">contact’s timeline</a>.</p>`
      : call.status === null
        ? html`<p class="muted">Logged on the contact when the call ends.</p>`
        : call.log_attempted_at
          ? html`<p class="muted">Logging it stopped without an answer from HubSpot. Check the <a href="${recordUrl(portalId, '0-1', call.contact_id)}" target="_blank" rel="noopener">contact’s timeline</a> and add it by hand if it’s missing.</p>`
          : html`<p class="muted">Not logged yet. It’s tried again each time this page opens.</p>`;
  const pending = (!live && recording.kind === 'pending') || (!dialLive && state.dialRecording?.kind === 'pending');
  return layout(
    `Inbound · ${callerName(call)}`,
    actor,
    html`
      <p><a href="/calls?dir=in">← Calls</a></p>
      <div class="tight">
        <h1>${callerName(call)}</h1>
        <p class="muted">${details.join(' · ')}${call.contact_id ? html` · <a href="/contacts/${call.contact_id}">contact page</a>` : ''}</p>
      </div>
      ${flashBox(live ? 'warn' : 'ok', inboundSummary(call))}
      ${dialLive ? liveDialStatus(page, state) : dialStatus(state)}
      <div class="stack">
        ${callBackCard(state, canDial, state.setup.callWith === 'browser')}
        ${browserCalls ? browserCallPanel : ''}
        ${
          !dialLive && state.dial && state.dialRecording && state.dialRecording.kind !== 'none'
            ? transcriptCard(
                page,
                state.dial,
                state.dialRecording,
                state.dial.contact_id ? 'It’s added to the call back in HubSpot when it’s ready.' : ''
              )
            : ''
        }
        ${recording.kind !== 'none' ? inboundRecordingCard(call, recording) : ''}
        <div class="card">
          <h2>HubSpot</h2>
          ${hubspot}
        </div>
        ${othersCard(state)}
      </div>
      ${pending ? html`<script>${raw(POLL_SCRIPT)}</script>` : ''}
      ${browserCalls ? browserCallScripts() : ''}
      ${dialLive ? html`<script>${raw(LIVE_STATUS_SCRIPT)}</script>` : ''}
    `,
    'calls',
    live ? LIVE_REFRESH_SEC : null
  );
}

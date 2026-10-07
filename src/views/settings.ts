import { html, raw } from 'hono/html';
import type { AppSettings } from '../lib/app-settings';
import { CLAUDE_MODELS, EFFORT_LEVELS } from '../lib/claude';
import { previewDocument, signaturePreviewHtml } from '../lib/compose';
import { formatLocal } from '../lib/dates';
import { formatPhone } from '../lib/phone';
import type { AccountNumbers, TwilioNumber } from '../lib/twilio';
import { RECORDING_NOTICE } from '../lib/twiml';
import { flash, layout, type Html } from './layout';

export type TwilioState =
  | { status: 'not-configured' }
  | { status: 'error'; message: string }
  | { status: 'connected'; accountSid: string; numbers: AccountNumbers };

// The Claude connector: the URL to add in Claude, and the connections this
// rep approved (null when they couldn't be listed).
export interface ConnectorState {
  url: string;
  grants: { id: string; label: string; connectedAt: number }[] | null; // connectedAt: epoch ms
}

export interface SettingsPageState {
  settings: AppSettings;
  googleReady: boolean; // client id/secret + encryption key present
  anthropicReady: boolean;
  twilio: TwilioState;
  browserReady: boolean; // API key and TwiML App set, for calling from the browser
  connector: ConnectorState;
  flash: string | null;
  error: string | null;
}

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-5-5': 'Claude Opus 5.5 (newest Opus, cheaper than Opus 5)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (cheapest, newest Sonnet)',
  'claude-sonnet-5': 'Claude Sonnet 5 (same price as Sonnet 5.5)',
};

function setting(title: string, help: Html | string, body: Html): Html {
  return html`<div class="setting">
    <div class="tight">
      <h2>${title}</h2>
      <p class="muted">${help}</p>
    </div>
    ${body}
  </div>`;
}

function numberOption(n: TwilioNumber, selected: string | null): Html {
  // Twilio's default friendly name is just the number again; show real names only.
  const name = /[a-z]/i.test(n.friendlyName) ? ` · ${n.friendlyName}` : '';
  return html`<option value="${n.phoneNumber}" ${n.phoneNumber === selected ? 'selected' : ''}>${formatPhone(n.phoneNumber)}${name}</option>`;
}

function callingCard(state: SettingsPageState): Html {
  const t = state.twilio;
  if (t.status === 'not-configured') {
    return html`<div class="card">
      <p><strong>Twilio isn't connected.</strong> Set the account's auth token as a Worker secret:</p>
      <p><code>npx wrangler secret put TWILIO_AUTH_TOKEN</code> (and add it to .dev.vars for local use)</p>
      <p class="muted">Twilio Console → Account info. It stays a secret on the Worker, where nobody can read it back, rather than in the app's database. The account SID is in wrangler.jsonc.</p>
    </div>`;
  }
  if (t.status === 'error') return html`<div class="card">${flash('err', t.message)}</div>`;

  const s = state.settings;
  // With one voice number on the account there's nothing to choose.
  const from = s.twilioFromNumber ?? (t.numbers.voice.length === 1 ? t.numbers.voice[0].phoneNumber : null);
  const browser = s.callWith === 'browser';
  return html`<div class="card">
    <p>Connected to Twilio account <code>${t.accountSid.slice(0, 6)}…${t.accountSid.slice(-4)}</code>.</p>
    <div class="tight">
      <strong>Call with</strong>
      <label class="check plain"><input type="radio" name="call_with" value="phone" ${browser ? '' : 'checked'} /> My phone: Twilio rings it, and pressing 1 dials them</label>
      <label class="check plain"><input type="radio" name="call_with" value="browser" ${browser ? 'checked' : ''} ${state.browserReady || browser ? '' : 'disabled'} /> This browser: talk through the call page, with a headset</label>
      <p class="muted check-help">${
        state.browserReady
          ? 'From the browser works on a phone too (Chrome or Safari), but only while the page stays open with the screen on. On a phone, your phone is the steadier choice.'
          : html`Calling from the browser needs an API key and a TwiML App on the Worker: <code>TWILIO_API_KEY_SID</code>, <code>TWILIO_TWIML_APP_SID</code> and the <code>TWILIO_API_KEY_SECRET</code> secret (see README).`
      }</p>
    </div>
    <div class="grid-2">
      <div class="field">
        <label for="twilio_from_number">Call from</label>
        <select id="twilio_from_number" name="twilio_from_number">
          <option value="">Choose a number…</option>
          ${t.numbers.voice.map((n) => numberOption(n, from))}
        </select>
        <p class="muted">The caller ID prospects see. Your Twilio numbers that can make calls.</p>
      </div>
      <div class="field">
        <label for="rep_phone">Your phone</label>
        <select id="rep_phone" name="rep_phone">
          <option value="">Choose a number…</option>
          ${t.numbers.verified.map((n) => numberOption(n, s.repPhone))}
        </select>
        <p class="muted">Rings first when you call with your phone, and for calls to the Twilio number (even when you call from the browser). Numbers you've verified with Twilio. Not listed? Add it in Twilio Console → Phone Numbers → Verified Caller IDs, then reload.</p>
      </div>
    </div>
    <div class="tight divided">
      <label class="check"><input type="checkbox" name="record_calls" value="1" ${s.recordCalls ? 'checked' : ''} /> Record and transcribe calls</label>
      <p class="muted check-help">When they answer, they hear "${RECORDING_NOTICE}" before you're connected; you don't. Some US states (California, Florida, Pennsylvania, Washington and others) require everyone on a call to agree to recording, and the notice is how they're told. The transcript, a short summary and a link to the recording go into the call's notes in HubSpot. Transcription runs on Cloudflare's free Workers AI allowance: about 20 minutes of calls a day.</p>
    </div>
  </div>`;
}

function gmailCard(state: SettingsPageState): Html {
  const email = state.settings.googleEmail;
  if (!state.googleReady) {
    return html`<div class="card">
      <p class="muted">Not set up yet: the Worker needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY (see README).</p>
    </div>`;
  }
  if (email) {
    return html`<div class="card">
      <p>Sending as <strong>${email}</strong></p>
      <div class="actions">
        <a class="button" href="/oauth/google/start">Reconnect</a>
        <form method="post" action="/settings/google/disconnect" onsubmit="return confirm(this.dataset.confirm)" data-confirm="Disconnect ${email}? The app can't send email until you connect an account again.">
          <button type="submit">Disconnect</button>
        </form>
      </div>
      <p class="muted">Reconnect if sending starts failing, for example after a Google password change. Also reconnect once to let the app send interview invites from this account's calendar (connections made before invites existed can't).</p>
    </div>`;
  }
  return html`<div class="card">
    <p><strong>No Gmail account connected.</strong> The app can't send email until you connect one.</p>
    <div><a class="button primary" href="/oauth/google/start">Connect Gmail</a></div>
    <p class="muted">Opens Google sign-in. Choose the inbox HubSpot sends from. The app only asks to send email as you and to add events to your calendar (interview invites): it can't read your inbox or your calendar. Google may show a one-time "unverified app" warning first.</p>
  </div>`;
}

// Copies the connector URL; if the clipboard is refused, selects it instead.
const COPY_URL_SCRIPT = `
document.getElementById('copy-connector-url').addEventListener('click', async () => {
  const field = document.getElementById('connector-url');
  const status = document.getElementById('copy-connector-status');
  try {
    await navigator.clipboard.writeText(field.value);
    status.textContent = 'Copied.';
  } catch {
    field.select();
    status.textContent = 'Selected. Press Cmd/Ctrl+C.';
  }
});`;

function connectorCard(connector: ConnectorState, timeZone: string): Html {
  const { grants } = connector;
  return html`<div class="card">
    <div class="field">
      <label for="connector-url">Connector URL</label>
      <div class="actions">
        <input type="text" id="connector-url" value="${connector.url}" readonly />
        <button type="button" id="copy-connector-url">Copy</button>
        <span id="copy-connector-status" class="muted" aria-live="polite"></span>
      </div>
    </div>
    <ol class="muted">
      <li>In Claude (claude.ai or the desktop app): Customize → Connectors → + → <strong>Add custom connector</strong>.</li>
      <li>Name it "Causeway" and paste the URL above. Leave Advanced settings (OAuth Client ID and Secret) empty: Claude registers itself. Add it.</li>
      <li>Adding it doesn't connect it: Claude lists it as needing sign-in. Click <strong>Connect</strong> on it, and on this app's approval page click <strong>Connect</strong> again. It then shows up below, and in Claude's phone app too.</li>
      <li>To rename it, remove it in Claude and add it again.</li>
    </ol>
    ${
      grants === null
        ? html`<p class="muted">The connections couldn't be listed just now. Reload to try again.</p>`
        : grants.length === 0
          ? html`<p><strong>Not connected yet.</strong></p>`
          : html`<table>
              <thead><tr><th>Connected app</th><th>Since</th><th></th></tr></thead>
              <tbody>
                ${grants.map(
                  (g) => html`<tr>
                    <td>${g.label}</td>
                    <td>${formatLocal(g.connectedAt, timeZone)}</td>
                    <td>
                      <form method="post" action="/settings/connector/disconnect" onsubmit="return confirm(this.dataset.confirm)" data-confirm="Disconnect ${g.label}? It stops working until you add the connector in Claude again.">
                        <input type="hidden" name="grant_id" value="${g.id}" />
                        <button type="submit">Disconnect</button>
                      </form>
                    </td>
                  </tr>`
                )}
              </tbody>
            </table>`
    }
    <p class="muted">Claude reads and writes as you: queues, contacts, calls and interviews, drafts, call and interview logs. Sending email and placing calls stay on these pages.</p>
    <script>${raw(COPY_URL_SCRIPT)}</script>
  </div>`;
}

function timeZoneCard(current: string): Html {
  const zones = Intl.supportedValuesOf('timeZone');
  const options = zones.includes(current) ? zones : [current, ...zones];
  return html`<div class="card">
    <div class="field">
      <label for="time_zone">Time zone</label>
      <select id="time_zone" name="time_zone">
        ${options.map((z) => html`<option value="${z}" ${z === current ? 'selected' : ''}>${z.replace(/_/g, ' ')}</option>`)}
      </select>
    </div>
  </div>`;
}

export function settingsPage(state: SettingsPageState, actor: string): Html {
  const s = state.settings;
  return layout(
    'Settings',
    actor,
    html`
      <h1>Settings</h1>
      ${state.flash ? flash('ok', state.flash) : ''}
      ${state.error ? flash('err', state.error) : ''}

      ${setting(
        'Gmail sending',
        'The account every email goes out from. Use the one HubSpot sends from, so replies land in the same inbox.',
        gmailCard(state)
      )}

      ${setting(
        'Claude connector',
        'Work the queues from a Claude chat, on your Claude plan. Add this app to Claude once; each approval shows below.',
        connectorCard(state.connector, s.timeZone)
      )}

      <form method="post" action="/settings" class="stack">
        ${setting(
          'Sender and signature',
          html`Added below every email sent from here. Plain text keeps its line breaks, and web addresses become links. HTML works too (in HubSpot: Profile &amp; Preferences → Email → Signature → Edit → "Source code").`,
          html`<div class="card">
            <div class="field">
              <label for="from_name">From name</label>
              <input type="text" id="from_name" name="from_name" value="${s.fromName}" />
            </div>
            <div class="field">
              <label for="signature_html">Signature</label>
              <textarea id="signature_html" name="signature_html" class="mono">${s.signatureHtml ?? ''}</textarea>
            </div>
            ${
              s.signatureHtml
                ? html`<div class="field">
                  <span class="muted">How recipients see the saved signature</span>
                  <iframe class="email-preview signature-preview" sandbox srcdoc="${previewDocument(signaturePreviewHtml(s.signatureHtml))}" title="Signature preview"></iframe>
                </div>`
                : html`<p class="muted">No signature yet: emails go out without one.</p>`
            }
          </div>`
        )}

        ${setting(
          'Time zone',
          'Where you are. Due times, interview times and follow-up dates are all in this zone. Change it when you move or travel.',
          timeZoneCard(s.timeZone)
        )}

        ${setting(
          'Tracking',
          "Both help you see who engaged, and both are signals spam filters use against cold email, so they can cost inbox placement. Clicks cost more: every link is rewritten to this app's workers.dev address, which filters distrust. If deliverability matters most, turn both off.",
          html`<div class="card">
            <div class="tight">
              <label class="check"><input type="checkbox" name="track_opens" value="1" ${s.trackOpens ? 'checked' : ''} /> Track opens</label>
              <p class="muted check-help">Adds an invisible 1×1 image. Shows when they last opened it, and ranks them up on Calls. Approximate, because some mail apps and company filters load images on their own.</p>
            </div>
            <div class="tight">
              <label class="check"><input type="checkbox" name="track_clicks" value="1" ${s.trackClicks ? 'checked' : ''} /> Track clicks</label>
              <p class="muted check-help">Links go through this app first. Reliable.</p>
            </div>
          </div>`
        )}

        ${setting(
          'HubSpot logging',
          'HubSpot already logs every email sent from the connected inbox within about a minute.',
          html`<div class="card">
            <div class="tight">
              <label class="check"><input type="checkbox" name="log_to_hubspot" value="1" ${s.logToHubSpot ? 'checked' : ''} /> Log each sent email on the contact from this app</label>
              <p class="muted check-help">Leave this off while isthmusglobalholdings@gmail.com is connected to HubSpot, or every email is logged twice. Turn it on only if you disconnect the inbox from HubSpot.</p>
            </div>
          </div>`
        )}

        ${setting(
          'Calling',
          'Click to call from the Calls page, through your phone or this browser. On your phone, Twilio rings it first, and pressing 1 dials the contact. In the browser, clicking Call dials them. Either way they see the number you call from.',
          callingCard(state)
        )}

        ${setting(
          'WhatsApp',
          'The WhatsApp button on a call or interview page opens your own WhatsApp chat with them, the message written in for you to send. Then log it on the page. Use a WhatsApp Business account on a business number, not your personal one: cold messages get reported, and reports can get an account banned.',
          html`<div class="card">
            <div class="tight">
              <strong>Open WhatsApp in</strong>
              <label class="check plain"><input type="radio" name="whatsapp_opens" value="app" ${s.whatsappOpens === 'app' ? 'checked' : ''} /> The WhatsApp app on this computer</label>
              <label class="check plain"><input type="radio" name="whatsapp_opens" value="web" ${s.whatsappOpens === 'web' ? 'checked' : ''} /> WhatsApp Web, in a new tab</label>
              <p class="muted check-help">Signed in to your business account, whichever it is. Calls work from the WhatsApp app: open the chat, then click its call button.</p>
            </div>
          </div>`
        )}

        ${setting(
          'Draft with Claude',
          state.anthropicReady
            ? html`API key is set. The drafting rules come from <code>src/prompts/draft-system.ts</code>.`
            : html`No API key yet: run <code>npx wrangler secret put ANTHROPIC_API_KEY</code> (and add it to .dev.vars for local use).`,
          html`<div class="card">
            <div class="grid-2">
              <div class="field">
                <label for="claude_model">Model</label>
                <select id="claude_model" name="claude_model">
                  ${CLAUDE_MODELS.map(
                    (m) =>
                      html`<option value="${m}" ${m === s.claudeModel ? 'selected' : ''}>${MODEL_LABELS[m] ?? m}</option>`
                  )}
                </select>
              </div>
              <div class="field">
                <label for="claude_effort">Effort</label>
                <select id="claude_effort" name="claude_effort">
                  ${EFFORT_LEVELS.map((e) => html`<option value="${e}" ${e === s.claudeEffort ? 'selected' : ''}>${e}</option>`)}
                </select>
              </div>
            </div>
            <p class="muted">Higher effort researches and thinks more per draft, which costs more. "high" is a good default.</p>
          </div>`
        )}

        <div class="bar">
          <span class="muted">Saves sender, signature, tracking, logging, calling, WhatsApp and Claude. Gmail connects on its own.</span>
          <button type="submit" class="primary">Save settings</button>
        </div>
      </form>
    `,
    'settings'
  );
}

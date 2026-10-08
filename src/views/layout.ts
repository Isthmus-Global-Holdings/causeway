import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { CONVERSATION_GOAL, firstLine, MAX_LEARNED } from '../lib/conversations';
import { TIME_PATTERN } from '../lib/dates';
import type { TodayCounts } from '../workflows/today';
import { FOLD_SCRIPT } from './sections';
import { STYLES } from './styles';

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export type NavPage = 'queue' | 'calls' | 'coaching' | 'meetings' | 'contacts' | 'companies' | 'settings';

// The other pages load on hover (the speculation rules below), all but
// Settings, which isn't somewhere the rep goes back and forth.
function navLink(href: string, label: string, page: NavPage, current: NavPage | null): Html {
  if (page === current) return html`<a href="${href}" aria-current="page">${label}</a>`;
  return page === 'settings'
    ? html`<a href="${href}">${label}</a>`
    : html`<a href="${href}" data-prefetch-hover>${label}</a>`;
}

// The notice about HubSpot writes still running after a page answered, or
// stopped short (views/unfinished.ts). Fetched after the page shows, so no
// page waits on it, and fetched again while something is still saving.
const UNFINISHED_SCRIPT = `
(() => {
  let polls = 0;
  const load = async () => {
    const box = document.getElementById('unfinished');
    if (!box) return;
    try {
      const res = await fetch('/unfinished', { cache: 'no-store' });
      if (!res.ok) return;
      box.outerHTML = await res.text();
    } catch {
      return;
    }
    const again = document.getElementById('unfinished');
    if (again && again.hasAttribute('data-saving') && ++polls < 30) setTimeout(load, 2000);
  };
  load();
})();`;

// Pages the rep is about to open load before the click (Chrome's speculation
// rules; other browsers ignore them): the next call or email as soon as the
// page shows, and a list's links and the navbar on hover. Only pages that
// change nothing when loaded: never a send preview, which must show the draft
// as it is, nor a Queue tab, which remembers itself as the rep's last (a
// prefetched page opens without a second request, so it never would).
const SPECULATION_RULES = JSON.stringify({
  prefetch: [
    { where: { selector_matches: 'a[data-prefetch]' }, eagerness: 'eager' },
    { where: { selector_matches: 'a[data-prefetch-hover]' }, eagerness: 'moderate' },
  ],
});

// Server-rendered pages with plain <form>s. The only scripts are the notice
// above; Drop in place on the queue; the live preview and clipboard button on
// the draft page; on the call and interview pages the transcript poll and
// calling from the browser
// (Twilio's Voice SDK); the fields that show only when they apply
// (booking an interview, an interview's new time); on a call page, the list
// of today's calls scrolled to this one; and, on every page, the cards the
// rep folded staying folded (FOLD_SCRIPT).
// `refreshSec` reloads the page, for an inbound call page waiting on Twilio,
// and the calls queue when a set-time call comes on.
export function layout(
  title: string,
  actor: string | null,
  body: Html,
  current: NavPage | null = null,
  refreshSec: number | null = null
): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <!-- Numbers aren't tap-to-call: that dials from the rep's own phone, not the Twilio number. -->
        <meta name="format-detection" content="telephone=no" />
        ${refreshSec ? html`<meta http-equiv="refresh" content="${refreshSec}" />` : ''}
        <title>${title} · Causeway</title>
        <style>${raw(STYLES)}</style>
        ${actor ? html`<script type="speculationrules">${raw(SPECULATION_RULES)}</script>` : ''}
      </head>
      <body>
        <header class="site">
          <nav>
            <a class="app" href="/">Causeway</a>
            ${actor ? html`${navLink('/queue', 'Queue', 'queue', current)} ${navLink('/calls', 'Calls', 'calls', current)} ${navLink('/coaching', 'Coaching', 'coaching', current)} ${navLink('/meetings', 'Interviews', 'meetings', current)} ${navLink('/contacts', 'Contacts', 'contacts', current)} ${navLink('/companies', 'Companies', 'companies', current)} ${navLink('/settings', 'Settings', 'settings', current)}` : ''}
          </nav>
          ${actor ? html`<span class="muted actor">${actor}</span>` : ''}
        </header>
        <main>${actor ? html`<div id="unfinished"></div><script>${raw(UNFINISHED_SCRIPT)}</script>` : ''}${body}</main>
        <script>${raw(FOLD_SCRIPT)}</script>
      </body>
    </html>`;
}

// The Queue's two tabs: the emails to send and the calls to make. `waiting`
// is how many callers are waiting on a call back (on the calls tab).
export function queueTabs(current: 'emails' | 'calls', waiting: number): Html {
  const tab = (href: string, label: Html | string, on: boolean) =>
    on ? html`<a href="${href}" aria-current="page">${label}</a>` : html`<a href="${href}">${label}</a>`;
  return html`<nav class="tabs" aria-label="Queue">
    ${tab('/', 'Emails to send', current === 'emails')}
    ${tab('/queue/calls', html`Calls to make${waiting ? html` <span class="muted">· ${waiting} to call back</span>` : ''}`, current === 'calls')}
  </nav>`;
}

// Coaching's two tabs: the patterns across the calls, and what they've said.
export function coachingTabs(current: 'patterns' | 'heard'): Html {
  const tab = (href: string, label: string, on: boolean) =>
    on ? html`<a href="${href}" aria-current="page">${label}</a>` : html`<a href="${href}">${label}</a>`;
  return html`<nav class="tabs" aria-label="Coaching">
    ${tab('/coaching', 'Your calls', current === 'patterns')}
    ${tab('/coaching/heard', 'What you’ve heard', current === 'heard')}
  </nav>`;
}

// "1. Draft · 2. Preview & send", with the current step in bold.
export function steps(current: 'draft' | 'send'): Html {
  const step = (label: string, on: boolean) => (on ? html`<strong>${label}</strong>` : html`${label}`);
  return html`<p class="muted steps">${step('1. Draft', current === 'draft')} · ${step('2. Preview & send', current === 'send')}</p>`;
}

// A time of day, typed: "4pm", "4:30pm" or "16:30" (lib/dates.ts parseTime).
// Not <input type=time>, which won't send an hour and its am or pm until the
// minutes are filled in too.
export function timeInput(opts: { name: string; id?: string; label?: string; required?: boolean }): Html {
  return html`<input type="text" data-time name="${opts.name}" ${opts.id ? html`id="${opts.id}"` : ''} ${
    opts.label ? html`aria-label="${opts.label}"` : ''
  } placeholder="4pm" pattern="${TIME_PATTERN}" title="A time like 4pm, 4:30pm or 16:30" autocomplete="off" ${
    opts.required ? 'required' : ''
  } />`;
}

// A contact (0-1), company (0-2) or deal (0-3) record in HubSpot.
export function recordUrl(portalId: string, objectTypeId: '0-1' | '0-2' | '0-3', id: string): string {
  return `https://app.hubspot.com/contacts/${portalId}/record/${objectTypeId}/${id}`;
}

export function errorPage(title: string, message: string, actor: string | null): Html {
  return layout(
    title,
    actor,
    html`<p><a href="/">← Queue</a></p>
      <h1>${title}</h1>
      ${flash('err', message)}`
  );
}

export type FlashKind = 'ok' | 'warn' | 'err';

// A status message at the top of a page: ok after a save or send, warn when
// the rep should check something first, err when an action failed.
export function flash(kind: FlashKind, body: Html | string): Html {
  return html`<div class="flash ${kind}">${body}</div>`;
}

// Today's counts, at the top of the Queue, Calls and Interviews pages, and
// the real conversations so far, toward 100, with the last thing learned.
export function todayStrip(today: TodayCounts): Html {
  const { interviews, conversations } = today;
  const latest = conversations.latest;
  const line = latest ? (latest.learned ?? firstLine(latest.notes)) : null;
  const stat = (label: string, value: number | string, note: Html | string = '') =>
    html`<div class="stat"><dt>${label}</dt><dd>${value}</dd>${note ? html`<dd class="muted">${note}</dd>` : ''}</div>`;
  return html`<dl class="today" aria-label="Today">
    ${stat('Emails sent today', today.emailsSent)}
    ${stat('People called today', today.peopleCalled)}
    ${
      interviews
        ? stat('Interviews today', interviews.had, interviews.open ? `${interviews.open} more scheduled` : '')
        : stat('Interviews today', '—', 'couldn’t read HubSpot')
    }
    <div class="stat goal">
      <dt>Real conversations</dt>
      <dd>${conversations.people}<span class="of"> / ${CONVERSATION_GOAL}</span></dd>
      <dd class="muted learned">
        <a href="/coaching#conversations">${
          latest
            ? html`${latest.who.split(' at ')[0]}${line ? html`: “${line}”` : ''}`
            : 'None counted yet. Keep going.'
        }</a>
      </dd>
    </div>
  </dl>`;
}

// The log form's "real conversation" box: shown for the outcomes that can
// count (data-outcomes, read by CONVERSATION_SCRIPT), ticked when the call
// or interview looks like one, with the one line learned.
export function conversationBox(outcomes: readonly string[], ticked: boolean): Html {
  return html`<div class="tight" id="conversation-box" data-outcomes="${outcomes.join(' ')}">
    <label class="check"><input type="checkbox" id="conversation" name="conversation" value="1" ${ticked ? 'checked' : ''} />
      Real conversation: they talked about their work, and you learned something</label>
    <div class="field check-help" id="learned-field">
      <label for="learned">What you learned <span class="muted">(one line, optional)</span></label>
      <input type="text" id="learned" name="learned" maxlength="${MAX_LEARNED}" placeholder="The problem is people, not software" />
      <p class="muted">It counts toward your ${CONVERSATION_GOAL}, by person. Leave it blank and your notes’ first sentence stands in.</p>
    </div>
  </div>
  <script>${raw(CONVERSATION_SCRIPT)}</script>`;
}

// Shows the box only for an outcome that can count (and leaves it out of
// the form otherwise), and the line only once it's ticked.
const CONVERSATION_SCRIPT = `(() => {
  const box = document.getElementById('conversation-box');
  const outcome = document.getElementById('outcome');
  const tick = document.getElementById('conversation');
  const line = document.getElementById('learned-field');
  if (!box || !outcome || !tick) return;
  const outcomes = box.dataset.outcomes.split(' ');
  const sync = () => {
    const on = outcomes.includes(outcome.value);
    box.hidden = !on;
    tick.disabled = !on;
    line.hidden = !on || !tick.checked;
  };
  outcome.addEventListener('change', sync);
  tick.addEventListener('change', sync);
  for (const el of document.querySelectorAll('#channel')) el.addEventListener('change', () => setTimeout(sync));
  sync();
})();`;

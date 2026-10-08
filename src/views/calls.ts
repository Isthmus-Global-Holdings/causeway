import { html, raw } from 'hono/html';
import type { CallCoaching } from '../actions/coaching';
import { fillScript, MAX_SCRIPT, SCRIPT_PLACEHOLDERS, scriptParts, type ScriptLine } from '../lib/call-script';
import { suggestConversation } from '../lib/conversations';
import { parseFitReason } from '../lib/fit';
import { partyTimeZone, zoneLabel } from '../lib/address';
import { addDays, ago, formatClock, formatDay, formatLocal, localDate } from '../lib/dates';
import { phoneTree, plainTurns } from '../lib/call-insight';
import { clock } from '../lib/call-history';
import {
  sqliteTime,
  type CallLog,
  type Dial,
  type DialMode,
  type InboundCall,
  type LastConversation,
  type RecentSend,
} from '../lib/db';
import { extensionOf, formatPhone, toE164 } from '../lib/phone';
import { askedFor, callableFrom } from '../lib/set-time';
import type { PlanProgress } from '../lib/work-plan';
import { htmlToText } from '../lib/richtext';
import { dialTranscript, SPEAKER_LABELS, type CallTranscript, type Turn } from '../lib/transcript';
import { historyTimeline, type CallContext, type HistoryItem } from '../workflows/call-context';
import {
  CALL_OUTCOMES,
  callLogDone,
  LAST_TRY,
  MESSAGE_OUTCOMES,
  WHATSAPP_FIELDS,
  type CallOutcome,
  type WhatsAppField,
} from '../workflows/call-logged';
import { contactHoursNote, whatsappLink, whatsappNumber, type WhatsAppOpens } from '../lib/whatsapp';
import { whatsappOpener } from '../prompts/whatsapp-messages';
import { LENGTHS_MIN } from '../workflows/book-interview';
import {
  clicked,
  isCallTime,
  opened,
  planCalls,
  type CallPlan,
  type CallQueue,
  type CallRow,
  type MovedCall,
} from '../workflows/call-queue';
import type { MeetingRow } from '../workflows/meeting-queue';
import type { DialState } from '../workflows/dial';
import { isLive, PHONE_FIELDS, phoneFor } from '../workflows/dial';
import { CONTACT_PHONE_FIELDS, phoneBoxes } from '../workflows/numbers';
import {
  callerName,
  callerPlace,
  INBOUND_TAGS,
  inboundOutcome,
  inboundSummary,
  shownNumber,
} from '../workflows/inbound';
import { companyName, contactName, firstPhone, type TaskParties } from '../workflows/parties';
import type { TodayCounts } from '../workflows/today';
import type { Recorded, RecordingState } from '../workflows/transcribe';
import { coachingCard } from './coaching';
import { address, companyLinks, contactLinks, facts, humanize, lifecycle, website, whereTheyAre } from './facts';
import { cardHead, foldCard, icon, jumpBar, type IconName, type JumpLink } from './sections';
import {
  conversationBox,
  flash as flashBox,
  layout,
  queueTabs,
  recordUrl,
  SAID_TIME_SCRIPT,
  timeInput,
  todayStrip,
  type Html,
} from './layout';

// While a call is live, the page checks its status this often (just the
// status, from D1: see LIVE_STATUS_SCRIPT).
const LIVE_POLL_MS = 2000;

export interface CallsFlash {
  loggedTaskId: string;
  nextTaskId: string | null;
  nextTaskCreated: boolean;
  logMissing: boolean; // an earlier attempt may or may not have logged the call
  leadStatus: string | null; // the Lead Status the contact was moved to, if any
  interviewId: string | null; // the interview the call booked, if any
  saving: boolean; // the HubSpot steps are still running, after the page answered
}

const LEAD_STATUS_LABELS: Record<string, string> = {
  ATTEMPTED_TO_CONTACT: 'Attempted to Contact',
  CONNECTED: 'Connected',
};

export interface CallsSetup {
  twilioReady: boolean;
  browserReady: boolean; // the Worker can hand the page a Voice SDK token
  callWith: DialMode;
  fromNumber: string | null;
  repPhone: string | null;
  whatsappOpens: WhatsAppOpens;
  fromName: string; // signs the WhatsApp message written in for the rep
}

export function setupWarning(setup: CallsSetup): Html | '' {
  if (!setup.twilioReady) {
    return flashBox(
      'warn',
      html`Twilio isn’t connected yet, so you can log calls but not dial from here. See <a href="/settings">Settings</a>.`
    );
  }
  if (setup.callWith === 'browser' && !setup.browserReady) {
    return flashBox(
      'warn',
      html`Calling from the browser isn’t set up on this Worker yet (see the README). Switch to your phone in <a href="/settings">Settings</a> meanwhile.`
    );
  }
  if (!setup.fromNumber || (setup.callWith === 'phone' && !setup.repPhone)) {
    return flashBox(
      'warn',
      setup.callWith === 'phone'
        ? html`Pick the number to call from and your phone in <a href="/settings">Settings</a> before dialling.`
        : html`Pick the number to call from in <a href="/settings">Settings</a> before dialling.`
    );
  }
  return '';
}

// Ready to dial: nothing left to warn about.
export function setupReady(setup: CallsSetup): boolean {
  return setupWarning(setup) === '';
}

// Moves the call to another day without logging one. Tomorrow is filled in, so
// one click covers the usual case; the date sent is absolute, so a double
// submit lands on the same day. A time, only when they asked for one, makes it
// a set-time call, which can be later today, typed in their time zone when
// they said it in theirs.
function moveForm(row: CallRow, tomorrow: string, timeZone: string): Html {
  return html`<form method="post" action="/calls/${row.taskId}/snooze" class="move">
    <input type="date" name="date" value="${tomorrow}" min="${addDays(tomorrow, -1)}" aria-label="Move to" required />
    ${timeInput({
      name: 'time',
      label: 'At a set time (optional), only if they asked for one',
      zones: { yours: timeZone, theirs: row.timeZone, dateName: 'date' },
    })}
    <button type="submit" class="quiet">Move</button>
  </form>`;
}

// For a call the rep won't make. The confirm names what happens in HubSpot.
function dropForm(taskId: string, who: string): Html {
  const confirmText = `Drop the call to ${who}? The task is marked Deferred in HubSpot and leaves the queue. No call is logged and no follow-up is created.`;
  return html`<form method="post" action="/calls/${taskId}/drop" onsubmit="return confirm(this.dataset.confirm)" data-confirm="${confirmText}">
    <button type="submit" class="quiet">Drop</button>
  </form>`;
}

// Where a set-time call due today stands: "in 1 h 20 min", "now", "12 min late".
export function setTimeStatus(dueAt: number, now: number): string {
  const span = (min: number) =>
    min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`;
  if (now < callableFrom(dueAt)) return `in ${span(Math.ceil((dueAt - now) / 60_000))}`;
  const late = Math.floor((now - dueAt) / 60_000);
  return late < 5 ? 'now' : `${span(late)} late`;
}

function dueCell(row: CallRow, timeZone: string, now: number): Html {
  if (row.dueAt === null) return html`<span class="muted">no due date</span>`;
  if (!row.setTime) return html`${formatLocal(row.dueAt, timeZone)}`;
  const today = localDate(now, timeZone) === localDate(row.dueAt, timeZone);
  const theirs = row.timeZone && row.timeZone !== timeZone ? row.timeZone : null;
  return html`${formatLocal(row.dueAt, timeZone)}
    <span class="tag in" title="They asked to be called at this time">${today ? `Set time · ${setTimeStatus(row.dueAt, now)}` : 'Set time'}</span>
    ${theirs ? html`<span class="muted" title="Their time zone, from their address">${formatClock(row.dueAt, theirs)} ${zoneLabel(theirs)}</span>` : ''}`;
}

// What the contact did with the app's emails. A click ranks a call up, then
// an open. The open's time is the last one: someone who opened it an hour ago
// is worth calling now.
function engagementBadge(row: CallRow, timeZone: string): Html | '' {
  const e = row.engagement;
  if (!e) return '';
  const click = e.clicks
    ? html`<span class="fit clicked" title="${e.clicks} link click${e.clicks === 1 ? '' : 's'} on your email">Clicked</span>`
    : '';
  const times = `${e.opens} open${e.opens === 1 ? '' : 's'}`;
  const open = e.opens
    ? html`<span class="fit opened" title="${times}. Approximate: some mail apps load images on their own."
        >Opened${e.lastOpenAt === null ? '' : ` ${formatLocal(e.lastOpenAt, timeZone)}`}</span>`
    : '';
  return html`${click} ${open}`;
}

// `moveTo` is tomorrow's date on the due rows, null on upcoming ones.
function callRow(row: CallRow, timeZone: string, now: number, moveTo: string | null): Html {
  return html`<tr class="${row.fit === 'DROP' ? 'drop' : ''}">
    <td class="fit-cell"><span class="fit">${row.fit}</span></td>
    <td data-label="Due">${dueCell(row, timeZone, now)}</td>
    <td>
      <div class="tight">
        <span><strong>${row.companyName ?? html`<span class="muted">no company</span>`}</strong> ·
          ${row.contactName ?? html`<span class="muted">no contact</span>`}
          ${engagementBadge(row, timeZone)}
          ${row.interview ? interviewBadge(row.interview, timeZone) : ''}</span>
        <span class="muted">${row.phone ? formatPhone(row.phone) : 'no dialable number'}</span>
      </div>
    </td>
    <td class="row-actions">
      <div class="actions">
        ${row.phone ? html`<a class="button primary" href="${callNowHref(row.taskId)}" title="Open the call and start calling ${formatPhone(row.phone)}">Call</a>` : ''}
        <a class="button" href="/calls/${row.taskId}" data-prefetch-hover>Open</a>
        ${moveTo ? moveForm(row, moveTo, timeZone) : ''}
        ${dropForm(row.taskId, row.contactName ?? row.companyName ?? 'this contact')}
      </div>
    </td>
  </tr>`;
}

// Opens the call page and starts calling its first number, as if Call were
// clicked there. The click on the queue is the rep's go-ahead; the page drops
// the query before dialling, so a reload never calls again.
export function callNowHref(taskId: string): string {
  return `/calls/${encodeURIComponent(taskId)}?call=1`;
}

// The call's contact has an interview booked: a link to its prep page.
export function interviewBadge(interview: { meetingId: string; startAt: number }, timeZone: string): Html {
  return html`<a class="interview" href="/meetings/${interview.meetingId}">Interview ${formatLocal(interview.startAt, timeZone)}</a>`;
}

function callTable(rows: CallRow[], timeZone: string, now: number, moveTo: string | null): Html {
  return html`<table class="stacked">
    <thead><tr><th>Fit</th><th>Due</th><th>Company · contact</th><th></th></tr></thead>
    <tbody>${rows.map((r) => callRow(r, timeZone, now, moveTo))}</tbody>
  </table>`;
}

function loggedFlash(f: CallsFlash): Html {
  if (f.saving) {
    return flashBox(
      'ok',
      html`Saving the call with task ${f.loggedTaskId}: it's logged on the contact, the task completed and the follow-up created in HubSpot in a few seconds. If anything fails, a notice at the top of the page says so.`
    );
  }
  const next = f.nextTaskId
    ? f.nextTaskCreated
      ? html` Follow-up task ${f.nextTaskId} created.`
      : html` Follow-up task ${f.nextTaskId} already existed, so no new one was created.`
    : '';
  const lead = f.leadStatus ? html` Lead Status set to ${LEAD_STATUS_LABELS[f.leadStatus] ?? f.leadStatus}.` : '';
  return f.logMissing
    ? flashBox(
        'warn',
        html`Task ${f.loggedTaskId} completed.${next}${lead} An earlier attempt to log the call stopped without an answer from HubSpot, so check the contact's timeline for it and add it by hand if it's missing.`
      )
    : flashBox(
        'ok',
        html`Call logged on the contact and task ${f.loggedTaskId} completed.${next}${lead}${
          f.interviewId ? html` <a href="/meetings/${f.interviewId}">Interview booked</a>.` : ''
        }`
      );
}

// Why the top call is on top, in the order planCalls ranks by.
function whyFirst(row: CallRow, today: string, timeZone: string, now: number): string {
  if (isCallTime(row, now) && row.dueAt !== null) {
    const status = setTimeStatus(row.dueAt, now);
    return `They asked to be called at ${formatLocal(row.dueAt, timeZone)}${status === 'now' ? '.' : `: ${status}.`}`;
  }
  const when = row.dueAt !== null && localDate(row.dueAt, timeZone) < today ? 'Overdue' : 'Due today';
  if (clicked(row)) return `${when}, and they clicked a link in your email.`;
  if (opened(row)) return `${when}, and they opened your email.`;
  return `${when}, and the best fit of the calls due.`;
}

function nextCallCard(plan: CallPlan, today: string, timeZone: string, now: number): Html {
  const row = plan.nextUp;
  if (!row) {
    return plan.due.length
      ? html`<p class="muted">Nothing to suggest. Every call due has no dialable number or is drop-flagged.</p>`
      : html`<p class="muted">${plan.atTime.length ? 'Nothing due until the calls at a set time below.' : 'Nothing due today.'}</p>`;
  }
  return html`<div class="card split next-up">
    <div class="tight">
      <p><span class="fit">${row.fit}</span> ${engagementBadge(row, timeZone)} ${row.interview ? interviewBadge(row.interview, timeZone) : ''}</p>
      <p class="next-company">${row.companyName ?? 'No company'}</p>
      <p>${row.contactName ?? 'No contact'} · <span class="muted">${row.phone ? formatPhone(row.phone) : ''}</span></p>
      <p class="muted">${whyFirst(row, today, timeZone, now)}</p>
    </div>
    <div class="actions">
      <a class="button primary" href="${callNowHref(row.taskId)}">Call</a>
      <a class="button" href="/calls/${row.taskId}" data-prefetch>Open</a>
    </div>
  </div>`;
}

export function callsPage(
  queue: CallQueue,
  flash: CallsFlash | null,
  moved: MovedCall | null,
  dropped: string | null, // a call task just dropped
  setup: CallsSetup,
  now: number,
  timeZone: string,
  counts: TodayCounts,
  waiting: InboundCall[], // missed calls and voicemails nobody has returned
  actor: string
): Html {
  const today = localDate(now, timeZone);
  const tomorrow = addDays(today, 1);
  const plan = planCalls(queue.rows, now, timeZone);
  const { atTime, due, later } = plan;
  // Reload when the next set-time call comes on, so it's the next call then.
  const comingOn = atTime.map((r) => callableFrom(r.dueAt ?? 0)).filter((at) => at > now);
  const refreshSec = comingOn.length ? Math.ceil((Math.min(...comingOn) - now) / 1000) + 1 : null;
  const hot = due.filter(clicked).length;
  const warm = due.filter((r) => !clicked(r) && opened(r)).length;
  return layout(
    'Calls to make',
    actor,
    html`
      ${queueTabs('calls', waiting.length)}
      ${flash ? loggedFlash(flash) : ''}
      ${
        moved
          ? flashBox(
              'ok',
              html`Call task ${moved.taskId} moved to ${formatLocal(moved.dueAt, timeZone)}${
                moved.setTime
                  ? '. It’s a set-time call: HubSpot reminds you 5 minutes before, and it’s the next call from then.'
                  : '.'
              }`
            )
          : ''
      }
      ${dropped ? flashBox('ok', html`Call task ${dropped} dropped: it's marked Deferred in HubSpot.`) : ''}
      ${setupWarning(setup)}
      ${queue.truncated ? flashBox('warn', 'Showing the oldest 1,000 open call tasks only.') : ''}
      ${todayStrip(counts)}
      ${waiting.length ? waitingCard(waiting, timeZone) : ''}

      <div class="row">
        <h1>Next call</h1>
        <p class="muted">${queue.rows.length} open call tasks · ${due.length} due today or overdue${atTime.length ? ` · ${atTime.length} at a set time` : ''}${hot ? ` · ${hot} clicked your email` : ''}${warm ? ` · ${warm} opened it` : ''}</p>
      </div>
      ${nextCallCard(plan, today, timeZone, now)}

      ${
        atTime.length
          ? html`<section>
            <div class="row">
              <h2>At a set time (${atTime.length})</h2>
              <p class="muted">They asked to be called then. Each is the next call from 5 minutes before its time, never earlier.</p>
            </div>
            ${callTable(atTime, timeZone, now, tomorrow)}
          </section>`
          : ''
      }

      ${
        due.length
          ? html`<section>
            <div class="row">
              <h2>Due today (${due.length})</h2>
              <p class="muted">Ranked: whoever clicked a link in your email first, then whoever opened it, then by the fit label in the company's description (STRONG, GOOD, weaker, unlabelled), then the most overdue. No number and drop-flagged last.</p>
            </div>
            ${callTable(due, timeZone, now, tomorrow)}
          </section>`
          : ''
      }

      ${
        later.length
          ? html`<section>
            <div class="row">
              <h2>Upcoming (${later.length})</h2>
              <p class="muted">Soonest first. Most are follow-ups created the day after an email goes out.</p>
            </div>
            ${callTable(later, timeZone, now, null)}
          </section>`
          : ''
      }
      <script>${raw(SAID_TIME_SCRIPT)}</script>

    `,
    'queue',
    refreshSec
  );
}

// Missed calls and voicemails nobody has returned, above the call tasks: they
// called you, so they come first. Each goes once its number is dialled from the app, it calls
// again and is answered, or the rep dismisses it.
export function waitingCard(waiting: InboundCall[], timeZone: string): Html {
  return html`<section class="card">
    <div class="row">
      <h2>Waiting on a call back (${waiting.length})</h2>
      <p class="muted">Missed calls and voicemails from the last two weeks that you haven’t returned.</p>
    </div>
    ${waiting.map((call) => {
      const transcript = dialTranscript(call);
      const about = transcript?.summary[0] ?? inboundSummary(call);
      const details = [shownNumber(call), callerPlace(call), formatLocal(call.started_sec * 1000, timeZone)].filter(
        (d): d is string => d !== null
      );
      return html`<div class="waiting">
        <div class="tight">
          <span>
            <span class="tag in">${INBOUND_TAGS[inboundOutcome(call)]}</span>
            <strong>${call.contact_id ? html`<a href="/contacts/${call.contact_id}">${callerName(call)}</a>` : callerName(call)}</strong>
            <span class="muted">· ${details.join(' · ')}</span>
          </span>
          <span class="muted">${about}</span>
        </div>
        <div class="actions">
          <form method="post" action="/inbound/${call.id}/dismiss">
            <button type="submit" class="quiet">Dismiss</button>
          </form>
          <a class="button" href="/inbound/${encodeURIComponent(call.id)}#call-back">Call back</a>
        </div>
      </div>`;
    })}
  </section>`;
}

export const OUTCOME_LABELS: Record<string, string> = Object.fromEntries(
  [...CALL_OUTCOMES, ...MESSAGE_OUTCOMES].map((o) => [o.value, o.label])
);

// While a transcript is pending, the call page fetches its card again and
// swaps it in. Only the card changes, so notes typed in the form stay put. An
// inbound call's page can have two: the call's own and a call back's.
const TRANSCRIPT_POLL_MS = 4000;
export const POLL_SCRIPT = `(() => {
  const poll = async (id) => {
    const card = document.getElementById(id);
    if (!card || !card.hasAttribute('data-pending')) return;
    try {
      const res = await fetch(card.dataset.src);
      if (res.ok) card.outerHTML = await res.text();
    } catch {}
    setTimeout(() => poll(id), ${TRANSCRIPT_POLL_MS});
  };
  for (const card of document.querySelectorAll('.card[data-pending][data-src]')) {
    setTimeout(() => poll(card.id), ${TRANSCRIPT_POLL_MS});
  }
})();`;

// `page` is the dial's page: /calls/<task id> or /meetings/<meeting id>.
export function transcriptCard(
  page: string,
  dial: Dial,
  state: RecordingState,
  pendingNote = "You can log the call now: the transcript is added to it when it's ready."
): Html {
  return recordingCard(dial, state, {
    poll: `${page}/transcript/${dial.id}`,
    audio: `${page}/recording/${dial.id}`,
    retry: `${page}/transcribe`,
    retryField: { name: 'dial_id', value: dial.id },
    pendingNote,
  });
}

export interface RecordingLinks {
  id?: string; // the card's element id, 'transcript' unless given
  poll: string; // this card alone, fetched again while it's pending
  audio: string;
  retry: string; // POST: transcribe again
  retryField: { name: string; value: string } | null;
  pendingNote: string;
}

// A call's recording, summary and transcript: a dial's or an inbound call's.
export function recordingCard(dial: Recorded, state: RecordingState, links: RecordingLinks): Html {
  const audio = dial.recording_sid
    ? html`<audio class="recording" controls preload="none" src="${links.audio}"></audio>`
    : '';
  const heading = cardHead('recording', 'Recording & transcript');
  const id = links.id ?? 'transcript';
  if (state.kind === 'pending') {
    return html`<div class="card" id="${id}" data-src="${links.poll}" data-pending>
      ${heading}
      <p class="muted">${state.message} This card updates on its own. ${links.pendingNote}</p>
    </div>`;
  }
  if (state.kind === 'failed') {
    return html`<div class="card" id="${id}">
      ${heading}
      ${flashBox('err', state.message)}
      ${audio}
      ${
        state.canRetry
          ? html`<form method="post" action="${links.retry}">
              ${links.retryField ? html`<input type="hidden" name="${links.retryField.name}" value="${links.retryField.value}" />` : ''}
              <button type="submit">Transcribe again</button>
            </form>
            <p class="muted">If the free Workers AI allowance ran out for today, this works again tomorrow.</p>`
          : ''
      }
    </div>`;
  }
  const transcript = dialTranscript(dial);
  if (state.kind !== 'done' || !transcript) return html``;
  return html`<div class="card" id="${id}">
    ${heading}
    ${
      transcript.summary.length
        ? html`<div class="tight"><h3>Summary</h3><ul class="summary">${transcript.summary.map((l) => html`<li>${l}</li>`)}</ul></div>`
        : ''
    }
    ${audio}
    ${transcriptTurns(transcript.turns)}
  </div>`;
}

// Who said what, in order.
export function transcriptTurns(turns: Turn[]): Html {
  return turns.length
    ? html`<div class="transcript">
        ${turns.map((t) => html`<p class="turn ${t.speaker}"><strong>${SPEAKER_LABELS[t.speaker]}</strong> ${t.text}</p>`)}
      </div>`
    : html`<p class="muted">No speech was picked up on the recording.</p>`;
}

// A logged call, its parts kept apart: what the rep wrote, what Workers AI
// made of the recording, and what was said, the phone menu left out. The
// transcript is open where the call is the point (Last conversation), and
// folded in a list of them (the history).
export function callRecord(notes: string | null, transcript: CallTranscript | null, transcriptOpen: boolean): Html {
  const turns = transcript?.turns ?? [];
  const menu = turns.length ? phoneTree(plainTurns(turns), null) : null;
  const said = menu && menu.end < turns.length ? turns.slice(menu.end) : turns;
  return html`<div class="call-record">
    ${notes ? html`<div class="part"><h3>Your notes</h3><pre class="notes">${notes}</pre></div>` : ''}
    ${
      transcript?.summary.length
        ? html`<div class="part">
            <h3>Summary <span class="muted">· by AI from the recording, check it against what was said</span></h3>
            <ul class="summary">${transcript.summary.map((l) => html`<li>${l}</li>`)}</ul>
          </div>`
        : ''
    }
    ${
      transcript
        ? html`<details class="part said" ${transcriptOpen ? 'open' : ''}>
            <summary><h3>What was said</h3>${
              said !== turns
                ? html` <span class="muted">· from ${clock(Math.round(said[0].start))}, after the phone menu</span>`
                : ''
            }</summary>
            ${transcriptTurns(said)}
          </details>`
        : ''
    }
  </div>`;
}

// The last time someone picked up, at the top of the call page and there
// while the phone rings, so the rep walks in remembering it.
function lastConversationCard(last: LastConversation | null, timeZone: string, now: number): Html | '' {
  if (!last) return '';
  const transcript = last.dial ? dialTranscript(last.dial) : null;
  const length = last.duration_sec ?? last.dial?.prospect_duration_sec ?? null;
  const at = last.dial ? last.dial.started_sec * 1000 : last.logged_at;
  const notes = last.notes.trim() || null;
  return html`<div class="card last-talk" id="last-talk">
    ${cardHead(
      'history',
      'Last conversation',
      html`<a class="muted" href="/calls/${last.call_task_id}">${ago(at, now, timeZone)} · ${formatLocal(at, timeZone)}</a>`
    )}
    <p class="muted">${[OUTCOME_LABELS[last.outcome] ?? last.outcome, last.channel === 'whatsapp_call' ? 'on WhatsApp' : null, length ? clock(length) : null].filter(Boolean).join(' · ')}</p>
    ${notes || transcript ? callRecord(notes, transcript, true) : html`<p class="muted">No notes or recording from that call.</p>`}
  </div>`;
}

// Calling from the browser, with Twilio's Voice SDK. Pinned, and checked
// against its hash, since it runs with the rep's Access session.
const VOICE_SDK = {
  src: 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.18.5/dist/twilio.min.js',
  integrity: 'sha384-LUG7DmzDPWNKRYoqyGpV4d/IByMLiya/oUhMSc/4/6hi0wbzO/8PffM4lzeFEYS8',
};

// The dial pad sends touch-tones down the call, for the phone menus and
// extensions a company line answers with.
const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

// Docked over the page (a corner on a desktop, a bottom sheet on a phone), so
// Hang up stays in reach while the rep reads the script and history.
export const browserCallPanel = html`<div class="card call-dock" id="browser-call" role="region" aria-label="Call" hidden>
  <p class="call-head"><strong data-label></strong><span class="muted" data-timer></span></p>
  <p data-status></p>
  <div class="keypad" role="group" aria-label="Dial pad" data-keypad hidden>
    ${KEYPAD.map((k) => html`<button type="button" data-key="${k}">${k}</button>`)}
  </div>
  <p class="muted" data-keyed hidden></p>
  <div class="actions">
    <button type="button" data-mute hidden>Mute</button>
    <button type="button" data-keypad-toggle aria-expanded="false" hidden>Keypad</button>
    <button type="button" class="primary" data-hangup hidden>Hang up</button>
    <button type="button" class="quiet" data-close hidden>Close</button>
  </div>
</div>`;

// Clicking Call asks the app for the dial (and a token), then starts the call
// here. The page stays put for the whole call, since leaving it hangs up, and
// reloads when the call ends to show how it went and the log form. On a
// phone, the screen is kept on: a locked screen drops the call's audio.
const BROWSER_CALL_SCRIPT = `(() => {
  const panel = document.getElementById('browser-call');
  const status = panel.querySelector('[data-status]');
  const mute = panel.querySelector('[data-mute]');
  const hangUp = panel.querySelector('[data-hangup]');
  const keypad = panel.querySelector('[data-keypad]');
  const keyed = panel.querySelector('[data-keyed]');
  const label = panel.querySelector('[data-label]');
  const timer = panel.querySelector('[data-timer]');
  const keypadToggle = panel.querySelector('[data-keypad-toggle]');
  const close = panel.querySelector('[data-close]');
  const forms = [...document.querySelectorAll('form[data-browser-call]')];
  const logForm = document.getElementById('log-form');
  const scriptEdit = document.getElementById('script-edit');
  let call = null;
  let wakeLock = null;
  let ending = false;
  let liveEndUrl = null; // set from the dial's creation until end() runs
  let accepted = false; // the call is up, so touch-tones go through
  let ticking = null;

  const say = (text) => {
    panel.hidden = false;
    document.body.classList.add('in-call');
    status.textContent = text;
  };
  // Room under the page for the dock at its current height (the keypad
  // makes it taller), so the end of the page can still scroll clear of it.
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      document.body.style.setProperty('--dock-height', panel.offsetHeight + 16 + 'px');
    }).observe(panel);
  }
  const showKeypad = (on) => {
    keypad.hidden = !on;
    keypadToggle.setAttribute('aria-expanded', String(on));
  };
  const onLeave = (e) => { e.preventDefault(); e.returnValue = ''; };
  // While a call is starting or live: no second call, no log form, no script
  // editing (saving it leaves the page), and a warning before leaving.
  const busy = (on) => {
    for (const f of forms) f.querySelector('button').disabled = on;
    if (logForm) logForm.hidden = on;
    if (scriptEdit) scriptEdit.hidden = on;
    if (on) addEventListener('beforeunload', onLeave);
    else removeEventListener('beforeunload', onLeave);
  };

  // The call is over, or never started. Telling the app frees the task if the
  // call never connected, and ends the dial if it did, so the reload shows
  // the log form.
  const end = async (endUrl, message) => {
    if (ending) return;
    ending = true;
    liveEndUrl = null;
    call = null;
    accepted = false;
    clearInterval(ticking);
    mute.hidden = hangUp.hidden = keypad.hidden = keypadToggle.hidden = true;
    if (wakeLock) wakeLock.release().catch(() => {});
    removeEventListener('beforeunload', onLeave);
    say(message);
    await fetch(endUrl, { method: 'POST', keepalive: true }).catch(() => {});
    setTimeout(() => location.reload(), 2000);
  };

  // Closing the tab or leaving mid-call ends the call, but the page may be
  // gone before the call's disconnect event runs. keepalive lets the request
  // outlive the page, so the dial doesn't stay live without Twilio's callback.
  addEventListener('pagehide', () => {
    if (liveEndUrl) fetch(liveEndUrl, { method: 'POST', keepalive: true }).catch(() => {});
  });

  for (const form of forms) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      busy(true);
      close.hidden = true;
      label.textContent = timer.textContent = '';
      say('Starting the call…');
      let dial;
      try {
        const res = await fetch(form.action, { method: 'POST', body: new FormData(form) });
        dial = (res.headers.get('Content-Type') || '').includes('json')
          ? await res.json()
          : { error: 'The app couldn’t start the call (error ' + res.status + '). Reload the page and try again.' };
      } catch {
        dial = { error: 'The app couldn’t be reached. Check your connection and try again.' };
      }
      if (dial.error) {
        busy(false);
        say(dial.error);
        close.hidden = false;
        return;
      }

      const endUrl = form.action + '/' + dial.dialId + '/end';
      liveEndUrl = endUrl;
      let device;
      let current;
      try {
        device = new Twilio.Device(dial.token);
        current = await device.connect({ params: { d: dial.dialId } });
      } catch (err) {
        if (device) device.destroy();
        return end(endUrl, 'The call didn’t start (' + ((err && err.message) || err) + '). If the browser asked for the microphone, allow it, then try again.');
      }
      // Listen before awaiting anything else, so no event is missed.
      current.on('accept', () => {
        say('Their phone is ringing. You’re talking as soon as they answer.');
        accepted = true;
        // Closed until wanted, so the dock covers little of the page.
        keypadToggle.hidden = false;
        // From when their phone starts ringing: the SDK doesn't say when they answer.
        const started = Date.now();
        const tick = () => {
          const s = Math.floor((Date.now() - started) / 1000);
          timer.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        };
        tick();
        ticking = setInterval(tick, 1000);
      });
      current.on('disconnect', () => { device.destroy(); end(endUrl, 'Call ended.'); });
      current.on('error', (err) => {
        console.error(err);
        if (current.status() === 'closed') { device.destroy(); end(endUrl, 'The call dropped: ' + err.message); }
        else say('Twilio reported a problem: ' + err.message);
      });
      call = current;
      label.textContent = dial.label;
      say('Calling ' + dial.label + '…');
      mute.hidden = hangUp.hidden = false;
      try { wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch {}
      // The call may have ended while the wake lock was on its way.
      if (ending && wakeLock) wakeLock.release().catch(() => {});
    });
  }

  mute.addEventListener('click', () => {
    if (!call) return;
    call.mute(!call.isMuted());
    mute.textContent = call.isMuted() ? 'Unmute' : 'Mute';
  });
  hangUp.addEventListener('click', () => { if (call) call.disconnect(); });
  keypadToggle.addEventListener('click', () => showKeypad(keypad.hidden));
  // Only after a call that didn't start: the dock would otherwise sit over the page.
  close.addEventListener('click', () => {
    panel.hidden = close.hidden = true;
    document.body.classList.remove('in-call');
  });

  // Touch-tones, from the pad or the keyboard's digits, * and # (except while
  // typing in a field). Twilio passes them on to the prospect's line.
  let digits = '';
  const press = (key) => {
    if (!call || !accepted) return;
    call.sendDigits(key);
    digits = (digits + key).slice(-24);
    keyed.hidden = false;
    keyed.textContent = 'Keyed: ' + digits;
  };
  keypad.addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]');
    if (key) press(key.dataset.key);
  });
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !/^[0-9*#]$/.test(e.key)) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    press(e.key);
  });
})();`;

// Opened with the queue's Call (?call=1): drop the query first, so a reload
// or the reload after the call never dials again. It goes even when the page
// can't call now (a call is live), or the reload when that call ends would
// dial a second time.
const DROP_CALL_NOW_SCRIPT = `(() => {
  const url = new URL(location.href);
  url.searchParams.delete('call');
  history.replaceState(null, '', url);
})();`;

// Then, when the page can call, press the first number's Call. After the
// browser-call script, so its submit handler runs.
const CALL_NOW_SCRIPT = `(() => {
  const button = [...document.querySelectorAll('form[action$="/dial"] button[type="submit"]')].find((b) => !b.disabled);
  if (button) button.form.requestSubmit(button);
})();`;

// The Voice SDK and the script that calls through it, for a page whose
// numbers card has data-browser-call forms.
export function browserCallScripts(): Html {
  return html`<script src="${VOICE_SDK.src}" integrity="${VOICE_SDK.integrity}" crossorigin="anonymous"></script><script>${raw(BROWSER_CALL_SCRIPT)}</script>`;
}

// What the numbers card and the call status need: the page the dial belongs
// to (/calls/<task id> or /meetings/<meeting id>) and who's being called.
export interface DialView {
  page: string;
  parties: Pick<TaskParties, 'contact' | 'company'>;
  dial: Dial | null;
  dialState: DialState | null;
  setup: CallsSetup;
  portalId: string;
  whatsapp: WhatsAppDraft | null; // null: no WhatsApp button
}

// The message the WhatsApp button writes into the chat, and a warning to show
// by it (lib/whatsapp.ts contactHoursNote).
export interface WhatsAppDraft {
  text: string;
  note: string | null;
}

// The contact's numbers they could have WhatsApp on, mobile first.
export function whatsappFields(contact: TaskParties['contact']): WhatsAppField[] {
  return WHATSAPP_FIELDS.filter((f) => whatsappNumber(contact.properties[f]));
}

export interface CallPageState {
  parties: TaskParties;
  dial: Dial | null;
  dialState: DialState | null;
  recordingState: RecordingState | null;
  log: CallLog | null;
  lastEmail: RecentSend | null;
  context: CallContext;
  callScript: string | null; // the raw template, shared by every call
  fromName: string;
  scriptSaved: boolean;
  setup: CallsSetup;
  interviews: MeetingRow[]; // the contact's open interviews, today or later
  missedInterview: MeetingRow | null; // their last interview was a no-show, nothing booked since
  portalId: string;
  now: number;
  timeZone: string;
  // The rep landed here from logging the previous call: its task, and its
  // row (null if it can't be read).
  justLogged: { taskId: string; log: CallLog | null } | null;
  nextCallId: string | null; // the call after this one in today's order
  today: PlanProgress | null; // today's calls in order, for the list beside this one
  callNow: boolean; // opened with the queue's Call: start calling on load
  coaching: CallCoaching; // what to adjust after the last call, and what's worked on calls like this
  lastConversation: LastConversation | null; // the contact's last logged call where someone picked up
}

// The shared script, filled in for this contact. Editing is hidden while a
// call is live: on the phone the page reloads when the call ends, which would
// throw away what's being typed, and in the browser saving would leave the
// page and hang up (the call script hides it there).
function scriptCard(state: CallPageState, live: boolean): Html {
  const { task, contact, company } = state.parties;
  const script = state.callScript;
  const p = contact.properties;
  const filled = script
    ? fillScript(script, {
        firstName: p.firstname,
        lastName: p.lastname,
        // The raw fields, not contactName/companyName: their fallbacks (an
        // email, "Contact 123") would fill a placeholder that should show
        // it has nothing to fill in.
        name: [p.firstname, p.lastname].filter(Boolean).join(' ') || null,
        title: p.jobtitle,
        company: company?.properties.name || null,
        fitReason: parseFitReason(company?.properties.description),
        myName: state.fromName,
      })
    : null;
  const edit = live
    ? ''
    : html`<details id="script-edit" ${script ? '' : 'open'}>
        <summary class="muted">${script ? 'Edit script' : 'Write a script'}</summary>
        <form method="post" action="/calls/${task.id}/script" class="stack">
          <textarea name="script" class="context" maxlength="${MAX_SCRIPT}" aria-label="Call script"
            placeholder="Hi {first_name}, this is {my_name}…">${script ?? ''}</textarea>
          <p class="muted">The same script shows on every call. These fill in with the contact's details:
            ${SCRIPT_PLACEHOLDERS.map((ph, i) => html`${i ? ', ' : ''}<code>${ph.token}</code> ${ph.what}`)}.
            One with nothing to fill in stays as written, highlighted.</p>
          <p class="muted">Start each part on a line of its own between rules, like <code>━━━ 1 · OPENER ━━━</code>
            or <code># Opener</code>, and the parts become tabs. A line in quotes is set as one to say, and one
            starting with <code>→</code> or <code>⏸</code> as a cue.</p>
          <div class="actions"><button type="submit" class="primary">Save script</button></div>
        </form>
      </details>`;
  return html`<div class="card" id="script">
    ${cardHead('script', 'Call script')}
    ${filled ? scriptBody(filled) : html`<p class="muted">No call script yet. Write the one you want in front of you on every call.</p>`}
    ${edit}
  </div>`;
}

// The filled-in script, a tab for each of its parts (SCRIPT_TABS_SCRIPT;
// without it every part shows, one under the other).
function scriptBody(filled: string): Html {
  const parts = scriptParts(filled);
  const intro = parts[0]?.title === null ? parts[0] : null;
  const titled = parts.filter((part) => part.title !== null);
  const unfilled = PLACEHOLDER.test(filled);
  return html`<div class="script" data-script>
    ${intro ? scriptLines(intro.lines) : ''}
    ${
      titled.length > 1
        ? html`<div class="script-tabs" role="group" aria-label="Parts of the script" hidden>
            ${titled.map(
              (part, i) =>
                html`<button type="button" aria-pressed="${i === 0 ? 'true' : 'false'}">${part.number ? html`<span class="n">${part.number}</span>` : ''}${part.title}</button>`
            )}
          </div>`
        : ''
    }
    ${titled.map(
      (part) => html`<section class="script-part">
        <h3 class="part-title">${part.number ? html`<span class="n">${part.number}</span>` : ''}${part.title}</h3>
        ${scriptLines(part.lines)}
      </section>`
    )}
    ${unfilled ? html`<p class="muted"><mark class="unfilled">Highlighted</mark>: nothing to fill it in with. Say it your way, or change it under Edit script.</p>` : ''}
  </div>
  ${titled.length > 1 ? html`<script>${raw(SCRIPT_TABS_SCRIPT)}</script>` : ''}`;
}

const PLACEHOLDER = /\{[^{}\n]+\}/;

function scriptLines(lines: ScriptLine[]): Html {
  return html`<div class="lines">
    ${lines.map((line) =>
      line.kind === 'blank'
        ? html`<p class="gap"></p>`
        : html`<p class="${line.kind}">${line.text.split(/(\{[^{}\n]+\})/).map((piece, i) => (i % 2 ? html`<mark class="unfilled">${piece}</mark>` : piece))}</p>`
    )}
  </div>`;
}

// One part of the script at a time. A new call starts on the first.
const SCRIPT_TABS_SCRIPT = `(() => {
  const box = document.currentScript.previousElementSibling;
  const bar = box.querySelector('.script-tabs');
  const tabs = [...bar.querySelectorAll('button')];
  const parts = [...box.querySelectorAll('.script-part')];
  const show = (i) => {
    tabs.forEach((t, j) => t.setAttribute('aria-pressed', String(j === i)));
    parts.forEach((p, j) => (p.hidden = j !== i));
  };
  tabs.forEach((t, i) =>
    t.addEventListener('click', () => {
      show(i);
      // Back to the top of the part when the bar was stuck above a long one.
      if (box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: 'start' });
    })
  );
  box.classList.add('tabbed');
  bar.hidden = false;
  show(0);
})();`;

function aboutCard(state: CallPageState): Html {
  const { task, contact, company } = state.parties;
  const c = contact.properties;
  const taskNotes = task.properties.hs_task_body ? htmlToText(task.properties.hs_task_body) : '';
  const co = company?.properties;
  return foldCard(
    'about',
    'person',
    'About them',
    html`${facts([
      ['Contact', contactLinks(state.portalId, contact)],
      ['Title', c.jobtitle],
      ['Email', c.email],
      ['Lead status', humanize(c.hs_lead_status)],
      ['Lifecycle', lifecycle(c.lifecyclestage)],
      ['Address', address(contact)],
    ])}
    ${
      company && co
        ? html`<div class="divided stack">
            ${facts([
              ['Company', companyLinks(state.portalId, company)],
              ['Website', website(company)],
              ['Industry', humanize(co.industry)],
              ['Employees', co.numberofemployees],
              ['Address', address(company)],
            ])}
            ${co.description?.trim() ? html`<pre class="muted">${co.description.trim()}</pre>` : ''}
          </div>`
        : html`<p class="muted">No company in HubSpot.</p>`
    }
    <div class="divided tight"><h3>Last email from this app</h3>${lastEmailCard(state.lastEmail, state.timeZone)}</div>
    ${taskNotes ? html`<div class="divided tight"><h3>Notes on this task</h3><pre>${taskNotes}</pre></div>` : ''}`
  );
}

const HISTORY_KIND: Record<HistoryItem['kind'], { label: string; plural: string; icon: IconName }> = {
  call: { label: 'Call', plural: 'Calls', icon: 'phone' },
  email: { label: 'Email', plural: 'Emails', icon: 'mail' },
  note: { label: 'Note', plural: 'Notes', icon: 'note' },
};

// Also on the interview, contact and company pages. Newest first, each with
// its kind's icon and how long ago it was; buttons over the list show one
// kind at a time (HISTORY_FILTER_SCRIPT).
export function historyCard(state: Pick<CallPageState, 'context' | 'timeZone' | 'now'>): Html {
  const items = historyTimeline(state.context);
  const failed = (['notes', 'calls', 'emails'] as const).filter((k) => state.context[k].failed);
  const kinds = (['call', 'email', 'note'] as const)
    .map((kind) => ({ kind, n: items.filter((item) => item.kind === kind).length }))
    .filter((k) => k.n > 0);
  return foldCard(
    'history',
    'history',
    'HubSpot history',
    html`${
      kinds.length > 1
        ? html`<div class="filters" role="group" aria-label="Show">
            <button type="button" aria-pressed="true" data-kind="">All ${items.length}</button>
            ${kinds.map((k) => html`<button type="button" aria-pressed="false" data-kind="${k.kind}">${HISTORY_KIND[k.kind].plural} ${k.n}</button>`)}
          </div>`
        : ''
    }
    ${
      items.length
        ? html`<ol class="history">
            ${items.map(
              (item) => html`<li class="${item.kind}">
                <span class="kind" title="${HISTORY_KIND[item.kind].label}">${icon(HISTORY_KIND[item.kind].icon)}</span>
                <div class="tight">
                  <span class="muted"><strong class="kind-label">${HISTORY_KIND[item.kind].label}</strong>${item.at === null ? '' : html` · ${ago(item.at, state.now, state.timeZone)} <span class="when">· ${formatLocal(item.at, state.timeZone)}</span>`}${item.detail ? ` · ${item.detail}` : ''}</span>
                  ${item.kind === 'note' ? '' : html`<strong>${item.title}</strong>`}
                  ${
                    item.recorded
                      ? callRecord(item.recorded.notes, item.recorded.transcript, false)
                      : item.fullText
                        ? html`<details class="clipped">
                          <summary><pre>${item.text}</pre><span class="more">Show all</span><span class="less">Show less</span></summary>
                          <pre>${item.fullText}</pre>
                        </details>`
                        : item.text
                          ? html`<pre>${item.text}</pre>`
                          : ''
                  }
                </div>
              </li>`
            )}
          </ol>`
        : html`<p class="muted">No notes, calls or emails on the contact in HubSpot yet.</p>`
    }
    ${failed.map((k) => {
      const scopes = state.context[k].missingScopes;
      return html`<p class="muted">Couldn't load ${k} from HubSpot${
        scopes.length
          ? html`: the HubSpot app is missing the scope for them (${scopes.map((sc, i) => html`${i ? ' or ' : ''}<code>${sc}</code>`)}). See the README's HubSpot app section.`
          : '. Reload to try again.'
      }</p>`;
    })}
    ${kinds.length > 1 ? html`<script>${raw(HISTORY_FILTER_SCRIPT)}</script>` : ''}`,
    html`<span class="muted">${items.length ? `${items.length} · newest first` : ''}</span>`
  );
}

const HISTORY_FILTER_SCRIPT = `(() => {
  const card = document.currentScript.closest('details');
  const buttons = [...card.querySelectorAll('.filters button')];
  for (const b of buttons) {
    b.addEventListener('click', () => {
      for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
      for (const li of card.querySelectorAll('ol.history > li')) li.hidden = Boolean(b.dataset.kind) && !li.classList.contains(b.dataset.kind);
    });
  }
})();`;

export function numbersCard(state: DialView, canDial: boolean): Html {
  const browser = state.setup.callWith === 'browser';
  const from = state.setup.fromNumber ? formatPhone(state.setup.fromNumber) : 'your Twilio number';
  const numbers = PHONE_FIELDS.map((f) => ({ ...f, raw: phoneFor(state.parties, f.field) })).filter((n) => n.raw);
  if (!numbers.length) {
    return html`<div class="stack">
      <p class="muted">No phone number in HubSpot for the contact or the company. Add one here.</p>
      ${editNumbers(state, true)}
    </div>`;
  }
  const wa = state.whatsapp;
  const waFields = wa ? whatsappFields(state.parties.contact) : [];
  return html`<div class="stack">
    ${numbers.map((n) => {
      const e164 = toE164(n.raw);
      const ext = extensionOf(n.raw);
      const waField = waFields.find((f) => f === n.field);
      const waNumber = waField ? whatsappNumber(n.raw) : null;
      return html`<form method="post" action="${state.page}/dial" class="row" ${browser ? 'data-browser-call' : ''}>
        <input type="hidden" name="field" value="${n.field}" />
        <span><span class="muted">${n.label}</span> <strong>${e164 ? formatPhone(e164) : n.raw}</strong>${e164 && ext ? html` <span class="muted">ext. ${ext}, dialled for you</span>` : ''}
          ${e164 ? '' : html`<span class="muted">(can't dial: fix it below, with the country code if it's outside the US)</span>`}</span>
        <span class="actions">
          ${
            wa && waField && waNumber
              ? html`<a class="button" href="${whatsappLink(waNumber, wa.text, state.setup.whatsappOpens)}" ${state.setup.whatsappOpens === 'web' ? html`target="_blank" rel="noopener"` : ''} data-whatsapp="${waField}" data-text="${wa.text}">WhatsApp</a>`
              : ''
          }
          <button type="submit" class="primary" ${canDial && e164 ? '' : 'disabled'}>Call</button>
        </span>
      </form>`;
    })}
    ${
      wa && waFields.length
        ? html`<p class="muted">WhatsApp opens your own chat with them, the message written in for you to send, or call them from the chat.${wa.note ? html` <strong>${wa.note}</strong>` : ''}</p>`
        : ''
    }
    <p class="muted">${
      browser
        ? `You talk through this page, calling from ${from}. Allow the microphone when the browser asks, and use a headset if you can. For a phone menu, use the dial pad (or type the digits). Keep the page open until you hang up: leaving it ends the call.`
        : `Your phone rings first. Answer and press 1 to dial them from ${from}. Once they pick up, your phone's keypad works for their phone menu.`
    }${numbers.some((n) => toE164(n.raw) && extensionOf(n.raw)) ? ` An extension is keyed in two seconds after the line answers. A call to an extension isn't recorded: whoever picks up there wouldn't hear the recording notice.` : ''}</p>
    ${editNumbers(state, false)}
  </div>`;
}

// The contact's phone and mobile, each with an extension, saved to HubSpot
// without leaving the page (NUMBERS_SCRIPT), so a call in the browser keeps
// going and the notes being typed stay. The company's line is edited in
// HubSpot: the app can only write to contacts.
function editNumbers(state: DialView, open: boolean): Html {
  const { contact, company } = state.parties;
  return html`<details ${open ? 'open' : ''}>
    <summary>Edit their numbers</summary>
    <form id="numbers-form" method="post" action="${state.page}/numbers" class="stack">
      ${CONTACT_PHONE_FIELDS.map(({ field, label }) => {
        const raw = contact.properties[field]?.trim() ?? '';
        const shown = phoneBoxes(raw);
        // What HubSpot had when the page loaded: a number left as it was isn't written back.
        return html`<input type="hidden" name="${field}_was" value="${raw}" />
          <div class="phone-edit">
            <div class="field">
              <label for="edit-${field}">${field === 'mobilephone' ? 'Mobile (personal)' : `${label} (office)`}</label>
              <input type="text" inputmode="tel" autocomplete="off" id="edit-${field}" name="${field}" value="${shown.number}" placeholder="801 555 0100" />
            </div>
            <div class="field">
              <label for="edit-${field}-ext">Ext.</label>
              <input type="text" inputmode="numeric" autocomplete="off" id="edit-${field}-ext" name="${field}_ext" value="${shown.ext}" />
            </div>
          </div>`;
      })}
      <p class="muted">Saved on ${contactName(contact)} in HubSpot. Empty a box to remove that number.${
        company
          ? html` The company line is changed <a href="${recordUrl(state.portalId, '0-2', company.id)}" target="_blank" rel="noopener">in HubSpot</a>.`
          : ''
      }</p>
      <p class="row"><button type="submit">Save numbers</button> <span class="muted" data-note role="status"></span></p>
    </form>
    <script>${raw(NUMBERS_SCRIPT)}</script>
  </details>`;
}

// Saves the numbers in the background. Once saved, the page reloads to put
// them by Call, unless that would end a call or lose anything filled in
// elsewhere on the page.
const NUMBERS_SCRIPT = `(() => {
  const form = document.getElementById('numbers-form');
  const note = form.querySelector('[data-note]');
  const button = form.querySelector('button');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true;
    note.textContent = 'Saving to HubSpot…';
    let res;
    try {
      const r = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
      res = (r.headers.get('Content-Type') || '').includes('json')
        ? await r.json()
        : { error: 'The app couldn’t save them (error ' + r.status + '). Try again.' };
    } catch {
      res = { error: 'The app couldn’t be reached. Check your connection and try again.' };
    }
    button.disabled = false;
    if (res.error) return void (note.textContent = res.error);
    if (!res.saved) return void (note.textContent = 'No change: HubSpot already has these.');
    const inCall = document.body.classList.contains('in-call') || document.querySelector('#dial-status[data-live]');
    // Any other field changed since the page loaded: notes, the outcome, a date, a box ticked.
    const edited = [...document.querySelectorAll('input, textarea, select')].some((el) => {
      if (form.contains(el) || el.type === 'hidden') return false;
      if (el.tagName === 'SELECT') return [...el.options].some((o) => o.selected !== o.defaultSelected);
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
      return el.value !== el.defaultValue;
    });
    if (!inCall && !edited) return location.reload();
    note.textContent = 'Saved in HubSpot. They show by Call next time the page loads.';
  });
})();`;

export function lastEmailCard(email: RecentSend | null, timeZone: string): Html {
  if (!email) return html`<p class="muted">No email sent to them from this app.</p>`;
  const lastOpen = sqliteTime(email.last_open_at);
  const opens =
    email.track_opens === 0
      ? 'opens not tracked'
      : `${email.opens} opens${lastOpen === null ? '' : ` (last ${formatLocal(lastOpen, timeZone)})`}`;
  const clicks = email.track_clicks === 0 ? 'clicks not tracked' : `${email.clicks} clicks`;
  return html`<div class="tight">
    <span><strong>${email.subject}</strong></span>
    <span class="muted">Sent ${email.sent_at?.slice(0, 16).replace('T', ' ') ?? ''} · ${opens} · ${clicks}</span>
  </div>`;
}

// The call's status, which the page fetches again (GET
// <page>/dial/<dial id>/status) while the call is live, rather than
// reloading everything on it. Once the call is over, the page reloads once to
// show how it went and the log form.
export function liveDialStatus(page: string, state: Pick<DialView, 'dial' | 'dialState'>): Html | '' {
  if (!state.dial || !state.dialState) return '';
  const live = isLive(state.dialState);
  return html`<div id="dial-status" data-src="${page}/dial/${state.dial.id}/status" ${live ? raw('data-live') : ''}>
    ${dialStatus(state)}
  </div>`;
}

export const LIVE_STATUS_SCRIPT = `(() => {
  const poll = async () => {
    const box = document.getElementById('dial-status');
    if (!box || !box.hasAttribute('data-live')) return;
    try {
      const res = await fetch(box.dataset.src, { cache: 'no-store' });
      if (res.ok) {
        box.outerHTML = await res.text();
        const now = document.getElementById('dial-status');
        if (now && !now.hasAttribute('data-live')) return location.reload();
      }
    } catch {}
    setTimeout(poll, ${LIVE_POLL_MS});
  };
  setTimeout(poll, ${LIVE_POLL_MS});
})();`;

export function dialStatus(state: Pick<DialView, 'dial' | 'dialState'>): Html | '' {
  const s = state.dialState;
  if (!s || !state.dial) return '';
  if (s.kind === 'ringing-rep' && state.dial.mode === 'browser') {
    return flashBox('warn', 'Starting the call from the browser…');
  }
  if (s.kind === 'ringing-rep') {
    return flashBox(
      'warn',
      html`Ringing your phone (${formatPhone(state.dial.rep_number)}). Answer and press 1 to connect.`
    );
  }
  if (s.kind === 'wrapping-up') return flashBox('ok', 'Call ended. Getting its length and outcome from Twilio…');
  if (s.kind === 'on-call') {
    const recording = state.dial.record ? html` Recording: they heard the notice first.` : '';
    // A call back logs itself; the other calls wait on the rep's log form.
    const next = state.dial.subject === 'inbound' ? '' : ' Log it here when you hang up.';
    return flashBox('ok', html`On the call with ${state.dial.contact_label}.${recording}${next}`);
  }
  return flashBox(s.answered ? 'ok' : 'warn', html`Last call: ${s.summary}`);
}

// What the outcome picker starts on, from what Twilio saw.
function suggestedOutcome(dial: Dial | null): CallOutcome {
  if (dial?.prospect_status === 'busy') return 'busy';
  if (dial?.prospect_status === 'completed') return 'connected';
  return 'no_answer';
}

// Date, time, length, phone or video (and its join link) of an interview.
// `prefix` keeps the ids apart when two forms on the page have these fields.
// A phone call is the default, unless HubSpot has no number to call.
function bookingFields(prefix: string, state: CallPageState, required: boolean): Html {
  const email = state.parties.contact.properties.email?.trim() || null;
  const phone = firstPhone(state.parties.contact, state.parties.company);
  const today = localDate(state.now, state.timeZone);
  const tomorrow = addDays(today, 1);
  const req = required ? 'required' : '';
  return html`<div class="tight">
      <label class="check"><input type="radio" name="book_format" value="phone" ${phone ? 'checked' : 'disabled'} /> Phone call${
        phone
          ? html`: you call them at ${formatPhone(phone)}`
          : html` <span class="muted">(no phone number in HubSpot)</span>`
      }</label>
      <label class="check"><input type="radio" name="book_format" value="video" ${phone ? '' : 'checked'} /> Video call (Google Meet or Zoom)</label>
    </div>
    <div class="grid-2">
      <div class="field">
        <label for="${prefix}_date">Date</label>
        <input type="date" id="${prefix}_date" name="book_date" value="${tomorrow}" min="${today}" ${req} />
      </div>
      <div class="field">
        <label for="${prefix}_time">Time</label>
        ${timeInput({
          name: 'book_time',
          id: `${prefix}_time`,
          required,
          zones: {
            yours: state.timeZone,
            theirs: partyTimeZone(state.parties.contact, state.parties.company),
            dateName: 'book_date',
          },
        })}
      </div>
    </div>
    <div class="grid-2">
      <div class="field">
        <label for="${prefix}_minutes">Length</label>
        <select id="${prefix}_minutes" name="book_minutes">
          ${LENGTHS_MIN.map((m) => html`<option value="${m}" ${m === 30 ? 'selected' : ''}>${m} min</option>`)}
        </select>
      </div>
      <div class="field" data-video-only>
        <label for="${prefix}_join_url">Meet or Zoom link (optional)</label>
        <input type="url" id="${prefix}_join_url" name="book_join_url" placeholder="https://meet.google.com/…" />
      </div>
    </div>
    <div class="tight">
      <label class="check"><input type="checkbox" name="book_invite" value="1" ${email ? '' : 'disabled'} /> Send ${email ?? 'them'} a calendar invite</label>
      <p class="muted check-help">${
        email
          ? 'From your connected Google account. A phone call’s invite says you’ll call them at that number. A video call’s has a Google Meet link unless you gave one above. It’s sent once, even if you submit twice.'
          : 'No email in HubSpot for this contact, so there’s nobody to invite.'
      }</p>
    </div>`;
}

// Ticking "Booked an interview" shows its fields and drops the follow-up
// call, since the interview is the next step.
const BOOKING_SCRIPT = `(() => {
  const box = document.getElementById('book');
  const fields = document.getElementById('book-fields');
  const next = document.getElementById('next_type');
  const outcome = document.getElementById('outcome');
  if (!box || !fields) return;
  const sync = () => {
    fields.hidden = !box.checked;
    for (const input of fields.querySelectorAll('input[type=date], input[data-time]')) input.required = box.checked;
  };
  box.addEventListener('change', () => {
    sync();
    if (box.checked) {
      if (next) {
        next.value = '';
        next.dispatchEvent(new Event('change'));
      }
      if (outcome) outcome.value = 'connected';
    }
  });
  sync();
})();`;

// The set time is only for a follow-up call.
const NEXT_TIME_SCRIPT = `(() => {
  const next = document.getElementById('next_type');
  const field = document.getElementById('next-time-field');
  if (!next || !field) return;
  const sync = () => {
    field.hidden = next.value !== 'CALL';
    if (field.hidden) field.querySelector('input').value = '';
  };
  next.addEventListener('change', sync);
  sync();
})();`;

// Shows the join link only for a video call, in each form with booking fields.
const BOOKING_FORMAT_SCRIPT = `(() => {
  for (const form of document.querySelectorAll('form')) {
    const video = form.querySelector('[data-video-only]');
    const radios = form.querySelectorAll('input[name=book_format]');
    if (!video || !radios.length) continue;
    const sync = () => {
      video.hidden = form.querySelector('input[name=book_format]:checked')?.value !== 'video';
    };
    for (const radio of radios) radio.addEventListener('change', sync);
    sync();
  }
})();`;

function bookCard(state: CallPageState): Html {
  return html`<details class="card" id="book">
    <summary class="card-head"><h2>${icon('calendar')}Book an interview</h2><span class="muted">set up another way, without logging a call</span></summary>
    <form method="post" action="/calls/${state.parties.task.id}/book" class="stack">
      ${bookingFields('solo', state, true)}
      <p class="muted">Creates the meeting in HubSpot on ${contactName(state.parties.contact)}. This call task stays open.</p>
      <button type="submit">Book interview</button>
    </form>
  </details>`;
}

function interviewsNotice(state: CallPageState): Html | '' {
  const missed = state.missedInterview;
  if (missed) {
    return flashBox(
      'warn',
      html`${contactName(state.parties.contact)} missed <a href="/meetings/${missed.meetingId}">their interview</a>${
        missed.startAt === null ? '' : html` on ${formatLocal(missed.startAt, state.timeZone)}`
      }. If this call doesn't reach them either, log it with the last-try email.`
    );
  }
  if (!state.interviews.length) return '';
  return flashBox(
    'ok',
    html`This contact has an interview booked: ${state.interviews.map(
      (m, i) =>
        html`${i ? ', ' : ''}<a href="/meetings/${m.meetingId}">${m.startAt === null ? m.title : formatLocal(m.startAt, state.timeZone)}</a>`
    )}. Open it to prep.`
  );
}

function logForm(state: CallPageState): Html {
  const taskId = state.parties.task.id;
  const suggested = suggestedOutcome(state.dial);
  const defaultNext = localDate(state.now + 2 * 86_400_000, state.timeZone);
  const today = localDate(state.now, state.timeZone);
  const waFields = whatsappFields(state.parties.contact);
  return html`<form class="card" id="log-form" method="post" action="/calls/${taskId}/log" data-submit-once>
    ${cardHead('log', 'Log the call')}
    ${state.dial ? html`<input type="hidden" name="dial_id" value="${state.dial.id}" />` : ''}
    ${
      waFields.length
        ? html`<div class="field">
            <label for="channel">How you reached them</label>
            <select id="channel" name="channel">
              <option value="phone" selected>Phone call</option>
              <option value="whatsapp_call">WhatsApp call</option>
              <option value="whatsapp_message">WhatsApp message</option>
            </select>
            <input type="hidden" name="whatsapp_field" value="${waFields[0]}" />
          </div>`
        : ''
    }
    <div class="field">
      <label for="outcome">Outcome</label>
      <select id="outcome" name="outcome">
        <optgroup label="Call" data-channel="call">
          ${CALL_OUTCOMES.map((o) => html`<option value="${o.value}" ${o.value === suggested ? 'selected' : ''}>${o.label}</option>`)}
        </optgroup>
        ${
          waFields.length
            ? html`<optgroup label="WhatsApp message" data-channel="message" hidden disabled>
                ${MESSAGE_OUTCOMES.map((o) => html`<option value="${o.value}">${o.label}</option>`)}
              </optgroup>`
            : ''
        }
      </select>
    </div>
    <div class="field">
      <label for="notes">Notes</label>
      <textarea id="notes" name="notes" class="mono" placeholder="What they said, what's next. For a WhatsApp message, the message you sent."></textarea>
    </div>
    ${conversationBox(
      ['connected', 'replied'],
      suggestConversation({ kind: 'call', outcome: suggested, durationSec: state.dial?.prospect_duration_sec })
    )}
    <div class="tight">
      <label class="check"><input type="checkbox" id="book" name="book" value="1" /> Booked an interview</label>
      <div id="book-fields" class="stack" hidden>${bookingFields('log', state, false)}</div>
    </div>
    <div class="grid-2">
      <div class="field">
        <label for="next_type">Follow-up task</label>
        <select id="next_type" name="next_type">
          <option value="CALL" ${state.missedInterview ? '' : 'selected'}>Call again</option>
          <option value="EMAIL">Email</option>
          <option value="${LAST_TRY}" ${state.missedInterview ? 'selected' : ''}>Email: last try, closing the loop (draft ready)</option>
          <option value="">None</option>
        </select>
      </div>
      <div class="field">
        <label for="next_date">On</label>
        <input type="date" id="next_date" name="next_date" value="${defaultNext}" min="${today}" />
      </div>
    </div>
    <div class="field" id="next-time-field">
      <label for="next_time">At a set time <span class="muted">(optional)</span></label>
      ${timeInput({
        name: 'next_time',
        id: 'next_time',
        zones: {
          yours: state.timeZone,
          theirs: partyTimeZone(state.parties.contact, state.parties.company),
          dateName: 'next_date',
        },
      })}
      <p class="muted">Only when they asked to be called at a time. If they said it in their time, pick their zone: it’s saved in yours. HubSpot reminds you 5 minutes before, and it’s the next call from then. Left blank, it’s due at this call’s usual time.</p>
    </div>
    <ol class="consequences">
      <li>The call goes on the contact's HubSpot timeline with this outcome${state.dial ? ', its length and numbers' : ''}${waFields.length ? '. A WhatsApp message goes on it as a WhatsApp message' : ''}.</li>
      <li>This call task is marked completed.</li>
      <li>The follow-up task, if any, is created for that day, at the set time if you gave one. The last-try email comes with its draft written, from your follow-up template.</li>
      <li>Their Lead Status moves to Connected or Attempted to Contact, unless you've already set it further along.</li>
      <li>If you booked an interview, it's created as a meeting in HubSpot and shows under Interviews.</li>
    </ol>
    ${
      state.log
        ? flashBox(
            'warn',
            html`An earlier attempt stopped partway${state.log.last_error ? html` (${state.log.last_error})` : ''}. Logging again finishes it with what you entered the first time.`
          )
        : ''
    }
    <button type="submit" class="primary wide" data-busy="Logging…">Log call &amp; complete task</button>
    <p class="muted">${state.dial ? '' : 'No call from this app yet: this logs a call you made another way, or a WhatsApp call or message.'}</p>
  </form>
  ${waFields.length ? html`<script>${raw(CHANNEL_SCRIPT)}</script>` : ''}`;
}

// The call page's WhatsApp button: the opener, written in for the rep.
function callWhatsApp(state: CallPageState): WhatsAppDraft {
  return {
    text: whatsappOpener({
      firstName: state.parties.contact.properties.firstname,
      repName: state.setup.fromName,
      company: companyName(state.parties.company),
    }),
    note: contactHoursNote(state.now, state.timeZone),
  };
}

// The log form's outcomes follow its channel: a WhatsApp message has its own.
// A WhatsApp button on the page sets the form up for the message it opened.
const CHANNEL_SCRIPT = `(() => {
  const form = document.getElementById('log-form');
  const channel = form.querySelector('#channel');
  const outcome = form.querySelector('#outcome');
  const notes = form.querySelector('#notes');
  const field = form.querySelector('[name=whatsapp_field]');
  const show = () => {
    const message = channel.value === 'whatsapp_message';
    for (const group of outcome.querySelectorAll('optgroup')) {
      const on = (group.dataset.channel === 'message') === message;
      group.hidden = !on;
      group.disabled = !on;
    }
    if (outcome.selectedOptions[0]?.parentElement.disabled) {
      outcome.value = outcome.querySelector('optgroup:not([disabled]) option').value;
    }
  };
  channel.addEventListener('change', show);
  for (const link of document.querySelectorAll('[data-whatsapp]')) {
    link.addEventListener('click', () => {
      field.value = link.dataset.whatsapp;
      if (channel.value === 'phone') channel.value = 'whatsapp_message';
      if (!notes.value.trim()) notes.value = link.dataset.text;
      show();
    });
  }
  show();
})();`;

function showRecording(state: CallPageState, live: boolean): boolean {
  return !live && state.dial !== null && state.recordingState !== null && state.recordingState.kind !== 'none';
}

// The call page's cards, in the order they're on the page.
function jumpLinks(state: CallPageState, live: boolean): JumpLink[] {
  const coached = !live && (state.coaching.after !== null || state.coaching.before.length > 0);
  return [
    ...(state.lastConversation ? [{ id: 'last-talk', icon: 'history', label: 'Last time' } as const] : []),
    { id: 'script', icon: 'script', label: 'Script' },
    { id: 'numbers', icon: 'phone', label: 'Numbers' },
    ...(coached ? [{ id: 'coaching', icon: 'coaching', label: 'Coaching' } as const] : []),
    ...(showRecording(state, live) ? [{ id: 'transcript', icon: 'recording', label: 'Recording' } as const] : []),
    { id: 'history', icon: 'history', label: 'History' },
    { id: 'about', icon: 'person', label: 'About' },
    { id: 'log', icon: 'log', label: 'Log' },
  ];
}

// Said once the rep lands on the next call: what was just logged, so the new
// page doesn't read as the same one. Its HubSpot steps are still running.
function handoff(j: NonNullable<CallPageState['justLogged']>, timeZone: string): Html {
  const log = j.log;
  const nextDue = log?.next_due ? Date.parse(log.next_due) : NaN;
  const followUp =
    log?.next_type && Number.isFinite(nextDue)
      ? `follow-up ${log.next_type === 'CALL' ? 'call' : 'email'} ${
          log.next_set_time ? formatLocal(nextDue, timeZone) : formatDay(nextDue, timeZone)
        }`
      : log
        ? 'no follow-up'
        : '';
  const done = log
    ? html`<a href="/calls/${j.taskId}">${log.title}</a> · ${OUTCOME_LABELS[log.outcome] ?? log.outcome}${followUp ? ` · ${followUp}` : ''}${
        log.book_start ? ' · interview booked' : ''
      }`
    : html`<a href="/calls/${j.taskId}">the last call</a>`;
  return html`<div class="handoff" role="status">
    <p><strong>✓ Logged</strong> ${done}</p>
    <p class="muted">Saving to HubSpot now; the notice at the top says if anything didn’t finish. This is your next call.</p>
  </div>`;
}

// Today's calls in the order the queue ranks them, beside the call: done,
// this one (highlighted), the one logging goes to next, and the rest (a
// set-time one with its time), any of them a click away. Who each is comes from the saved order, so this reads no HubSpot.
function todaysCalls(today: PlanProgress | null, timeZone: string): Html {
  if (!today) {
    return html`<nav class="card rail" aria-label="Today’s calls">
      <h2>Today’s calls</h2>
      <p class="muted">Open <a href="/queue/calls">Calls to make</a> to line up today’s calls here.</p>
    </nav>`;
  }
  return html`<nav class="card rail" aria-label="Today’s calls">
    <div class="row">
      <h2>Today’s calls</h2>
      <span class="muted">${today.left} left${today.done ? ` · ${today.done} done` : ''}</span>
    </div>
    ${
      today.items.length
        ? html`<ol class="rail-list">
            ${today.items.map(
              (i) => html`<li class="${i.state}">
                <a href="/calls/${i.id}" ${i.state === 'current' ? html`aria-current="page"` : html`data-prefetch-hover`}>
                  <span class="rail-who">${i.done ? '✓ ' : ''}${i.company ?? i.contact ?? `Call task ${i.id}`}</span>
                  ${i.state === 'next' ? html`<span class="tag">Next</span>` : ''}
                  ${
                    i.company && i.contact
                      ? html`<span class="muted">${i.contact}${i.at !== undefined ? ` · ${formatClock(askedFor(i.at), timeZone)}` : ''}</span>`
                      : i.at !== undefined
                        ? html`<span class="muted">${formatClock(askedFor(i.at), timeZone)}</span>`
                        : ''
                  }
                </a>
              </li>`
            )}
          </ol>`
        : html`<p class="muted">Nothing lined up for today.</p>`
    }
    <a href="/queue/calls">All calls to make →</a>
  </nav>
  <script>${raw(RAIL_SCRIPT)}</script>`;
}

// Scrolls the list (not the page) to this call, a few above it showing.
const RAIL_SCRIPT = `(() => {
  const rail = document.querySelector('.rail');
  const current = rail && rail.querySelector('.current');
  if (current) rail.scrollTop += current.getBoundingClientRect().top - rail.getBoundingClientRect().top - 96;
})();`;

export function callPage(state: CallPageState, actor: string): Html {
  const { task, contact, company } = state.parties;
  const company_ = companyName(company);
  const contact_ = contactName(contact);
  // A log that stopped partway leaves the task COMPLETED in HubSpot with
  // steps still to do; it isn't finished until the whole workflow is.
  const unfinishedLog = state.log !== null && !callLogDone(state.log);
  const completed = task.properties.hs_task_status === 'COMPLETED' && !unfinishedLog;
  // Dropped: no call logged, no follow-up (POST /calls/:id/drop).
  const dropped = task.properties.hs_task_status === 'DEFERRED' && state.log === null;
  // Its HubSpot steps are running now, after the rep moved on.
  const saving = unfinishedLog && state.log?.lock_until != null && state.log.lock_until >= Math.floor(state.now / 1000);
  const live = state.dialState !== null && isLive(state.dialState);
  const canDial = setupReady(state.setup) && !live && !completed && !dropped;
  const browserCalls = canDial && state.setup.callWith === 'browser';
  const dueAt = task.properties.hs_timestamp ? Date.parse(task.properties.hs_timestamp) : NaN;

  return layout(
    `Call · ${company_ ?? contact_}`,
    actor,
    html`<div class="with-rail">
      ${todaysCalls(state.today, state.timeZone)}
      <div class="stack">
      <p class="row">
        <a href="/queue/calls">← Calls to make</a>
        ${state.nextCallId ? html`<a href="/calls/${state.nextCallId}" data-prefetch>Next call →</a>` : ''}
      </p>
      ${state.justLogged ? handoff(state.justLogged, state.timeZone) : ''}
      <div class="tight${state.justLogged ? ' arrived' : ''}">
        ${state.justLogged ? html`<p class="kicker">Next call</p>` : ''}
        <h1>${company_ ?? contact_}</h1>
        <p class="muted">
          <a href="/contacts/${contact.id}">${contact_}</a>${contact.properties.jobtitle ? ` · ${contact.properties.jobtitle}` : ''} ·
          ${task.properties.hs_task_subject ?? 'Call task'}${Number.isFinite(dueAt) ? ` · due ${formatLocal(dueAt, state.timeZone)}` : ''} ·
          <a href="${recordUrl(state.portalId, '0-1', contact.id)}" target="_blank" rel="noopener">contact in HubSpot</a>
        </p>
      </div>
      ${whereTheyAre(contact, company)}
      ${state.scriptSaved ? flashBox('ok', 'Script saved. It’s the same on every call.') : ''}
      ${setupWarning(state.setup)}
      ${interviewsNotice(state)}
      ${live ? liveDialStatus(`/calls/${task.id}`, state) : dialStatus(state)}

      ${jumpBar(jumpLinks(state, live))}
      <div class="with-aside">
        <div class="stack">
          ${lastConversationCard(state.lastConversation, state.timeZone, state.now)}
          ${scriptCard(state, live)}
          ${browserCalls ? browserCallPanel : ''}
          <div class="card" id="numbers">
            ${cardHead('phone', 'Numbers')}
            ${numbersCard({ ...state, page: `/calls/${task.id}`, whatsapp: completed || dropped ? null : callWhatsApp(state) }, canDial)}
          </div>
          ${live ? '' : coachingCard(state.coaching)}
          ${showRecording(state, live) && state.dial && state.recordingState ? transcriptCard(`/calls/${task.id}`, state.dial, state.recordingState) : ''}
          ${historyCard(state)}
          ${aboutCard(state)}
          ${bookCard(state)}
        </div>
        <div id="log">
          ${
            dropped
              ? html`<div class="card"><p>This call task was dropped.</p><p class="muted">It’s marked Deferred in HubSpot: no call was logged and no follow-up created.</p></div>`
              : completed
                ? html`<div class="card"><p>This call task is completed.</p><p class="muted">${state.log?.logged_message_id ? 'The WhatsApp message is on the contact’s timeline.' : state.log?.logged_call_id ? 'The call is on the contact’s timeline.' : 'Check the contact’s timeline in HubSpot for the call.'}</p></div>`
                : live
                  ? html`<div class="card"><p class="muted">The log form appears when the call ends. This page updates on its own.</p></div>`
                  : saving
                    ? html`<div class="card"><p>Saving this call to HubSpot.</p><p class="muted">It takes a few seconds. Refresh to see it finished.</p></div>`
                    : html`<div class="stack">
                    ${logForm(state)}
                    <div class="card split">
                      <p class="muted">Not calling them? Drop the task: no call is logged and no follow-up created.</p>
                      ${dropForm(task.id, contact_)}
                    </div>
                  </div>`
          }
        </div>
      </div>
      ${!live && state.recordingState?.kind === 'pending' ? html`<script>${raw(POLL_SCRIPT)}</script>` : ''}
      ${!completed && !dropped && !live ? html`<script>${raw(BOOKING_SCRIPT)}</script><script>${raw(NEXT_TIME_SCRIPT)}</script>` : ''}
      <script>${raw(BOOKING_FORMAT_SCRIPT)}</script><script>${raw(SAID_TIME_SCRIPT)}</script>
      ${browserCalls ? browserCallScripts() : ''}
      ${state.callNow ? html`<script>${raw(DROP_CALL_NOW_SCRIPT)}</script>` : ''}
      ${state.callNow && canDial ? html`<script>${raw(CALL_NOW_SCRIPT)}</script>` : ''}
      ${live ? html`<script>${raw(LIVE_STATUS_SCRIPT)}</script>` : ''}
      </div>
    </div>`,
    'queue'
  );
}

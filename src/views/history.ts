import { html } from 'hono/html';
import {
  clock,
  cursorParam,
  dialPagePath,
  searchMatches,
  type HandLoggedCall,
  type HistoryDial,
  type HistoryFilters,
  type HistoryItem,
  type HistoryPage,
  type SearchMatch,
  type Snippet,
} from '../lib/call-history';
import { formatLocal } from '../lib/dates';
import type { CallInsight, DialSubject, InboundCall } from '../lib/db';
import { parseUnsure } from '../lib/call-insight';
import { parseTimeline } from '../lib/call-timeline';
import { formatPhone } from '../lib/phone';
import { dialTranscript, SPEAKER_LABELS, type CallTranscript } from '../lib/transcript';
import { dialState, formatDuration, isLive } from '../workflows/dial';
import {
  callerName,
  callerPlace,
  INBOUND_TAGS,
  inboundOutcome,
  inboundRecordingState,
  inboundSummary,
  shownNumber,
} from '../workflows/inbound';
import { recordingState, type RecordingState } from '../workflows/transcribe';
import { OUTCOME_LABELS, transcriptTurns } from './calls';
import { humanize } from './facts';
import { LIVE_REFRESH_SEC, setupNote, type InboundSetup } from './inbound';
import { callTags } from './coaching';
import { layout, type Html } from './layout';
import { timelineStrip } from './timeline';

export interface HistoryPageState {
  page: HistoryPage;
  filters: HistoryFilters;
  setup: InboundSetup;
  nowSec: number;
  timeZone: string;
  insights: Map<string, CallInsight>; // by CALL task: what coaching read from each logged call
  back: string; // this page, to come back to after a button
}

// What coaching reads this call under: the CALL task for a call made from
// one or logged by hand, the meeting for an interview's call.
export function coachedTaskId(item: HistoryItem): string | null {
  if (item.kind === 'dial') return item.dial.subject === 'inbound' ? null : item.dial.task_id;
  return item.kind === 'logged' ? item.log.call_task_id : null;
}

const SOURCES: Record<DialSubject, string> = { task: 'Call task', meeting: 'Interview', inbound: 'Call back' };

// Everything a call's card shows, whatever kind of call it is.
interface Entry {
  atSec: number;
  direction: { label: string; inbound: boolean };
  source: string;
  who: string;
  contactId: string | null;
  details: string[]; // the number, where it's from
  durationSec: number | null;
  happened: string; // what Twilio saw
  outcome: string | null; // what the rep logged
  notes: string | null; // the rep's notes
  recorded: {
    state: RecordingState;
    transcript: CallTranscript | null;
    audio: string | null;
  };
  open: string;
  coaching: { taskId: string; insight: CallInsight | null } | null; // a logged call from a task
}

function outcomeLabel(outcome: string | null): string | null {
  return outcome ? (OUTCOME_LABELS[outcome] ?? humanize(outcome)) : null;
}

function dialEntry(dial: HistoryDial, nowSec: number): Omit<Entry, 'coaching'> {
  const state = dialState(dial, nowSec);
  const page = dialPagePath(dial.subject, dial.task_id);
  return {
    atSec: dial.started_sec,
    direction: { label: 'Outbound', inbound: false },
    source: SOURCES[dial.subject],
    who: dial.contact_label,
    contactId: dial.contact_id || null,
    details: [formatPhone(dial.to_number)],
    durationSec: dial.prospect_status === 'completed' ? dial.prospect_duration_sec : null,
    happened:
      state.kind === 'ended'
        ? state.summary
        : state.kind === 'on-call'
          ? 'On the call.'
          : state.kind === 'wrapping-up'
            ? 'Call ended. Getting its length and outcome from Twilio…'
            : 'Ringing.',
    outcome: outcomeLabel(dial.log_outcome),
    notes: dial.log_notes,
    recorded: {
      state: recordingState(dial, nowSec),
      transcript: dialTranscript(dial),
      audio: dial.recording_sid ? `${page}/recording/${dial.id}` : null,
    },
    open: page,
  };
}

function inboundEntry(call: InboundCall, nowSec: number): Omit<Entry, 'coaching'> {
  const outcome = inboundOutcome(call);
  return {
    atSec: call.started_sec,
    direction: { label: INBOUND_TAGS[outcome], inbound: true },
    source: 'Call to your number',
    who: callerName(call),
    contactId: call.contact_id,
    details: [shownNumber(call), callerPlace(call)].filter((d): d is string => d !== null),
    durationSec: outcome === 'voicemail' ? call.recording_duration_sec : call.talk_sec,
    happened: inboundSummary(call),
    outcome: null,
    notes: null,
    recorded: {
      state: inboundRecordingState(call, nowSec),
      transcript: dialTranscript(call),
      audio: call.recording_sid ? `/inbound/${call.id}/recording` : null,
    },
    open: `/inbound/${encodeURIComponent(call.id)}`,
  };
}

const LOGGED_HOW: Record<HandLoggedCall['channel'], { source: string; happened: string }> = {
  phone: { source: 'Logged by hand', happened: 'Dialled outside the app.' },
  whatsapp_call: { source: 'WhatsApp call', happened: 'Called on WhatsApp.' },
  whatsapp_message: { source: 'WhatsApp message', happened: 'Messaged on WhatsApp.' },
};

function loggedEntry(log: HandLoggedCall): Omit<Entry, 'coaching'> {
  const how = LOGGED_HOW[log.channel] ?? LOGGED_HOW.phone;
  return {
    atSec: log.at_sec,
    direction: { label: 'Outbound', inbound: false },
    source: how.source,
    who: log.title,
    contactId: log.contact_id,
    details: log.to_number ? [formatPhone(log.to_number)] : [],
    durationSec: log.duration_sec,
    happened: how.happened,
    outcome: outcomeLabel(log.outcome),
    notes: log.notes,
    recorded: { state: { kind: 'none' }, transcript: null, audio: null },
    open: dialPagePath('task', log.call_task_id),
  };
}

function entryOf(item: HistoryItem, nowSec: number, insights: Map<string, CallInsight>): Entry {
  const entry =
    item.kind === 'dial'
      ? dialEntry(item.dial, nowSec)
      : item.kind === 'inbound'
        ? inboundEntry(item.call, nowSec)
        : loggedEntry(item.log);
  const taskId = coachedTaskId(item);
  // A call from a task once the rep logged it; an interview's once the call ended.
  const logged =
    item.kind === 'logged' ||
    (item.kind === 'dial' &&
      (item.dial.subject === 'meeting' ? !isLive(dialState(item.dial, nowSec)) : item.dial.log_outcome !== null));
  const coached = taskId && logged && !(item.kind === 'logged' && item.log.channel === 'whatsapp_message');
  const insight = taskId ? (insights.get(taskId) ?? null) : null;
  // An interview's reading is of its latest call: an earlier attempt from the
  // same page shows nothing rather than another call's coaching.
  const theirs =
    item.kind !== 'dial' || item.dial.subject !== 'meeting' || !insight || insight.dial_id === item.dial.id;
  return { ...entry, coaching: coached && theirs ? { taskId, insight } : null };
}

// What coaching read from the call (drawn to scale, then its tags), and the
// button that leaves it out (a test call) or puts it back.
function coachingPart(coaching: NonNullable<Entry['coaching']>, back: string): Html {
  const { insight } = coaching;
  const excluded = insight?.excluded === 1;
  const timeline = insight && !excluded ? parseTimeline(insight.timeline_json) : null;
  return html`${timeline && insight ? timelineStrip(timeline, { outcome: outcomeLabel(insight.outcome) }) : ''}
    <div class="row">
    ${
      excluded
        ? html`<p class="muted">Left out of coaching.</p>`
        : insight
          ? callTags(insight, parseUnsure(insight.unsure))
          : html`<p class="muted">Not read for coaching yet.</p>`
    }
    <form method="post" action="/coaching/calls/${coaching.taskId}/exclude">
      <input type="hidden" name="excluded" value="${excluded ? '0' : '1'}" />
      <input type="hidden" name="back" value="${back}" />
      <button type="submit" class="quiet">${excluded ? 'Put back in coaching' : 'Leave out of coaching'}</button>
    </form>
  </div>`;
}

function isLiveItem(item: HistoryItem, nowSec: number): boolean {
  if (item.kind === 'dial') return isLive(dialState(item.dial, nowSec));
  return item.kind === 'inbound' && inboundOutcome(item.call) === 'live';
}

// The summary inline, where it's quickest to read; the transcript and the
// recording one click away.
function recordedPart(e: Entry, showSummary: boolean): Html | '' {
  const { state, transcript, audio } = e.recorded;
  const summary =
    showSummary && transcript?.summary.length
      ? html`<ul class="summary">${transcript.summary.map((l) => html`<li>${l}</li>`)}</ul>`
      : '';
  const status =
    state.kind === 'pending'
      ? html`<p class="muted">${state.message}</p>`
      : state.kind === 'failed'
        ? html`<p class="muted">${state.message}${state.canRetry ? html` <a href="${e.open}">Open the call</a> to transcribe it again.` : ''}</p>`
        : '';
  const more =
    transcript || audio
      ? html`<details>
          <summary>${transcript ? 'Transcript' : 'Recording'}${transcript && audio ? ' & recording' : ''}</summary>
          <div class="stack">
            ${audio ? html`<audio class="recording" controls preload="none" src="${audio}"></audio>` : ''}
            ${transcript ? transcriptTurns(transcript.turns) : ''}
          </div>
        </details>`
      : '';
  return html`${summary}${status}${more}`;
}

function marked(s: Snippet): Html {
  return html`${s.before}<mark>${s.hit}</mark>${s.after}`;
}

function matchLabel(m: SearchMatch): string {
  if (m.where !== 'transcript') return m.where === 'summary' ? 'Summary' : 'Your notes';
  return `${SPEAKER_LABELS[m.speaker]} at ${clock(m.startSec)}`;
}

// Why the call came up in the search: the words in its summary, the notes or
// what was said, in place of the full summary and notes.
function matchesPart(matches: SearchMatch[]): Html {
  return html`<div class="matches">
    ${matches.map((m) => html`<span class="muted">${matchLabel(m)}</span><span>${marked(m.snippet)}</span>`)}
  </div>`;
}

function entryCard(e: Entry, q: string | null, timeZone: string, back: string): Html {
  const when = [formatLocal(e.atSec * 1000, timeZone), e.source];
  if (e.durationSec) when.push(formatDuration(e.durationSec));
  const notes = e.notes?.trim();
  const { transcript } = e.recorded;
  const matches = q
    ? searchMatches(q, { summary: transcript?.summary ?? [], notes: notes ?? null, turns: transcript?.turns ?? [] })
    : [];
  return html`<li class="card">
    <div class="row">
      <div class="tight">
        <span>
          <span class="tag ${e.direction.inbound ? 'in' : 'out'}">${e.direction.label}</span>
          <strong>${e.contactId ? html`<a href="/contacts/${e.contactId}" data-prefetch-hover>${e.who}</a>` : e.who}</strong>
          ${e.details.length ? html`<span class="muted">· ${e.details.join(' · ')}</span>` : ''}
        </span>
        <span class="muted">${when.join(' · ')}</span>
      </div>
      <a class="button" href="${e.open}" data-prefetch-hover>Open</a>
    </div>
    <p>${e.outcome ? html`<strong>${e.outcome}.</strong> ` : ''}<span class="muted">${e.happened}</span></p>
    ${matches.length ? matchesPart(matches) : ''}
    ${recordedPart(e, !matches.length)}
    ${notes && !matches.length ? html`<div class="tight"><h3>Your notes</h3><p class="pre">${notes}</p></div>` : ''}
    ${e.coaching ? coachingPart(e.coaching, back) : ''}
  </li>`;
}

function historyUrl(filters: Partial<HistoryFilters>): string {
  const params = new URLSearchParams();
  if (filters.dir && filters.dir !== 'all') params.set('dir', filters.dir);
  if (filters.q) params.set('q', filters.q);
  if (filters.before) params.set('before', cursorParam(filters.before));
  const query = params.toString();
  return query ? `/calls?${query}` : '/calls';
}

const DIRECTIONS = [
  { dir: 'all', label: 'All calls' },
  { dir: 'in', label: 'Inbound' },
  { dir: 'out', label: 'Outbound' },
] as const;

export function historyPage(state: HistoryPageState, actor: string): Html {
  const { page, filters, setup, nowSec, timeZone } = state;
  const live = page.items.some((item) => isLiveItem(item, nowSec));
  const number = setup.fromNumber ? formatPhone(setup.fromNumber) : 'your Twilio number';
  return layout(
    'Calls',
    actor,
    html`
      ${setupNote(setup)}
      <div class="row">
        <h1>Calls</h1>
        <p class="muted">
          Every call you made or took, newest first: from a task, an interview or a call back, the calls to ${number}
          (press 1 to take one, or they can leave a voicemail), and calls you logged without dialling from the app.
          The calls still to make are in the <a href="/queue/calls">Queue</a>.
        </p>
      </div>
      <form method="get" action="/calls" class="search">
        ${filters.dir !== 'all' ? html`<input type="hidden" name="dir" value="${filters.dir}" />` : ''}
        <input
          type="search"
          name="q"
          value="${filters.q ?? ''}"
          placeholder="Search names, numbers, summaries, notes and transcripts"
          aria-label="Search calls"
        />
        <button type="submit">Search</button>
      </form>
      <p class="actions">
        ${DIRECTIONS.map(({ dir, label }) =>
          dir === filters.dir
            ? html`<a class="button primary" href="${historyUrl({ dir, q: filters.q })}" aria-current="page">${label}</a>`
            : html`<a class="button" href="${historyUrl({ dir, q: filters.q })}">${label}</a>`
        )}
        ${filters.q ? html`<a href="${historyUrl({ dir: filters.dir })}">Clear search</a>` : ''}
      </p>
      ${
        page.items.length
          ? html`<ol class="calls">${page.items.map((item) => entryCard(entryOf(item, nowSec, state.insights), filters.q, timeZone, state.back))}</ol>`
          : html`<p class="muted">${filters.q ? `No calls mention “${filters.q}”.` : filters.before ? 'No older calls.' : 'No calls yet.'}</p>`
      }
      ${
        page.nextBefore || filters.before
          ? html`<p class="actions">
              ${filters.before ? html`<a class="button" href="${historyUrl({ dir: filters.dir, q: filters.q })}">← Newest</a>` : ''}
              ${page.nextBefore ? html`<a class="button" href="${historyUrl({ ...filters, before: page.nextBefore })}">Older calls →</a>` : ''}
            </p>`
          : ''
      }
    `,
    'calls',
    live ? LIVE_REFRESH_SEC : null
  );
}

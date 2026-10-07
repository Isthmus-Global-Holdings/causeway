// The Calls page (/calls), the record of every call, in and out, newest
// first. The dials (from a CALL task, an interview, or calling
// back someone who rang the Twilio number), the calls to the Twilio number,
// and the calls the rep logged without dialling from the app. Pure: the
// queries are callHistory in lib/db.ts, the page views/history.ts. The calls
// still to make are the Queue's (/queue/calls), with waitingOnCallBack's
// missed calls and voicemails on top.

import type { CallChannel, Dial, DialSubject, InboundCall } from './db';
import type { Speaker, Turn } from './transcript';

export type HistoryDirection = 'all' | 'in' | 'out';

// Where a page of the record ends: the last call's time and its key (see
// historyKey), so calls in the same second are neither skipped nor repeated.
export interface HistoryCursor {
  sec: number;
  key: string;
}

export interface HistoryFilters {
  dir: HistoryDirection;
  q: string | null; // what to search for, or null for every call
  before: HistoryCursor | null; // only calls after this one in the list (the next page)
}

// How many calls a page shows.
export const HISTORY_PAGE = 25;
// How far back a missed call or voicemail can still be waiting on a call back,
// and how many of them show.
export const CALL_BACK_WINDOW_SEC = 14 * 86_400;
export const CALL_BACK_LIMIT = 20;
const MIN_QUERY = 2;
const MAX_QUERY = 100;
// A search that is only a phone number's characters, with at least this many
// digits, also matches the numbers by their digits: "(801) 555" finds +18015550130.
const MIN_NUMBER_DIGITS = 3;

export function historyFilters(query: { dir?: string; q?: string; before?: string }): HistoryFilters {
  const dir = query.dir === 'in' || query.dir === 'out' ? query.dir : 'all';
  const q = (query.q ?? '').trim().slice(0, MAX_QUERY);
  return { dir, q: q.length >= MIN_QUERY ? q : null, before: parseCursor(query.before) };
}

// A cursor in a link: "<seconds>~<key>". Seconds alone pages strictly before
// that second.
export function cursorParam(cursor: HistoryCursor): string {
  return `${cursor.sec}~${cursor.key}`;
}

function parseCursor(param: string | undefined): HistoryCursor | null {
  if (!param) return null;
  const at = param.indexOf('~');
  const sec = Number(at < 0 ? param : param.slice(0, at));
  if (!Number.isInteger(sec) || sec <= 0) return null;
  return { sec, key: at < 0 ? '' : param.slice(at + 1) };
}

// A LIKE pattern matching `q` anywhere, with LIKE's wildcards taken literally
// (the queries say ESCAPE '\').
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// The LIKE pattern for a search that looks like a phone number, or null.
export function numberPattern(q: string): string | null {
  if (!/^[\d\s()+.-]+$/.test(q)) return null;
  const digits = q.replace(/\D/g, '');
  return digits.length >= MIN_NUMBER_DIGITS ? `%${digits}%` : null;
}

// A dial, with the rep's log of it when there is one (a CALL task's call).
export interface HistoryDial extends Dial {
  log_task_id: string | null;
  log_outcome: string | null;
  log_notes: string | null;
}

// A call the rep logged from a CALL task without dialling from the app: one
// made another way, or a WhatsApp call or message.
export interface HandLoggedCall {
  call_task_id: string;
  contact_id: string;
  title: string;
  channel: CallChannel;
  outcome: string;
  notes: string;
  duration_sec: number | null;
  to_number: string | null;
  at_sec: number; // when it was logged
}

export type HistoryItem =
  | { kind: 'dial'; atSec: number; key: string; dial: HistoryDial }
  | { kind: 'inbound'; atSec: number; key: string; call: InboundCall }
  | { kind: 'logged'; atSec: number; key: string; log: HandLoggedCall };

// What orders calls that started in the same second, the same in the queries
// (lib/db.ts callHistory builds it the same way) and here: the kind, then the id.
export const historyKey = {
  dial: (id: string) => `d:${id}`,
  inbound: (id: string) => `i:${id}`,
  logged: (callTaskId: string) => `l:${callTaskId}`,
};

export interface HistoryPage {
  items: HistoryItem[];
  nextBefore: HistoryCursor | null; // the next page's `before`, or null on the last page
}

// Each list is newest first and holds up to limit + 1 rows, so whether there
// is a next page is known without counting.
export function mergeHistory(
  dials: HistoryDial[],
  inbound: InboundCall[],
  logged: HandLoggedCall[],
  limit: number
): HistoryPage {
  const items: HistoryItem[] = [
    ...dials.map((dial) => ({ kind: 'dial' as const, atSec: dial.started_sec, key: historyKey.dial(dial.id), dial })),
    ...inbound.map((call) => ({
      kind: 'inbound' as const,
      atSec: call.started_sec,
      key: historyKey.inbound(call.id),
      call,
    })),
    ...logged.map((log) => ({
      kind: 'logged' as const,
      atSec: log.at_sec,
      key: historyKey.logged(log.call_task_id),
      log,
    })),
  ].sort((a, b) => b.atSec - a.atSec || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, nextBefore: items.length > limit ? { sec: last.atSec, key: last.key } : null };
}

const DIAL_PAGES: Record<DialSubject, string> = { task: 'calls', meeting: 'meetings', inbound: 'inbound' };

// The page a dial belongs to: its CALL task's, interview's or inbound call's.
export function dialPagePath(subject: DialSubject, id: string): string {
  return `/${DIAL_PAGES[subject]}/${encodeURIComponent(id)}`;
}

// --- Why a call matched a search ---

// A piece of text around the search's first hit in it, split so the page can
// mark the hit.
export interface Snippet {
  before: string;
  hit: string;
  after: string;
}

export type SearchMatch =
  | { where: 'summary' | 'notes'; snippet: Snippet }
  | { where: 'transcript'; speaker: Speaker; startSec: number; snippet: Snippet };

// How much text shows on each side of the hit, and how many matches a call shows.
const SNIPPET_SIDE = 60;
const MAX_MATCHES = 3;

export function snippet(text: string, q: string): Snippet | null {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - SNIPPET_SIDE);
  const end = Math.min(text.length, at + q.length + SNIPPET_SIDE);
  return {
    before: `${start > 0 ? '…' : ''}${text.slice(start, at)}`,
    hit: text.slice(at, at + q.length),
    after: `${text.slice(at + q.length, end)}${end < text.length ? '…' : ''}`,
  };
}

// Where the search's words turn up in a call: its summary lines, the rep's
// notes, then what was said. A call found by its name or number has none.
export function searchMatches(
  q: string,
  found: { summary: string[]; notes: string | null; turns: Turn[] }
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const line of found.summary) {
    const s = snippet(line, q);
    if (s) matches.push({ where: 'summary', snippet: s });
  }
  const notes = found.notes ? snippet(found.notes, q) : null;
  if (notes) matches.push({ where: 'notes', snippet: notes });
  for (const turn of found.turns) {
    const s = snippet(turn.text, q);
    if (s) matches.push({ where: 'transcript', speaker: turn.speaker, startSec: turn.start, snippet: s });
  }
  return matches.slice(0, MAX_MATCHES);
}

// Seconds into a recording as a clock: 0:04, 12:30.
export function clock(sec: number): string {
  const whole = Math.floor(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

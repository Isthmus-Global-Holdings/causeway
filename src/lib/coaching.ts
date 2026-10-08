// The patterns across every call the rep logged (lib/call-insight.ts reads
// each one): when people pick up, by hour of their day and by time zone; how
// long calls run by outcome; the front desk, as its own leak; the objections,
// with the openings that got past them; which follow-up gaps led to another
// connect; the rushed connects that left with nothing agreed; and what the
// long connects did differently; and the interviews those calls booked,
// followed to how each turned out (bookingReport). Then, before a call, the
// few of those that bear on it (prepNotes). Pure: the rows come from
// call_insights and allBookedInterviews.

import { zoneLabel } from './address';
import { clock } from './call-history';
import {
  fastNoNextStep,
  GATE_LABELS,
  GATEKEEPER_RESULT_LABELS,
  GATEKEEPER_RESULTS,
  isLongConnect,
  LONG_CONNECT_SEC,
  OBJECTIONS,
  objectionFor,
  STAGE_LABELS,
  COMMITMENTS,
  type CoachNote,
  type Commitment,
  type GatekeeperResult,
  type ObjectionKind,
} from './call-insight';
import { STORY_SEC } from './call-timeline';
import { formatLocal, timeOfDay } from './dates';
import type { BookedInterview, CallInsight } from './db';

// Fewer calls than this in a group is too few to call it a pattern.
export const MIN_SAMPLE = 3;

// The page a read call lives on: its call task's, or the interview's.
export const insightPath = (row: Pick<CallInsight, 'subject' | 'call_task_id'>): string =>
  row.subject === 'meeting' ? `/meetings/${row.call_task_id}` : `/calls/${row.call_task_id}`;

// Comparing reached rates between hours takes far more: about this many calls
// in each hour before a difference between them means anything.
export const HOUR_SAMPLE = 30;

export interface Rate {
  calls: number;
  reached: number; // spoke with the person they called for
}

export const rateOf = (r: Rate): number | null => (r.calls ? r.reached / r.calls : null);

export interface HourRow extends Rate {
  hour: number; // 0–23, in their time zone
}

export interface ZoneRow extends Rate {
  zone: string | null; // IANA; null when their address doesn't say
  label: string;
}

export interface LengthRow {
  outcome: string;
  calls: number;
  avgSec: number;
}

export interface Quote {
  text: string;
  callTaskId: string;
  label: string;
  atSec: number;
}

export interface GatekeeperStats {
  calls: number; // calls the front desk answered
  putThrough: number;
  results: { result: GatekeeperResult; label: string; count: number }[];
  linesThatWorked: Quote[]; // what the rep said when they were put through
  names: { name: string; calls: number; putThrough: number; label: string }[];
}

export interface ObjectionRow {
  kind: ObjectionKind;
  label: string;
  count: number;
  gotPast: number;
  examples: Quote[]; // in their words
  openings: Quote[]; // the rep's openings on the calls that got past it
}

export const GAP_BUCKETS = [
  { key: 'same_day', label: 'Same day', maxSec: 20 * 3600 },
  { key: 'next_day', label: 'Next day', maxSec: 44 * 3600 },
  { key: 'days_2_3', label: '2–3 days', maxSec: 4 * 86_400 },
  { key: 'days_4_7', label: '4–7 days', maxSec: 8 * 86_400 },
  { key: 'later', label: '8 days or more', maxSec: Infinity },
] as const;

export interface FollowUpRow {
  key: (typeof GAP_BUCKETS)[number]['key'];
  label: string;
  afterConnect: Rate; // the next call after they'd been reached: a second connect?
  beforeConnect: Rate; // the next call while they never had been
}

// How the rep talked, from the transcripts.
export interface Style {
  calls: number; // with a transcript
  talkShare: number | null; // the prospect's share of the words
  questions: number | null; // the rep's questions per call
  youFocus: number | null;
}

export interface CoachingReport {
  calls: number; // phone and WhatsApp calls, wrong numbers left out
  reached: number;
  answered: number; // someone picked up: them or the front desk
  byHour: HourRow[];
  byZone: ZoneRow[];
  lengthByOutcome: LengthRow[];
  stages: { stage: string; label: string; count: number }[];
  gatekeeper: GatekeeperStats;
  objections: ObjectionRow[];
  followUps: FollowUpRow[];
  fastNoNextStep: { connects: number; calls: CallInsight[] }; // newest first
  longConnects: CallInsight[]; // longest first
  style: { long: Style; short: Style };
  talk: CallInsight[]; // the latest connects with a transcript (their share of the words), newest first
  theyLed: { calls: number; of: number }; // every connect with a transcript: where they talked more than half
  recent: CallInsight[]; // the last calls read, newest first
  nextStepCalls: ReadonlySet<string>; // the counted calls that agreed a next step
}

const QUOTES = 3;
const RECENT = 12;

function hourOf(call: CallInsight, repTimeZone: string): number {
  return timeOfDay(call.at_sec * 1000, call.contact_tz ?? repTimeZone).hour;
}

function quote(call: CallInsight, text: string | null): Quote[] {
  return text ? [{ text, callTaskId: call.call_task_id, label: call.label, atSec: call.at_sec }] : [];
}

function average(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

function styleOf(calls: CallInsight[]): Style {
  const read = calls.filter((c) => c.source === 'transcript');
  return {
    calls: read.length,
    talkShare: average(read.map((c) => c.prospect_talk_share)),
    questions: average(read.map((c) => c.rep_questions)),
    youFocus: average(read.map((c) => c.you_focus)),
  };
}

// `rows` oldest first, as allCallInsights reads them.
export function coachingReport(rows: CallInsight[], repTimeZone: string): CoachingReport {
  const calls = rows.filter((r) => r.gate !== 'wrong_number');
  const newest = [...calls].reverse();

  const hours = new Map<number, HourRow>();
  const zones = new Map<string, ZoneRow>();
  const lengths = new Map<string, { calls: number; total: number }>();
  const stages = new Map<string, number>();
  for (const call of calls) {
    const hour = hourOf(call, repTimeZone);
    const h = hours.get(hour) ?? { hour, calls: 0, reached: 0 };
    const zoneKey = call.contact_tz ?? '';
    const z = zones.get(zoneKey) ?? {
      zone: call.contact_tz,
      label: call.contact_tz ? zoneLabel(call.contact_tz) : 'Unknown',
      calls: 0,
      reached: 0,
    };
    for (const rate of [h, z]) {
      rate.calls++;
      rate.reached += call.reached;
    }
    hours.set(hour, h);
    zones.set(zoneKey, z);
    if (call.duration_sec !== null) {
      const l = lengths.get(call.outcome) ?? { calls: 0, total: 0 };
      l.calls++;
      l.total += call.duration_sec;
      lengths.set(call.outcome, l);
    }
    stages.set(call.stage, (stages.get(call.stage) ?? 0) + 1);
  }

  // The front desk.
  const desk = calls.filter((c) => c.gate === 'gatekeeper');
  const names = new Map<string, GatekeeperStats['names'][number]>();
  for (const call of desk) {
    if (!call.gatekeeper_name) continue;
    // The same first name at two companies is two people.
    const key = `${call.gatekeeper_name}|${call.company_id ?? call.contact_id}`;
    const n = names.get(key) ?? { name: call.gatekeeper_name, calls: 0, putThrough: 0, label: call.label };
    n.calls++;
    if (call.gatekeeper_result === 'put_through') n.putThrough++;
    names.set(key, n);
  }
  const gatekeeper: GatekeeperStats = {
    calls: desk.length,
    putThrough: desk.filter((c) => c.gatekeeper_result === 'put_through').length,
    results: GATEKEEPER_RESULTS.map((result) => ({
      result,
      label: GATEKEEPER_RESULT_LABELS[result],
      count: desk.filter((c) => c.gatekeeper_result === result).length,
    })).filter((r) => r.count > 0),
    linesThatWorked: [...desk]
      .reverse()
      .filter((c) => c.gatekeeper_result === 'put_through')
      .flatMap((c) => quote(c, c.gatekeeper_line))
      .slice(0, QUOTES),
    names: [...names.values()].sort((a, b) => b.calls - a.calls),
  };

  // Objections, most common first, with the openings that got past them.
  const objections: ObjectionRow[] = OBJECTIONS.map(({ kind, label }) => {
    const raised = newest.filter((c) => c.objection_kind === kind);
    const past = raised.filter((c) => c.got_past_objection);
    return {
      kind,
      label,
      count: raised.length,
      gotPast: past.length,
      examples: raised.flatMap((c) => quote(c, c.objection)).slice(0, QUOTES),
      openings: past.flatMap((c) => quote(c, c.opening)).slice(0, QUOTES),
    };
  })
    .filter((o) => o.count > 0)
    .sort((a, b) => b.count - a.count);

  // Follow-ups: each call after the first to the same person, by the gap
  // since the one before, split by whether they'd been reached yet.
  const followUps: FollowUpRow[] = GAP_BUCKETS.map(({ key, label }) => ({
    key,
    label,
    afterConnect: { calls: 0, reached: 0 },
    beforeConnect: { calls: 0, reached: 0 },
  }));
  const byContact = new Map<string, CallInsight[]>();
  for (const call of calls) byContact.set(call.contact_id, [...(byContact.get(call.contact_id) ?? []), call]);
  for (const series of byContact.values()) {
    let everReached = false;
    for (let i = 0; i < series.length; i++) {
      if (i > 0) {
        const gap = series[i].at_sec - series[i - 1].at_sec;
        const row = followUps[GAP_BUCKETS.findIndex((b) => gap < b.maxSec)];
        const rate = everReached ? row.afterConnect : row.beforeConnect;
        rate.calls++;
        rate.reached += series[i].reached;
      }
      everReached ||= series[i].reached === 1;
    }
  }

  const connects = calls.filter((c) => c.reached);
  const long = connects.filter(isLongConnect);
  const talked = newest.filter((c) => c.reached && c.prospect_talk_share !== null);
  return {
    calls: calls.length,
    reached: connects.length,
    answered: calls.filter((c) => c.gate === 'owner' || c.gate === 'gatekeeper').length,
    byHour: [...hours.values()].sort((a, b) => a.hour - b.hour),
    byZone: [...zones.values()].sort((a, b) => b.calls - a.calls),
    lengthByOutcome: [...lengths.entries()]
      .map(([outcome, l]) => ({ outcome, calls: l.calls, avgSec: Math.round(l.total / l.calls) }))
      .sort((a, b) => b.avgSec - a.avgSec),
    stages: Object.entries(STAGE_LABELS)
      .map(([stage, label]) => ({ stage, label, count: stages.get(stage) ?? 0 }))
      .filter((s) => s.count > 0),
    gatekeeper,
    objections,
    followUps: followUps.filter((f) => f.afterConnect.calls + f.beforeConnect.calls > 0),
    fastNoNextStep: { connects: connects.length, calls: newest.filter(fastNoNextStep) },
    longConnects: [...long].sort((a, b) => (b.talk_sec ?? b.duration_sec ?? 0) - (a.talk_sec ?? a.duration_sec ?? 0)),
    style: { long: styleOf(long), short: styleOf(connects.filter((c) => (c.talk_sec ?? c.duration_sec ?? 0) < 120)) },
    talk: talked.slice(0, RECENT),
    theyLed: { calls: talked.filter((c) => (c.prospect_talk_share ?? 0) > 0.5).length, of: talked.length },
    recent: newest.slice(0, RECENT),
    nextStepCalls: new Set(calls.filter((c) => c.stage === 'next_step').map((c) => c.call_task_id)),
  };
}

// --- The funnel: how far the calls get, step by step ---

// Counts, not rates: honest at any number of calls. Each step is a subset of
// the one before (a booked interview is a next step), except held, which
// waits on the interviews still ahead. Interviews count by call, and only
// on calls that agreed a next step: one booked from a task whose logged call
// agreed none, on a call left out, or a second time on the same call, is no
// step of theirs.
export interface FunnelStep {
  key: 'calls' | 'answered' | 'reached' | 'next_step' | 'booked' | 'held';
  label: string;
  count: number;
}

export interface Funnel {
  steps: FunnelStep[];
  // Booked interviews not counted held or missed yet: still ahead, or past
  // with nothing logged (the bookings card lists those, to log).
  upcoming: number;
  // The step that loses the most calls, among the call's own steps (through
  // booked), when it loses at least 40% of the one before: where to work.
  leak: { from: FunnelStep; to: FunnelStep; advice: string } | null;
}

const LEAK_SHARE = 0.4;

const LEAK_ADVICE: Record<string, string> = {
  answered: 'Most calls aren’t picked up. Try another hour of their day, or their cell.',
  reached:
    'The front desk stops most calls. Ask for them by first name as if they expect you, and if they’re out, ask when to catch them or for their direct line.',
  next_step: 'You reach them, then leave with nothing agreed. Before you hang up, leave with a time.',
  booked: 'Next steps aren’t becoming interviews. Ask for the interview on the call, with a day and time.',
};

export function callFunnel(report: CoachingReport, booked: BookedInterview[], now: number): Funnel {
  const theirs = booked.filter((b) => report.nextStepCalls.has(b.call_task_id));
  const calls = (status?: BookingStatus[]) =>
    new Set(theirs.filter((b) => !status || status.includes(bookingStatus(b, now))).map((b) => b.call_task_id)).size;
  const steps: FunnelStep[] = [
    { key: 'calls', label: 'Calls', count: report.calls },
    { key: 'answered', label: 'Someone picked up', count: report.answered },
    { key: 'reached', label: 'Reached them', count: report.reached },
    {
      key: 'next_step',
      label: 'Next step agreed',
      count: report.stages.find((s) => s.stage === 'next_step')?.count ?? 0,
    },
    { key: 'booked', label: 'Interview booked', count: calls() },
    { key: 'held', label: 'Interview held', count: calls(['held']) },
  ];
  let leak: Funnel['leak'] = null;
  let worst = 0;
  for (let i = 1; i < steps.length - 1; i++) {
    const [from, to] = [steps[i - 1], steps[i]];
    const lost = from.count - Math.min(to.count, from.count);
    if (from.count < MIN_SAMPLE || lost / from.count < LEAK_SHARE || lost <= worst) continue;
    worst = lost;
    leak = { from, to, advice: LEAK_ADVICE[to.key] };
  }
  return { steps, upcoming: calls(['upcoming', 'to_log']), leak };
}

// --- The Mom Test, call by call ---

// How many of the latest calls the Coaching page draws to scale.
export const STRIPS = 20;

export interface MomTestRow {
  call: CallInsight;
  kind: 'call' | 'interview';
}

// Every call and interview that reached them, newest first, with what the
// rules and the reviews have said about each: counts, not rates, and a dash
// where nothing has said yet. The longest story across them.
export interface MomTestReport {
  rows: MomTestRow[];
  asked: number; // asked about a specific last time
  pitched: number;
  stories: number; // a prospect turn of STORY_SEC or more
  fluffCaught: number;
  commitments: Record<Commitment, number>;
  longest: MomTestRow | null;
}

export function momTestReport(calls: CallInsight[], interviews: CallInsight[]): MomTestReport {
  const rows: MomTestRow[] = [
    ...calls.filter((c) => c.reached && c.gate !== 'wrong_number').map((call) => ({ call, kind: 'call' as const })),
    ...interviews.filter((c) => c.reached).map((call) => ({ call, kind: 'interview' as const })),
  ].sort((a, b) => b.call.at_sec - a.call.at_sec);
  const count = (test: (c: CallInsight) => boolean) => rows.filter((r) => test(r.call)).length;
  const commitments = Object.fromEntries(
    COMMITMENTS.map((kind) => [kind, count((c) => c.commitment === kind)])
  ) as Record<Commitment, number>;
  let longest: MomTestRow | null = null;
  for (const row of rows) {
    const sec = row.call.longest_story_sec;
    if (sec !== null && sec >= STORY_SEC && sec > (longest?.call.longest_story_sec ?? 0)) longest = row;
  }
  return {
    rows,
    asked: count((c) => c.asked_last_time === 1),
    pitched: count((c) => c.pitched === 1),
    stories: count((c) => c.longest_story_sec !== null && c.longest_story_sec >= STORY_SEC),
    fluffCaught: count((c) => c.fluff_caught === 1),
    commitments,
    longest,
  };
}

// The hour with the best rate, among those with enough calls to beat
// another (HOUR_SAMPLE), once at least two have: with fewer, there's nothing
// to compare, and no hour is named anywhere.
export function bestHour(rows: HourRow[]): HourRow | null {
  const enough = rows.filter((row) => row.calls >= HOUR_SAMPLE);
  if (enough.length < 2) return null;
  let best: HourRow | null = null;
  for (const row of enough) {
    if (!best || (rateOf(row) ?? 0) > (rateOf(best) ?? 0)) best = row;
  }
  return best && best.reached > 0 ? best : null;
}

// "9 AM", "2 PM".
export function hourLabel(hour: number): string {
  const h = hour % 12 || 12;
  return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
}

export const pct = (share: number | null): string => (share === null ? '–' : `${Math.round(share * 100)}%`);

// --- Interviews booked on calls, followed to how they turned out ---

// A booking ends held, a no-show, or canceled: by them (they told you ahead,
// a reply, unlike a no-show) or by you, which says nothing about them and is
// left out of the held rate. Until then it's ahead, or its time has passed
// and the rep hasn't logged how it went. One moved to a new time is ahead or
// to log at that time.
export type BookingStatus = 'held' | 'no_show' | 'they_canceled' | 'you_canceled' | 'upcoming' | 'to_log';

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  held: 'Held',
  no_show: 'No-show',
  they_canceled: 'They canceled',
  you_canceled: 'You canceled',
  upcoming: 'Ahead',
  to_log: 'To log',
};

export function bookingStatus(
  booking: Pick<BookedInterview, 'outcome' | 'canceled_by' | 'start'>,
  now: number
): BookingStatus {
  if (booking.outcome === 'COMPLETED') return 'held';
  if (booking.outcome === 'NO_SHOW') return 'no_show';
  // Cancels logged before the form asked who were theirs, as far as anyone
  // knows: the rep rarely calls one off.
  if (booking.outcome === 'CANCELED') return booking.canceled_by === 'rep' ? 'you_canceled' : 'they_canceled';
  return Date.parse(booking.start) > now ? 'upcoming' : 'to_log';
}

// Held, a no-show or canceled by them: what it says about them.
const ENDED: BookingStatus[] = ['held', 'no_show', 'they_canceled'];

// The bookings in one group that have ended (held, no-show or canceled by
// them), and how many of those were held.
export interface BookingSplit {
  key: string;
  label: string;
  decided: number;
  held: number;
  noShow: number;
  canceled: number; // by them
}

export const LEAD_BUCKETS = [
  { key: 'soon', label: 'Booked up to 2 days ahead', maxSec: 2 * 86_400 },
  { key: 'week', label: 'Booked 3–7 days ahead', maxSec: 7 * 86_400 },
  { key: 'later', label: 'Booked 8 or more days ahead', maxSec: Infinity },
] as const;

export interface BookingRow {
  booking: BookedInterview;
  status: BookingStatus;
}

export interface BookingReport {
  booked: number;
  held: number;
  noShow: number;
  canceled: number; // by them: a reply
  youCanceled: number;
  upcoming: number;
  toLog: number;
  moved: number; // moved at least once, wherever it ended
  byLeadTime: BookingSplit[]; // how far ahead it was booked
  byInvite: BookingSplit[];
  byCallLength: BookingSplit[]; // how long they talked on the call that booked it
  toLogRows: BookedInterview[]; // past their time with nothing logged, oldest first
  recent: BookingRow[]; // newest booked first
}

// The share of the ended bookings that were held.
export const heldRate = (s: Pick<BookingSplit, 'decided' | 'held'>): number | null =>
  s.decided ? s.held / s.decided : null;

function splitBy(
  rows: BookingRow[],
  groups: readonly { key: string; label: string }[],
  groupOf: (b: BookedInterview) => string | null
): BookingSplit[] {
  return groups
    .map(({ key, label }) => {
      const ended = rows.filter((r) => groupOf(r.booking) === key && ENDED.includes(r.status));
      return {
        key,
        label,
        decided: ended.length,
        held: ended.filter((r) => r.status === 'held').length,
        noShow: ended.filter((r) => r.status === 'no_show').length,
        canceled: ended.filter((r) => r.status === 'they_canceled').length,
      };
    })
    .filter((s) => s.decided > 0);
}

// `bookings` oldest first, as allBookedInterviews reads them.
export function bookingReport(bookings: BookedInterview[], now: number): BookingReport {
  const rows = bookings.map((booking) => ({ booking, status: bookingStatus(booking, now) }));
  const count = (status: BookingStatus) => rows.filter((r) => r.status === status).length;
  const long = clock(LONG_CONNECT_SEC);
  return {
    booked: rows.length,
    held: count('held'),
    noShow: count('no_show'),
    canceled: count('they_canceled'),
    youCanceled: count('you_canceled'),
    upcoming: count('upcoming'),
    toLog: count('to_log'),
    moved: rows.filter((r) => r.booking.moves > 0).length,
    byLeadTime: splitBy(rows, LEAD_BUCKETS, (b) => {
      const ahead = Date.parse(b.first_start) / 1000 - b.booked_sec;
      return Number.isNaN(ahead) ? null : LEAD_BUCKETS.find((l) => ahead < l.maxSec)!.key;
    }),
    byInvite: splitBy(
      rows,
      [
        { key: 'invite', label: 'With a calendar invite' },
        { key: 'none', label: 'No invite' },
      ],
      (b) => (b.invite ? 'invite' : 'none')
    ),
    byCallLength: splitBy(
      rows,
      [
        { key: 'short', label: `Talked under ${long}` },
        { key: 'long', label: `Talked ${long} or more` },
      ],
      (b) => (b.call_sec === null ? null : b.call_sec < LONG_CONNECT_SEC ? 'short' : 'long')
    ),
    toLogRows: rows.filter((r) => r.status === 'to_log').map((r) => r.booking),
    recent: [...rows].reverse().slice(0, RECENT),
  };
}

// --- Before a call ---

export interface PrepInput {
  report: CoachingReport;
  near: CallInsight[]; // the calls to this contact and others at their company, newest first
  contactId: string;
  contactTz: string | null; // from their address
  repTimeZone: string;
  now: number; // epoch ms
  interviews?: BookedInterview[]; // the interviews booked with this contact, oldest first
}

// The facts before a call, for the connector: the last call with them, the
// calls to their company (who answers, the phone menu), and the time.
export interface CallBrief {
  lastCall: CallInsight | null;
  atTheirCompany: {
    calls: number;
    reached: number;
    frontDesk: { name: string; calls: number; putThrough: number }[];
    phoneTree: { digit: string | null; avgSec: number } | null;
  } | null; // null: never called
  timing: {
    hour: number; // now, in their time zone
    zone: string | null; // theirs, when their address says
    thisHour: Rate | null; // how calls at this hour of their day have gone
    best: HourRow | null;
  };
}

export function callBrief(input: PrepInput): CallBrief {
  const { report, near, contactId } = input;
  const hour = timeOfDay(input.now, input.contactTz ?? input.repTimeZone).hour;
  const here = report.byHour.find((h) => h.hour === hour);
  const desk = new Map<string, { name: string; calls: number; putThrough: number }>();
  for (const call of near) {
    if (call.gate !== 'gatekeeper' || !call.gatekeeper_name) continue;
    const d = desk.get(call.gatekeeper_name) ?? { name: call.gatekeeper_name, calls: 0, putThrough: 0 };
    d.calls++;
    if (call.gatekeeper_result === 'put_through') d.putThrough++;
    desk.set(call.gatekeeper_name, d);
  }
  const trees = near.filter((c) => c.phone_tree_sec !== null);
  return {
    lastCall: near.find((c) => c.contact_id === contactId) ?? null,
    atTheirCompany: near.length
      ? {
          calls: near.length,
          reached: near.filter((c) => c.reached).length,
          frontDesk: [...desk.values()].sort((a, b) => b.calls - a.calls),
          phoneTree: trees.length
            ? {
                // The digit for this contact: other contacts' digits are theirs.
                digit: near.find((c) => c.contact_id === contactId && c.phone_tree_digit)?.phone_tree_digit ?? null,
                avgSec: Math.round(trees.reduce((n, c) => n + (c.phone_tree_sec ?? 0), 0) / trees.length),
              }
            : null,
        }
      : null,
    timing: { hour, zone: input.contactTz, thisHour: here ?? null, best: bestHour(report.byHour) },
  };
}

// How the last call with them went, in a few words.
export function describeCall(call: CallInsight): string {
  const talk = call.talk_sec ?? call.duration_sec;
  const length = talk !== null && call.reached ? ` (${clock(talk)})` : '';
  if (call.gate === 'gatekeeper' && !call.reached) {
    const who = call.gatekeeper_name ? `${call.gatekeeper_name} at the front desk` : 'the front desk';
    return `${who}, ${call.gatekeeper_result ? GATEKEEPER_RESULT_LABELS[call.gatekeeper_result] : 'no further'}`;
  }
  if (!call.reached) return GATE_LABELS[call.gate].toLowerCase();
  const parts = [`reached them${length}`];
  const objection = objectionFor(call.objection_kind);
  if (objection) parts.push(call.objection ? `they said “${call.objection}”` : objection.label.toLowerCase());
  parts.push(call.next_step ? `agreed: ${call.next_step_text ?? 'a next step'}` : 'no next step');
  return parts.join('; ');
}

// Their last interview, when it was canceled: by them (a reply, so the line
// is open) or by the rep. A no-show has its own notice on the call page
// (missedInterview), from HubSpot.
export function lastInterviewNote(interviews: BookedInterview[], timeZone: string, now: number): CoachNote | null {
  const last = interviews.at(-1);
  if (!last) return null;
  const when = formatLocal(Date.parse(last.start), timeZone);
  switch (bookingStatus(last, now)) {
    case 'they_canceled':
      return {
        kind: 'tip',
        text: `They canceled the interview for ${when}. They told you rather than not turning up, so the line is open: offer another time.`,
      };
    case 'you_canceled':
      return { kind: 'tip', text: `You canceled the interview for ${when}. Offer another time.` };
    default:
      return null;
  }
}

// The few things that bear on this call: what time it is for them and how
// that hour has gone, how earlier calls to them and their company went (the
// front desk by name), their last interview if it was canceled,
// the objection to expect and an opening that got past it, a habit to watch,
// and what the long connects did.
export function prepNotes(input: PrepInput): CoachNote[] {
  const { report, near, contactId } = input;
  const notes: CoachNote[] = [];
  const zone = input.contactTz ?? input.repTimeZone;

  // When to call.
  const hour = timeOfDay(input.now, zone).hour;
  const here = report.byHour.find((h) => h.hour === hour);
  const best = bestHour(report.byHour);
  const timing = [
    `It’s ${hourLabel(hour)} for them${input.contactTz ? ` (${zoneLabel(input.contactTz)})` : ''}.`,
    here && here.calls >= MIN_SAMPLE
      ? `Calls at this hour have reached the person ${here.reached} of ${here.calls} times.`
      : '',
    best && best.hour !== hour
      ? `Your best hour so far is ${hourLabel(best.hour)} (${best.reached} of ${best.calls}).`
      : '',
  ].filter(Boolean);
  if (timing.length > 1) notes.push({ kind: 'tip', text: timing.join(' ') });

  // This contact, then their company's front desk.
  const theirs = near.filter((c) => c.contact_id === contactId);
  if (theirs.length) {
    const last = theirs[0];
    const reached = theirs.filter((c) => c.reached).length;
    notes.push({
      kind: last.reached && !last.next_step ? 'flag' : 'tip',
      text: `Last call, ${formatLocal(last.at_sec * 1000, input.repTimeZone)}: ${describeCall(last)}.${theirs.length > 1 ? ` ${theirs.length} calls so far, reached ${reached}.` : ''}`,
    });
  }
  const interview = lastInterviewNote(input.interviews ?? [], input.repTimeZone, input.now);
  if (interview) notes.push(interview);
  const desk = near.filter((c) => c.gate === 'gatekeeper');
  const named = desk.find((c) => c.gatekeeper_name);
  if (desk.length) {
    const through = desk.filter((c) => c.gatekeeper_result === 'put_through').length;
    const line = report.gatekeeper.linesThatWorked[0];
    notes.push({
      kind: through ? 'tip' : 'flag',
      text: [
        `${named ? `${named.gatekeeper_name} answers` : 'A front desk answers'} here: ${desk.length} call${desk.length === 1 ? '' : 's'}, put through ${through}.`,
        line
          ? `What got you through a front desk before: “${line.text}”`
          : 'Ask for them by first name as if they expect you; if they’re out, ask when to catch them or for their direct line.',
      ].join(' '),
    });
  }

  // The objection to expect: theirs last time, else the most common.
  const expected = objectionFor(theirs.find((c) => c.objection_kind)?.objection_kind ?? null);
  const row = report.objections.find((o) => o.kind === (expected?.kind ?? report.objections[0]?.kind));
  if (row && row.kind !== 'other' && (expected || row.count >= MIN_SAMPLE - 1)) {
    const opening = row.openings[0];
    const advice = objectionFor(row.kind)?.advice;
    notes.push({
      kind: 'tip',
      text: `${expected ? 'Expect' : 'Most common objection'}: ${row.label} (${row.count}×, got past ${row.gotPast}). ${opening ? `An opening that got past it: “${opening.text}”` : (advice ?? '')}`.trim(),
    });
  }

  // A habit to watch: rushed connects lately that left with nothing agreed.
  const lately = report.recent.filter((c) => c.reached).slice(0, 10);
  const rushed = lately.filter(fastNoNextStep).length;
  if (rushed >= 2) {
    notes.push({
      kind: 'flag',
      text: `${rushed} of your last ${lately.length} connects ended under ${clock(90)} with no next step. If they’re rushed, leave with a time to call back.`,
    });
  }

  // What the long connects did.
  const longest = report.longConnects[0];
  if (longest) {
    const { long, short } = report.style;
    const compare =
      long.talkShare !== null && short.talkShare !== null && long.calls && short.calls
        ? ` On long connects they did ${pct(long.talkShare)} of the talking, against ${pct(short.talkShare)} on short ones: ask about their world.`
        : '';
    notes.push({
      kind: 'bright',
      text: `Best connect: ${longest.label}, ${clock(longest.talk_sec ?? longest.duration_sec ?? 0)}.${longest.what_worked ? ` ${longest.what_worked}` : ''}${compare}`,
    });
  }
  return notes;
}

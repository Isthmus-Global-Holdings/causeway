// Coaching, for the pages and the Claude connector alike: the patterns across
// every call and how the interviews they booked turned out (the Coaching
// page, the call_coaching tool), and the few notes
// on a call page, before it (what's worked on calls like it) and after it
// (what to adjust); and a call's review, by Claude or the rep through the
// connector. Writes only D1: the calls are read for coaching in the
// background (workflows/call-insight.ts), and opening the report reads a
// few that haven't been, after it answers.

import type { Context } from 'hono';
import { stateTimeZone } from '../lib/address';
import { insightDeps, loadAppSettings, type AppSettings } from '../lib/app-settings';
import { afterResponse } from '../lib/background';
import {
  adjustNotes,
  callFacts,
  feedbackBy,
  firstNameOf,
  interviewFacts,
  parseSources,
  parseUnsure,
  ruleInsight,
  rulesSources,
  RULES_VERSION,
  theirPart,
  withReviews,
  type CallFacts,
  type CallReview,
  type CoachNote,
  type Corrections,
  type ReadCall,
  type Reviewer,
  type Tag,
  type TagSources,
} from '../lib/call-insight';
import { callTimeline, parseTimeline, withReviewedTags, type Timeline } from '../lib/call-timeline';
import { heardReport, type HeardReport, type HeardSource } from '../lib/heard';
import {
  bookingReport,
  callBrief,
  callFunnel,
  coachingReport,
  momTestReport,
  prepNotes,
  STRIPS,
  talkReport,
  type BookingReport,
  type CallBrief,
  type CoachingReport,
  type Funnel,
  type MomTestReport,
} from '../lib/coaching';
import {
  allBookedInterviews,
  allCallInsights,
  callInsightsFor,
  callInsightsNear,
  callsToReview,
  d1CallInsightStore,
  d1CallLogStore,
  d1CallReviewStore,
  d1DialStore,
  d1MeetingLogStore,
  heardSources,
  insertAudit,
  type CallInsight,
  type Dial,
} from '../lib/db';
import type { HubSpotObject } from '../lib/hubspot';
import { dialTranscript, type Turn } from '../lib/transcript';
import type { AppEnv } from '../types';
import { excludeCall, readUnreadCalls, reviewCall } from '../workflows/call-insight';
import { DIAL_MAX_SEC, dialState, isLive } from '../workflows/dial';
import { WorkflowError } from '../workflows/parties';

// How many unread calls opening the report reads, after it answers (the cron
// sweep reads the rest): each may ask HubSpot for the contact's state, and
// they all have to fit in the 30 seconds after.
const READ_ON_OPEN = 8;

export interface CoachingOverview {
  settings: AppSettings;
  report: CoachingReport;
  bookings: BookingReport;
  funnel: Funnel;
  interviews: CallInsight[]; // the interviews' calls read, oldest first
  momTest: MomTestReport;
  talk: Pick<CoachingReport, 'talk' | 'theyLed'>; // who did the talking, interviews included
  strips: Strip[]; // the latest calls drawn to scale, newest first
  unread: number; // calls not read yet (up to READ_ON_OPEN + 1)
}

export interface Strip {
  call: CallInsight;
  timeline: Timeline | null; // null until the call is read by rules that draw, or when nothing can be drawn
}

export async function coachingOverview(c: Context<AppEnv>): Promise<CoachingOverview> {
  const deps = insightDeps(c.env);
  const [settings, rows, interviews, booked, unread] = await Promise.all([
    loadAppSettings(c.env),
    allCallInsights(c.env.DB),
    allCallInsights(c.env.DB, 'meeting'),
    allBookedInterviews(c.env.DB),
    deps.insights.needing(READ_ON_OPEN + 1, RULES_VERSION, Math.floor(Date.now() / 1000) - DIAL_MAX_SEC),
  ]);
  if (unread.length) {
    afterResponse(c, 'reading calls for coaching', () => readUnreadCalls(deps, READ_ON_OPEN, Date.now()));
  }
  const now = Date.now();
  const report = coachingReport(rows, settings.timeZone);
  // The drawings of the latest calls, read by id: the report's rows come
  // without them.
  const latest = rows
    .filter((r) => r.gate !== 'wrong_number')
    .slice(-STRIPS)
    .reverse();
  const drawn = await callInsightsFor(
    c.env.DB,
    latest.map((r) => r.call_task_id)
  );
  return {
    settings,
    report,
    bookings: bookingReport(booked, now),
    funnel: callFunnel(report, booked, now),
    interviews,
    momTest: momTestReport(rows, interviews),
    talk: talkReport([...rows, ...interviews].sort((a, b) => b.at_sec - a.at_sec)),
    strips: latest.map((call) => ({ call, timeline: parseTimeline(drawn.get(call.call_task_id)?.timeline_json) })),
    unread: unread.length,
  };
}

// What they've told the rep across every call and interview that reached
// them (the What you've heard page, the what_you_heard tool): their part of
// each transcript and the rep's notes, read by the rules in lib/heard.ts.
export interface HeardOverview {
  settings: AppSettings;
  report: HeardReport;
}

export async function heardOverview(c: Context<AppEnv>): Promise<HeardOverview> {
  const [settings, rows] = await Promise.all([loadAppSettings(c.env), heardSources(c.env.DB)]);
  const sources: HeardSource[] = rows.map((r) => {
    const turns = r.transcript_json ? (JSON.parse(r.transcript_json) as Turn[]) : [];
    return {
      id: r.call_task_id,
      kind: r.subject === 'meeting' ? 'interview' : 'call',
      label: r.label,
      atSec: r.at_sec,
      turns: theirPart(turns, firstNameOf(r.label)).filter((t) => t.speaker === 'prospect'),
      notes: r.notes,
    };
  });
  return { settings, report: heardReport(sources) };
}

// One logged call's reading: its tags, who decided them, and what to adjust.
export interface CallNotes {
  label: string;
  outcome: string; // as the rep logged it
  read: ReadCall;
  unsure: Tag[];
  sources: TagSources;
  notes: CoachNote[];
  feedbackBy: ReturnType<typeof feedbackBy>; // who wrote what worked and what to adjust
  timeline: Timeline | null; // the call drawn to scale, when there's something to draw
}

export interface CallCoaching {
  before: CoachNote[]; // what's worked on calls like this one
  brief: CallBrief | null; // the facts behind those notes
  after: CallNotes | null; // what to adjust after the call just logged
}

// The coaching on a call page: before calling `contact`, and after the call
// logged for `afterTaskId` (the previous call, when the rep just logged it,
// or this task's own once it's done). Never fails the page: coaching is
// left off instead.
export async function callCoaching(
  c: Context<AppEnv>,
  parties: { contact: HubSpotObject; company: HubSpotObject | null },
  afterTaskId: string | null,
  settings: AppSettings,
  now: number
): Promise<CallCoaching> {
  try {
    const { contact, company } = parties;
    const [rows, near, interviews, after] = await Promise.all([
      allCallInsights(c.env.DB),
      callInsightsNear(c.env.DB, contact.id, company?.id ?? null),
      allBookedInterviews(c.env.DB, contact.id),
      afterTaskId ? callNotes(c.env.DB, afterTaskId) : null,
    ]);
    const contactTz =
      stateTimeZone(contact.properties.state, contact.properties.country) ??
      (company ? stateTimeZone(company.properties.state, company.properties.country) : null);
    const input = {
      report: coachingReport(rows, settings.timeZone),
      near,
      contactId: contact.id,
      contactTz,
      repTimeZone: settings.timeZone,
      now,
      interviews,
    };
    return { before: prepNotes(input), brief: callBrief(input), after };
  } catch (err) {
    console.error('coaching for the call page', err);
    return { before: [], brief: null, after: null };
  }
}

// What to adjust after a logged call. Read for coaching when it has been;
// just after logging it usually hasn't yet (that runs in the background), so
// the rules read it now from the outcome, length and notes.
export async function callNotes(db: D1Database, callTaskId: string): Promise<CallNotes | null> {
  const row: CallInsight | null = await d1CallInsightStore(db).get(callTaskId);
  const fresh = row ? null : await freshFacts(db, callTaskId);
  if (!row && !fresh) return null;
  // Its reviews, of this call (an interview dialled again is a new call).
  const reviews: CallReview[] = await d1CallReviewStore(db).list(callTaskId, row ? row.dial_id : fresh!.dialId);
  // A review saved since the row was read (its read failed; the sweep reads
  // it again) may replace one already laid into the row: read from the rules
  // now, below, rather than over what the old review said.
  if (row && !reviews.some((r) => r.reviewed_at > row.extracted_at)) {
    const read = withReviews(row, reviews); // the same reviews again: no change
    return {
      label: row.label,
      outcome: row.outcome,
      read,
      unsure: parseUnsure(read.unsure),
      sources: parseSources(read.sources),
      notes: adjustNotes(read),
      feedbackBy: feedbackBy(reviews),
      timeline: parseTimeline(row.timeline_json),
    };
  }
  const { facts } = fresh ?? (await freshFacts(db, callTaskId))!;
  const reading = ruleInsight(facts);
  const { unsure, marks: _marks, ...fields } = reading;
  // Its reviews too: one saved before the call's reading was (a read that
  // failed after review_call) still stands.
  const read = withReviews(
    {
      ...fields,
      duration_sec: facts.durationSec,
      label: facts.label,
      unsure: JSON.stringify(unsure),
      sources: JSON.stringify(rulesSources()),
    },
    reviews
  );
  return {
    label: facts.label,
    outcome: facts.outcome,
    read,
    unsure: parseUnsure(read.unsure),
    sources: parseSources(read.sources),
    notes: adjustNotes(read),
    feedbackBy: feedbackBy(reviews),
    timeline: ((t) => (t ? withReviewedTags(t, read) : null))(callTimeline(facts, reading)),
  };
}

// The facts of this id's call, for a reading on the spot: the call logged
// for a CALL task, or an interview's call once it ended (with how the rep
// logged the interview, if they have). Null when there's neither.
async function freshFacts(db: D1Database, id: string): Promise<{ facts: CallFacts; dialId: string | null } | null> {
  const log = await d1CallLogStore(db).get(id);
  if (log) {
    if (log.channel === 'whatsapp_message') return null;
    const dial = log.dial_id ? await d1DialStore(db).get(log.dial_id) : null;
    return { facts: callFacts(log, dial, dial ? dialTranscript(dial) : null), dialId: log.dial_id };
  }
  const dial = await d1DialStore(db).latestForTask(id);
  if (dial?.subject !== 'meeting' || isLive(dialState(dial, Math.floor(Date.now() / 1000)))) return null;
  return { facts: interviewFacts(dial, await d1MeetingLogStore(db).latest(id), dialTranscript(dial)), dialId: dial.id };
}

// Calls worth a review (someone picked up, nobody reviewed it yet), newest
// first: the connector's calls_to_review.
export async function callsForReview(c: Context<AppEnv>, limit: number) {
  const [settings, calls] = await Promise.all([loadAppSettings(c.env), callsToReview(c.env.DB, limit)]);
  return { settings, calls };
}

export interface CallForReview {
  settings: AppSettings;
  call: {
    id: string; // the CALL task, or the meeting
    kind: 'call' | 'interview';
    channel: string;
    outcome: string; // the call's as logged, or the interview's (HubSpot's outcome)
    durationSec: number | null;
    notes: string; // the rep's
    nextDue: string | null;
  };
  turns: Turn[]; // the transcript, empty when there's none
  summary: string[]; // the transcript's auto-summary (often wrong about who said what)
  notes: CallNotes; // the reading, reviews laid over it
  reviews: CallReview[];
}

// One logged call, or one interview's call, with everything a review reads:
// the connector's get_call_review.
export async function callForReview(c: Context<AppEnv>, id: string): Promise<CallForReview> {
  const [settings, log] = await Promise.all([loadAppSettings(c.env), d1CallLogStore(c.env.DB).get(id)]);
  if (log?.channel === 'whatsapp_message') throw notACall();
  let dial: Dial | null;
  let call: CallForReview['call'];
  if (log) {
    dial = log.dial_id ? await d1DialStore(c.env.DB).get(log.dial_id) : null;
    call = {
      id,
      kind: 'call',
      channel: log.channel,
      outcome: log.outcome,
      durationSec: log.duration_sec,
      notes: log.notes,
      nextDue: log.next_due,
    };
  } else {
    dial = await d1DialStore(c.env.DB).latestForTask(id);
    if (dial?.subject !== 'meeting') throw notACall();
    const meetingLog = await d1MeetingLogStore(c.env.DB).latest(id);
    call = {
      id,
      kind: 'interview',
      channel: 'phone',
      outcome: meetingLog?.outcome ?? 'SCHEDULED',
      durationSec: dial.prospect_status === 'completed' ? dial.prospect_duration_sec : null,
      notes: meetingLog?.notes ?? '',
      nextDue: meetingLog?.next_due ?? null,
    };
  }
  const transcript = dial ? dialTranscript(dial) : null;
  const [notes, reviews] = await Promise.all([
    callNotes(c.env.DB, id),
    d1CallReviewStore(c.env.DB).list(id, dial?.id ?? null),
  ]);
  if (!notes) throw notACall();
  return { settings, call, turns: transcript?.turns ?? [], summary: transcript?.summary ?? [], notes, reviews };
}

export interface ReviewInput {
  reviewer: Reviewer;
  corrections: Corrections;
  what_worked: string | null;
  adjust: string | null;
  leave_out?: boolean; // a test call: leave it out of coaching (false: put it back)
}

// Saves a review of a logged call and reads it again with it: D1 only, the
// reviewer's earlier review replaced whole. The connector's review_call.
export async function saveCallReview(c: Context<AppEnv>, callTaskId: string, input: ReviewInput): Promise<CallNotes> {
  const deps = insightDeps(c.env);
  const review = {
    reviewer: input.reviewer,
    corrections: input.corrections,
    what_worked: input.what_worked?.trim() || null,
    adjust: input.adjust?.trim() || null,
    reviewed_at: new Date().toISOString(),
  };
  if (!(await reviewCall(deps, callTaskId, review, Date.now()))) throw notACall();
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: 'call',
    taskId: callTaskId,
    action: `review for coaching (${input.reviewer})`,
    outcome: 'success',
  });
  if (input.leave_out !== undefined) await setCallExcluded(c, callTaskId, input.leave_out);
  const notes = await callNotes(c.env.DB, callTaskId);
  if (!notes) throw notACall();
  return notes;
}

const notACall = () =>
  new WorkflowError('That id has no logged call or interview call, so there’s nothing to review.', 404);

// Leaves a call out of coaching (a test call), or puts it back: D1 only.
// The Calls page's button and the connector's review_call.
export async function setCallExcluded(c: Context<AppEnv>, callTaskId: string, excluded: boolean): Promise<void> {
  if (!(await excludeCall(insightDeps(c.env), callTaskId, excluded, Date.now()))) {
    throw new WorkflowError('That call isn’t logged as a call, so coaching has nothing to leave out.', 404);
  }
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: 'call',
    taskId: callTaskId,
    action: excluded ? 'leave out of coaching' : 'put back in coaching',
    outcome: 'success',
  });
}

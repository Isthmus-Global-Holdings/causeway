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
  parseSources,
  parseUnsure,
  ruleInsight,
  rulesSources,
  RULES_VERSION,
  withReviews,
  type CallReview,
  type CoachNote,
  type Corrections,
  type ReadCall,
  type Reviewer,
  type Tag,
  type TagSources,
} from '../lib/call-insight';
import {
  bookingReport,
  callBrief,
  callFunnel,
  coachingReport,
  prepNotes,
  type BookingReport,
  type CallBrief,
  type CoachingReport,
  type Funnel,
} from '../lib/coaching';
import {
  allBookedInterviews,
  allCallInsights,
  callInsightsNear,
  callsToReview,
  d1CallInsightStore,
  d1CallLogStore,
  d1CallReviewStore,
  d1DialStore,
  insertAudit,
  type CallInsight,
  type CallLog,
} from '../lib/db';
import type { HubSpotObject } from '../lib/hubspot';
import { dialTranscript, type Turn } from '../lib/transcript';
import type { AppEnv } from '../types';
import { excludeCall, readUnreadCalls, reviewCall } from '../workflows/call-insight';
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
  unread: number; // logged calls not read yet (up to READ_ON_OPEN + 1)
}

export async function coachingOverview(c: Context<AppEnv>): Promise<CoachingOverview> {
  const deps = insightDeps(c.env);
  const [settings, rows, booked, unread] = await Promise.all([
    loadAppSettings(c.env),
    allCallInsights(c.env.DB),
    allBookedInterviews(c.env.DB),
    deps.insights.needing(READ_ON_OPEN + 1, RULES_VERSION),
  ]);
  if (unread.length) {
    afterResponse(c, 'reading calls for coaching', () => readUnreadCalls(deps, READ_ON_OPEN, Date.now()));
  }
  const now = Date.now();
  const report = coachingReport(rows, settings.timeZone);
  return {
    settings,
    report,
    bookings: bookingReport(booked, now),
    funnel: callFunnel(report, booked, now),
    unread: unread.length,
  };
}

// One logged call's reading: its tags, who decided them, and what to adjust.
export interface CallNotes {
  label: string;
  read: ReadCall;
  unsure: Tag[];
  sources: TagSources;
  notes: CoachNote[];
  feedbackBy: ReturnType<typeof feedbackBy>; // who wrote what worked and what to adjust
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
  const [row, reviews]: [CallInsight | null, CallReview[]] = await Promise.all([
    d1CallInsightStore(db).get(callTaskId),
    d1CallReviewStore(db).list(callTaskId),
  ]);
  if (row) {
    return {
      label: row.label,
      read: row,
      unsure: parseUnsure(row.unsure),
      sources: parseSources(row.sources),
      notes: adjustNotes(row),
      feedbackBy: feedbackBy(reviews),
    };
  }
  const log = await d1CallLogStore(db).get(callTaskId);
  if (!log || log.channel === 'whatsapp_message') return null;
  const dial = log.dial_id ? await d1DialStore(db).get(log.dial_id) : null;
  const facts = callFacts(log, dial, dial ? dialTranscript(dial) : null);
  const { unsure, ...fields } = ruleInsight(facts);
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
    read,
    unsure: parseUnsure(read.unsure),
    sources: parseSources(read.sources),
    notes: adjustNotes(read),
    feedbackBy: feedbackBy(reviews),
  };
}

// Calls worth a review (someone picked up, nobody reviewed it yet), newest
// first: the connector's calls_to_review.
export async function callsForReview(c: Context<AppEnv>, limit: number) {
  const [settings, calls] = await Promise.all([loadAppSettings(c.env), callsToReview(c.env.DB, limit)]);
  return { settings, calls };
}

export interface CallForReview {
  settings: AppSettings;
  log: CallLog;
  turns: Turn[]; // the transcript, empty when there's none
  summary: string[]; // the transcript's auto-summary (often wrong about who said what)
  notes: CallNotes; // the reading, reviews laid over it
  reviews: CallReview[];
}

// One logged call, with everything a review reads: the connector's get_call_review.
export async function callForReview(c: Context<AppEnv>, callTaskId: string): Promise<CallForReview> {
  const [settings, log, reviews] = await Promise.all([
    loadAppSettings(c.env),
    d1CallLogStore(c.env.DB).get(callTaskId),
    d1CallReviewStore(c.env.DB).list(callTaskId),
  ]);
  if (!log || log.channel === 'whatsapp_message') throw notACall();
  const dial = log.dial_id ? await d1DialStore(c.env.DB).get(log.dial_id) : null;
  const transcript = dial ? dialTranscript(dial) : null;
  const notes = await callNotes(c.env.DB, callTaskId);
  if (!notes) throw notACall();
  return { settings, log, turns: transcript?.turns ?? [], summary: transcript?.summary ?? [], notes, reviews };
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

const notACall = () => new WorkflowError('That task has no logged call, so there’s nothing to review.', 404);

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

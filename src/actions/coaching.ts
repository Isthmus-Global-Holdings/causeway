// Coaching, for the pages and the Claude connector alike: the patterns across
// every call and how the interviews they booked turned out (the Coaching
// page, the call_coaching tool), and the few notes
// on a call page, before it (what's worked on calls like it) and after it
// (what to adjust). Only reads: the calls are read for coaching in the
// background (workflows/call-insight.ts), and opening the report reads a
// few that haven't been, after it answers.

import type { Context } from 'hono';
import { stateTimeZone } from '../lib/address';
import { insightDeps, loadAppSettings, type AppSettings } from '../lib/app-settings';
import { afterResponse } from '../lib/background';
import {
  adjustNotes,
  callFacts,
  parseSources,
  parseUnsure,
  ruleInsight,
  rulesSources,
  RULES_VERSION,
  type CoachNote,
  type ReadCall,
  type Tag,
  type TagSources,
} from '../lib/call-insight';
import {
  bookingReport,
  callBrief,
  coachingReport,
  prepNotes,
  type BookingReport,
  type CallBrief,
  type CoachingReport,
} from '../lib/coaching';
import {
  allBookedInterviews,
  allCallInsights,
  callInsightsNear,
  d1CallInsightStore,
  d1CallLogStore,
  d1DialStore,
  insertAudit,
  type CallInsight,
} from '../lib/db';
import type { HubSpotObject } from '../lib/hubspot';
import { dialTranscript } from '../lib/transcript';
import type { AppEnv } from '../types';
import { excludeCall, readUnreadCalls } from '../workflows/call-insight';
import { WorkflowError } from '../workflows/parties';

// How many unread calls opening the report reads, after it answers (the cron
// sweep reads the rest): each may ask HubSpot for the contact's state, and
// they all have to fit in the 30 seconds after.
const READ_ON_OPEN = 8;

export interface CoachingOverview {
  settings: AppSettings;
  report: CoachingReport;
  bookings: BookingReport;
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
  return {
    settings,
    report: coachingReport(rows, settings.timeZone),
    bookings: bookingReport(booked, Date.now()),
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
  if (row) {
    return {
      label: row.label,
      read: row,
      unsure: parseUnsure(row.unsure),
      sources: parseSources(row.sources),
      notes: adjustNotes(row),
    };
  }
  const log = await d1CallLogStore(db).get(callTaskId);
  if (!log || log.channel === 'whatsapp_message') return null;
  const dial = log.dial_id ? await d1DialStore(db).get(log.dial_id) : null;
  const facts = callFacts(log, dial, dial ? dialTranscript(dial) : null);
  const { unsure, ...fields } = ruleInsight(facts);
  const read = { ...fields, duration_sec: facts.durationSec, label: facts.label };
  return {
    label: facts.label,
    read,
    unsure,
    sources: rulesSources(),
    notes: adjustNotes(read),
  };
}

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

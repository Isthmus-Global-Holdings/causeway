// Reads a call for coaching (lib/call-insight.ts) and saves it in
// call_insights: a call logged from a CALL task (readCall), or the call made
// from an interview's page (readInterview, keyed by the meeting). Runs in the
// background, never in front of the rep:
//   - after a call's HubSpot steps finish (actions/calls.ts), from the notes
//     or the transcript if it was already in; after an interview is logged
//     (actions/meetings.ts)
//   - after a transcript finishes for a call already logged, or an
//     interview's call (it's read again, from the transcript this time)
//   - for any call logged before this existed, read by older rules, or that
//     a run missed: the cron sweep (workflows/coaching-sweep.ts), and a few
//     when the Coaching page is opened (readUnreadCalls)
// Only D1 is written, one row per call, replaced whole: running it again is
// always safe, and a call already read from its best source by these rules
// is left alone.

import {
  callFacts,
  insightSource,
  interviewFacts,
  ruleInsight,
  RULES_VERSION,
  rulesSources,
  theirPart,
  transcriptStats,
  withReviews,
  type CallFacts,
  type CallReview,
} from '../lib/call-insight';
import { callTimeline, timelineJson } from '../lib/call-timeline';
import type {
  CallInsight,
  CallInsightStore,
  CallLogStore,
  CallReviewStore,
  Dial,
  DialStore,
  InsightSubject,
  MeetingLogStore,
} from '../lib/db';
import { dialTranscript, type CallTranscript } from '../lib/transcript';
import { dialState, isLive } from './dial';

export interface InsightDeps {
  callLogs: Pick<CallLogStore, 'get' | 'taskForDial'>;
  dials: Pick<DialStore, 'get' | 'latestForTask'>;
  meetingLogs: Pick<MeetingLogStore, 'latest'>;
  insights: CallInsightStore;
  reviews: CallReviewStore;
  // The contact's time zone from their address, or their company's.
  place(contactId: string, companyId: string | null): Promise<string | null>;
}

interface ReadOptions {
  reread?: boolean; // read it anyway, as after a review
}

// What a row is keyed and labelled by, whichever kind of call it reads.
interface ReadKey {
  id: string; // the CALL task, or the meeting
  subject: InsightSubject;
  contactId: string;
  companyId: string | null;
  dial: Dial | null;
  atSec: number | null; // when it was made, if known from the dial; else loggedAt, else now
  outcome: string;
}

// Reads the call logged for this CALL task, unless it was already read from
// everything there is to read by these rules (`reread`: read it anyway, as
// after a review). Its reviews are laid over the rules' reading, so reading
// it again never undoes one. Null for a WhatsApp message (not a call) or a
// task with no logged call.
export async function readCall(
  deps: InsightDeps,
  callTaskId: string,
  now: number,
  opts: ReadOptions = {}
): Promise<CallInsight | null> {
  const log = await deps.callLogs.get(callTaskId);
  if (!log || log.channel === 'whatsapp_message') return null;
  const dial = log.dial_id ? await deps.dials.get(log.dial_id) : null;
  const transcript = dial ? dialTranscript(dial) : null;
  const key: ReadKey = {
    id: callTaskId,
    subject: 'task',
    contactId: log.contact_id,
    companyId: log.company_id,
    dial,
    atSec: dial?.started_sec ?? null,
    outcome: log.outcome,
  };
  return readFacts(deps, key, callFacts(log, dial, transcript), transcript, now, opts);
}

// Reads the latest call made from an interview's page, once it has ended,
// with how the rep logged the interview (its outcome and notes) when they
// have. The same rules, the same row, keyed by the meeting. Null while the
// call is still going, or when none was made from the app.
export async function readInterview(
  deps: InsightDeps,
  meetingId: string,
  now: number,
  opts: ReadOptions = {}
): Promise<CallInsight | null> {
  const dial = await deps.dials.latestForTask(meetingId);
  if (!dial || dial.subject !== 'meeting' || isLive(dialState(dial, Math.floor(now / 1000)))) return null;
  const log = await deps.meetingLogs.latest(meetingId);
  const transcript = dialTranscript(dial);
  const facts = interviewFacts(dial, log, transcript);
  const key: ReadKey = {
    id: meetingId,
    subject: 'meeting',
    contactId: dial.contact_id,
    companyId: log?.company_id ?? null,
    dial,
    atSec: dial.started_sec,
    outcome: facts.outcome,
  };
  return readFacts(deps, key, facts, transcript, now, opts);
}

async function readFacts(
  deps: InsightDeps,
  key: ReadKey,
  facts: CallFacts,
  transcript: CallTranscript | null,
  now: number,
  { reread = false }: ReadOptions
): Promise<CallInsight> {
  const source = insightSource(facts);
  const [before, reviews] = await Promise.all([deps.insights.get(key.id), deps.reviews.list(key.id)]);
  const reviewedSince = reviews.some((r) => before && r.reviewed_at > before.extracted_at);
  if (!reread && before && before.source === source && before.rules_version >= RULES_VERSION && !reviewedSince) {
    return before;
  }

  const reading = ruleInsight(facts);
  const { unsure, marks: _marks, ...fields } = reading;
  const stats = transcript ? transcriptStats(theirPart(transcript.turns, facts.firstName)) : null;
  const contactTz =
    before?.contact_tz ??
    (await deps.place(key.contactId, key.companyId).catch((err: unknown) => {
      console.error('coaching: their time zone', err);
      return null;
    }));
  const row: CallInsight = {
    ...fields,
    call_task_id: key.id,
    subject: key.subject,
    contact_id: key.contactId,
    company_id: key.companyId,
    dial_id: key.dial?.id ?? null,
    label: facts.label,
    at_sec: key.atSec ?? before?.at_sec ?? (await deps.insights.loggedAt(key.id)) ?? Math.floor(now / 1000),
    contact_tz: contactTz,
    outcome: key.outcome,
    duration_sec: facts.durationSec,
    prospect_talk_share: stats?.prospectTalkShare ?? null,
    rep_questions: stats?.repQuestions ?? null,
    you_focus: stats?.youFocus ?? null,
    source,
    rules_version: RULES_VERSION,
    unsure: JSON.stringify(unsure),
    sources: JSON.stringify(rulesSources()),
    timeline_json: timelineJson(callTimeline(facts, reading)),
    excluded: before?.excluded ?? 0,
    extracted_at: new Date(now).toISOString(),
  };
  // A review reads it again, but a stored reading from a better source or
  // newer rules is never replaced (the store refuses): the review goes over
  // that one instead, so what's saved is what's returned.
  const base =
    (reread || reviewedSince) && before && outranks(before, row)
      ? { ...before, extracted_at: new Date(now).toISOString() }
      : row;
  const reviewed = withReviews(base, reviews);
  await deps.insights.save(reviewed);
  // A review saved while this read ran (review_call, mid-sweep) may have had
  // its own read land first, which this save just overwrote: look again,
  // and lay the newer reviews over once more. A review saved after this
  // look has its own read, which lands after.
  const latest = await deps.reviews.list(key.id);
  if (JSON.stringify(latest) === JSON.stringify(reviews)) return reviewed;
  const again = withReviews(base, latest);
  await deps.insights.save(again);
  return again;
}

const SOURCE_RANK: Record<CallInsight['source'], number> = { outcome: 0, notes: 1, transcript: 2 };
const outranks = (a: CallInsight, b: CallInsight) =>
  a.rules_version > b.rules_version ||
  (a.rules_version === b.rules_version && SOURCE_RANK[a.source] > SOURCE_RANK[b.source]);

// Whichever this id is: the call logged for a CALL task, or an interview's call.
async function readEither(deps: InsightDeps, id: string, now: number, opts: ReadOptions = {}) {
  return (await readCall(deps, id, now, opts)) ?? readInterview(deps, id, now, opts);
}

// Saves a review of the call (the reviewer's earlier one replaced whole) and
// reads the call again with it. Null when there's no logged call or ended
// interview call to review.
export async function reviewCall(
  deps: InsightDeps,
  id: string,
  review: CallReview,
  now: number
): Promise<CallInsight | null> {
  const log = await deps.callLogs.get(id);
  if (log ? log.channel === 'whatsapp_message' : !(await readInterview(deps, id, now))) return null;
  await deps.reviews.save(id, review);
  return readEither(deps, id, now, { reread: true });
}

// A dial's transcript is in: read its logged call again, if the rep logged
// one; an interview's call, either way.
export async function readDialCall(deps: InsightDeps, dialId: string, now: number): Promise<CallInsight | null> {
  const dial = await deps.dials.get(dialId);
  if (dial?.subject === 'meeting') return readInterview(deps, dial.task_id, now);
  const taskId = await deps.callLogs.taskForDial(dialId);
  return taskId ? readCall(deps, taskId, now) : null;
}

// Reads up to `limit` calls that need it, newest first, one at a time. How
// many it read.
export async function readUnreadCalls(deps: InsightDeps, limit: number, now: number): Promise<number> {
  let read = 0;
  for (const { id, subject } of await deps.insights.needing(limit, RULES_VERSION)) {
    try {
      const row = subject === 'meeting' ? await readInterview(deps, id, now) : await readCall(deps, id, now);
      if (row) read++;
    } catch (err) {
      console.error(`coaching: reading ${subject === 'meeting' ? 'interview' : 'call'} ${id}`, err);
    }
  }
  return read;
}

// Leaves a call out of coaching (a test call), or puts it back. Read first
// if it hasn't been, so there's a row to mark: from D1 alone, without asking
// HubSpot for their time zone (a later read fills it in). False for a call
// that can't be read (no logged call or interview call, or a WhatsApp
// message).
export async function excludeCall(deps: InsightDeps, id: string, excluded: boolean, now: number): Promise<boolean> {
  if (await deps.insights.setExcluded(id, excluded)) return true;
  if (!(await readEither({ ...deps, place: async () => null }, id, now))) return false;
  return deps.insights.setExcluded(id, excluded);
}

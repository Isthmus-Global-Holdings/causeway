// Reads a logged call for coaching (lib/call-insight.ts) and saves it in
// call_insights. Runs in the background, never in front of the rep:
//   - after a call's HubSpot steps finish (actions/calls.ts), from the notes
//     or the transcript if it was already in
//   - after a transcript finishes for a call already logged (it's read again,
//     from the transcript this time)
//   - for any call logged before this existed, read by older rules, or that
//     a run missed: the cron sweep (workflows/coaching-sweep.ts), and a few
//     when the Coaching page is opened (readUnreadCalls)
// Only D1 is written, one row per call, replaced whole: running it again is
// always safe, and a call already read from its best source by these rules
// is left alone.

import {
  callFacts,
  insightSource,
  ruleInsight,
  RULES_VERSION,
  rulesSources,
  theirPart,
  transcriptStats,
} from '../lib/call-insight';
import type { CallInsight, CallInsightStore, CallLogStore, DialStore } from '../lib/db';
import { dialTranscript } from '../lib/transcript';

export interface InsightDeps {
  callLogs: Pick<CallLogStore, 'get' | 'taskForDial'>;
  dials: Pick<DialStore, 'get'>;
  insights: CallInsightStore;
  // The contact's time zone from their address, or their company's.
  place(contactId: string, companyId: string | null): Promise<string | null>;
}

// Reads the call logged for this CALL task, unless it was already read from
// everything there is to read by these rules. Null for a WhatsApp message
// (not a call) or a task with no logged call.
export async function readCall(deps: InsightDeps, callTaskId: string, now: number): Promise<CallInsight | null> {
  const log = await deps.callLogs.get(callTaskId);
  if (!log || log.channel === 'whatsapp_message') return null;
  const dial = log.dial_id ? await deps.dials.get(log.dial_id) : null;
  const transcript = dial ? dialTranscript(dial) : null;
  const facts = callFacts(log, dial, transcript);
  const source = insightSource(facts);
  const before = await deps.insights.get(callTaskId);
  if (before && before.source === source && before.rules_version >= RULES_VERSION) return before;

  const { unsure, ...fields } = ruleInsight(facts);
  const stats = transcript ? transcriptStats(theirPart(transcript.turns, facts.firstName)) : null;
  const contactTz =
    before?.contact_tz ??
    (await deps.place(log.contact_id, log.company_id).catch((err: unknown) => {
      console.error('coaching: their time zone', err);
      return null;
    }));
  const row: CallInsight = {
    ...fields,
    call_task_id: callTaskId,
    contact_id: log.contact_id,
    company_id: log.company_id,
    dial_id: log.dial_id,
    label: facts.label,
    at_sec: dial?.started_sec ?? before?.at_sec ?? (await deps.insights.loggedAt(callTaskId)) ?? Math.floor(now / 1000),
    contact_tz: contactTz,
    outcome: log.outcome,
    duration_sec: facts.durationSec,
    prospect_talk_share: stats?.prospectTalkShare ?? null,
    rep_questions: stats?.repQuestions ?? null,
    you_focus: stats?.youFocus ?? null,
    source,
    rules_version: RULES_VERSION,
    unsure: JSON.stringify(unsure),
    sources: JSON.stringify(rulesSources()),
    excluded: before?.excluded ?? 0,
    extracted_at: new Date(now).toISOString(),
  };
  await deps.insights.save(row);
  return row;
}

// A dial's transcript is in: read its logged call again, if the rep logged
// one.
export async function readDialCall(deps: InsightDeps, dialId: string, now: number): Promise<CallInsight | null> {
  const taskId = await deps.callLogs.taskForDial(dialId);
  return taskId ? readCall(deps, taskId, now) : null;
}

// Reads up to `limit` calls that need it, newest first, one at a time. How
// many it read.
export async function readUnreadCalls(deps: InsightDeps, limit: number, now: number): Promise<number> {
  let read = 0;
  for (const taskId of await deps.insights.needing(limit, RULES_VERSION)) {
    try {
      if (await readCall(deps, taskId, now)) read++;
    } catch (err) {
      console.error(`coaching: reading call ${taskId}`, err);
    }
  }
  return read;
}

// Leaves a call out of coaching (a test call), or puts it back. Read first
// if it hasn't been, so there's a row to mark: from D1 alone, without asking
// HubSpot for their time zone (a later read fills it in). False for a call
// that can't be read (no logged call, or a WhatsApp message).
export async function excludeCall(
  deps: InsightDeps,
  callTaskId: string,
  excluded: boolean,
  now: number
): Promise<boolean> {
  if (await deps.insights.setExcluded(callTaskId, excluded)) return true;
  if (!(await readCall({ ...deps, place: async () => null }, callTaskId, now))) return false;
  return deps.insights.setExcluded(callTaskId, excluded);
}

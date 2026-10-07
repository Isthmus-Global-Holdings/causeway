// The cron sweep (every 10 minutes, src/worker.ts), so coaching never waits
// on a page being opened:
//   1. transcriptions that died (claimed and never finished, or never
//      started) are run again, the same as the call page's Retry, and the
//      call is read again once its transcript is in
//   2. the logged calls coaching hasn't read, or read by older rules
//      (RULES_VERSION), are read: a back-fill a few at a time
// Both are safe to repeat. A run with nothing to do is two D1 queries.

import { RULES_VERSION } from '../lib/call-insight';
import { readDialCall, readUnreadCalls, type InsightDeps } from './call-insight';
import { runTranscription, TRANSCRIBE_STALE_SEC, type TranscribeDeps, type TranscribeOptions } from './transcribe';

// Per run: each transcription streams a recording through Workers AI, and
// each read may ask HubSpot for the contact's state, within the free plan's
// 50 subrequests a run.
export const SWEEP_TRANSCRIPTS = 2;
export const SWEEP_CALLS = 10;

export interface SweepDeps {
  insight: InsightDeps;
  transcribe: TranscribeDeps | null; // null: Workers AI or Twilio isn't set up
  baseUrl: string;
}

export interface SweepResult {
  transcribed: number;
  read: number;
}

export async function runCoachingSweep(deps: SweepDeps, now: number): Promise<SweepResult> {
  const opts: TranscribeOptions = { now, baseUrl: deps.baseUrl };
  let transcribed = 0;
  const { transcribe } = deps;
  const stale = transcribe
    ? await transcribe.dials.staleTranscripts(Math.floor(now / 1000), TRANSCRIBE_STALE_SEC, SWEEP_TRANSCRIPTS)
    : [];
  for (const dialId of stale) {
    try {
      if ((await runTranscription(transcribe!, dialId, opts)) !== 'done') continue;
      transcribed++;
      await readDialCall(deps.insight, dialId, now);
    } catch (err) {
      console.error(`coaching sweep: transcribing dial ${dialId}`, err);
    }
  }
  const read = await readUnreadCalls(deps.insight, SWEEP_CALLS, now);
  if (transcribed || read)
    console.log(`coaching sweep: ${transcribed} transcribed, ${read} read (rules v${RULES_VERSION})`);
  return { transcribed, read };
}

// A recorded call's transcript and summary, written into the app and onto the
// logged HubSpot call. The same steps serve a dial and an inbound call
// (transcribeRecording; workflows/inbound.ts has the inbound side):
//   1. claim the work on the call (one run at a time; a failed or stuck run
//      can be retried)
//   2. stream the recording from Twilio into Nova-3 (Workers AI), one channel
//      per side, and turn the words into who-said-what
//   3. summarise it with a small Workers AI model, if the rep talked with
//      someone (a summary of only a phone menu or a voicemail greeting comes
//      out made up); a failed summary keeps the transcript
//   4. if the rep already logged the call, rewrite that HubSpot call's notes
//      with the transcript (syncTranscript; syncCallBack for a call back)
// Runs after Twilio reports the recording, and again when the rep clicks Retry.

import { talkedWithSomeone } from '../lib/call-insight';
import type { CallLogStore, Dial, DialStore } from '../lib/db';
import type { HubSpot } from '../lib/hubspot';
import {
  dialTranscript,
  summaryMessages,
  turnsFromNova,
  type NovaResult,
  type Speaker,
  type Turn,
} from '../lib/transcript';
import { syncCallBack } from './call-back';
import { callBodyHtml } from './call-logged';

// Longer than any transcription takes. A claim older than this belongs to a
// run that died, and a retry may take over.
export const TRANSCRIBE_STALE_SEC = 5 * 60;

export interface Transcriber {
  // Nova-3 on the recording, with each channel transcribed separately.
  transcribe(audio: ReadableStream, contentType: string): Promise<NovaResult>;
  summarize(messages: { role: 'system' | 'user'; content: string }[]): Promise<string>;
}

export interface TranscribeDeps {
  dials: DialStore;
  callLogs: CallLogStore;
  hs: HubSpot;
  ai: Transcriber;
  // The recording's audio from Twilio.
  recording(sid: string, channels: number | null): Promise<Response>;
}

export interface TranscribeOptions {
  now: number; // epoch ms
  baseUrl: string;
}

export type TranscribeOutcome = 'done' | 'failed' | 'skipped';

export async function runTranscription(
  deps: TranscribeDeps,
  dialId: string,
  opts: TranscribeOptions
): Promise<TranscribeOutcome> {
  return transcribeRecording(
    { calls: deps.dials, ai: deps.ai, recording: deps.recording },
    dialId,
    opts.now,
    (dial) => ({ speakers: ['rep', 'prospect'], label: dial.contact_label }),
    // A call back logs itself; the other dials are logged by the rep.
    (dial) =>
      dial.subject === 'inbound'
        ? syncCallBack(deps.hs, deps.dials, dial, opts)
        : syncTranscript(deps.hs, deps.callLogs, dial, opts)
  );
}

// The parts of a stored call (a dial or an inbound call) that transcription
// reads and writes.
export interface Recorded {
  recording_sid: string | null;
  recording_channels: number | null;
  transcript_status: 'transcribing' | 'done' | 'failed' | null;
  transcript_json: string | null;
  summary: string | null;
}

export interface RecordedStore<T extends Recorded> {
  get(id: string): Promise<T | null>;
  // True if this caller now owns transcribing the recording.
  beginTranscript(id: string, nowSec: number, staleSec: number): Promise<boolean>;
  saveTranscript(id: string, transcriptJson: string, summary: string | null): Promise<void>;
  failTranscript(id: string, error: string): Promise<void>;
}

export interface RecordingDeps<T extends Recorded> {
  calls: RecordedStore<T>;
  ai: Transcriber;
  recording(sid: string, channels: number | null): Promise<Response>;
}

// Transcribes and summarises one call's recording, then hands the saved call
// to `sync`, which writes it wherever it belongs in HubSpot. `sync` also runs
// when the transcript was already done, in case that write failed before.
// `describe` says who is on which channel, and who the call was with.
export async function transcribeRecording<T extends Recorded>(
  deps: RecordingDeps<T>,
  id: string,
  now: number,
  describe: (call: T) => { speakers: Speaker[]; label: string },
  sync: (call: T) => Promise<unknown>
): Promise<TranscribeOutcome> {
  if (!(await deps.calls.beginTranscript(id, Math.floor(now / 1000), TRANSCRIBE_STALE_SEC))) {
    const done = await deps.calls.get(id);
    if (done?.transcript_status === 'done') await sync(done);
    return 'skipped';
  }
  const call = await deps.calls.get(id);
  if (!call?.recording_sid) return 'skipped';
  const { speakers, label } = describe(call);

  let turns: Turn[];
  try {
    const audio = await deps.recording(call.recording_sid, call.recording_channels);
    if (!audio.ok || !audio.body) throw new Error(`Twilio returned ${audio.status} for the recording`);
    turns = turnsFromNova(await deps.ai.transcribe(audio.body, 'audio/mpeg'), speakers);
  } catch (err) {
    await deps.calls.failTranscript(id, err instanceof Error ? err.message : String(err));
    return 'failed';
  }

  // A recording with only their side (a voicemail left for the rep) is all
  // them, and worth its summary; so is one Nova gave back as one channel,
  // where who said what can't be told (all 'call').
  const whoIsWho = speakers.includes('rep') && turns.some((t) => t.speaker !== 'call');
  let summary: string | null = null;
  if (turns.length && (!whoIsWho || talkedWithSomeone(turns))) {
    try {
      summary = (await deps.ai.summarize(summaryMessages(turns, label))).trim() || null;
    } catch (err) {
      console.error('call summary', err);
    }
  }
  await deps.calls.saveTranscript(id, JSON.stringify(turns), summary);

  // The transcript is saved either way. A HubSpot failure here is retried by
  // the next run, or when the rep opens the call's page.
  const saved = await deps.calls.get(id);
  if (saved) await sync(saved).catch((err) => console.error('transcript sync', err));
  return 'done';
}

// Writes a finished transcript onto the HubSpot call the rep logged for this
// dial, once. Safe to call from both sides: after transcription, and after
// logging (the transcript may have landed in between). Returns true if it
// wrote to HubSpot.
export async function syncTranscript(
  hs: HubSpot,
  callLogs: CallLogStore,
  dial: Dial,
  opts: TranscribeOptions
): Promise<boolean> {
  const transcript = dialTranscript(dial);
  if (!transcript) return false;
  const taskId = await callLogs.taskForDial(dial.id);
  const row = taskId ? await callLogs.get(taskId) : null;
  if (!row?.logged_call_id || row.transcript_synced_at) return false;
  await hs.updateObject('calls', row.logged_call_id, { hs_call_body: callBodyHtml(row, transcript, opts.baseUrl) });
  await callLogs.markTranscriptSynced(row.call_task_id, new Date(opts.now).toISOString());
  return true;
}

export type RecordingState =
  | { kind: 'none' } // not recorded, or nothing to record (they never answered)
  | { kind: 'pending'; message: string } // the page should check again shortly
  | { kind: 'done' }
  | { kind: 'failed'; message: string; canRetry: boolean };

// How long after a recorded call ends Twilio's recording callback may take.
const RECORDING_WAIT_SEC = 10 * 60;
// How long a recording may sit unclaimed before its transcription counts as never started.
const TRANSCRIBE_START_GRACE_SEC = 2 * 60;

// Where a dial's recording and transcript stand, for the call page. Pure.
export function recordingState(dial: Dial, nowSec: number): RecordingState {
  if (!dial.record) return { kind: 'none' };
  if (dial.transcript_status === 'done') return { kind: 'done' };
  if (dial.transcript_status === 'failed') {
    // Retrying needs a recording; one that never started can't be retried.
    const message = dial.transcript_error ?? 'Transcription failed.';
    return { kind: 'failed', message, canRetry: dial.recording_sid !== null };
  }
  if (dial.transcript_status === 'transcribing') {
    const stuck = nowSec - (dial.transcript_started_sec ?? nowSec) > TRANSCRIBE_STALE_SEC;
    return stuck
      ? { kind: 'failed', message: 'Transcription stopped without finishing.', canRetry: true }
      : { kind: 'pending', message: 'Transcribing the call…' };
  }
  // Roughly when the call ended: the rep's leg starts a few seconds before
  // the prospect's, which is close enough for these waits.
  const endedSec = dial.started_sec + (dial.prospect_duration_sec ?? 0);
  if (dial.recording_sid) {
    // Recorded, but no run has claimed it. Give the one Twilio's callback
    // started a moment; after that it died, and the rep can start it again.
    return nowSec - endedSec < TRANSCRIBE_START_GRACE_SEC
      ? { kind: 'pending', message: 'Transcribing the call…' }
      : { kind: 'failed', message: 'The recording is in, but transcription never started.', canRetry: true };
  }
  if (dial.prospect_status !== 'completed') return { kind: 'none' };
  return nowSec - endedSec < RECORDING_WAIT_SEC
    ? { kind: 'pending', message: 'Waiting for the recording from Twilio…' }
    : { kind: 'failed', message: 'Twilio never sent the recording for this call.', canRetry: false };
}

// Turning a two-channel call recording's transcript into who-said-what.
// Twilio's dual-channel recording puts the recorded leg on channel 0 and the
// other party on channel 1: the rep then the prospect on a call the rep
// dialled, the caller then the rep on a call to the Twilio number. Nova-3 transcribes each channel on
// its own with word timings, so interleaving the words by start time and
// grouping runs of the same speaker gives the conversation in order.

import type { Dial } from './db';
import { escapeHtml } from './richtext';

export type Speaker = 'rep' | 'prospect' | 'call';

export interface Turn {
  speaker: Speaker;
  start: number; // seconds into the recording
  text: string;
}

// The part of Nova-3's response this uses.
export interface NovaResult {
  results?: {
    channels?: {
      alternatives?: {
        transcript?: string;
        // `word` is lowercase and bare; `punctuated_word` (with `punctuate`)
        // is the same word as written, with its capital and punctuation.
        words?: { word: string; punctuated_word?: string; start: number; end: number }[];
      }[];
    }[];
  };
}

export const SPEAKER_LABELS: Record<Speaker, string> = { rep: 'You', prospect: 'Prospect', call: 'Call' };

// A pause this long starts a new turn even when the same person keeps talking.
const TURN_GAP_SEC = 4;

// `speakers` names each channel in order. A recording with a different
// number of channels than that (a one-channel fallback) is all 'call'.
export function turnsFromNova(result: NovaResult, speakers: Speaker[] = ['rep', 'prospect']): Turn[] {
  const channels = result.results?.channels ?? [];
  const speakerOf = (i: number): Speaker => (channels.length === speakers.length ? speakers[i] : 'call');

  const words = channels.flatMap((channel, i) =>
    (channel.alternatives?.[0]?.words ?? []).map((w) => ({ ...w, speaker: speakerOf(i) }))
  );
  words.sort((a, b) => a.start - b.start);

  const turns: (Turn & { end: number })[] = [];
  for (const w of words) {
    const word = w.punctuated_word || w.word;
    const last = turns[turns.length - 1];
    if (last && last.speaker === w.speaker && w.start - last.end < TURN_GAP_SEC) {
      last.text += ` ${word}`;
      last.end = w.end;
    } else {
      turns.push({ speaker: w.speaker, start: w.start, end: w.end, text: word });
    }
  }
  return turns.map(({ speaker, start, text }) => ({ speaker, start, text }));
}

export function transcriptText(turns: Turn[]): string {
  return turns.map((t) => `${SPEAKER_LABELS[t.speaker]}: ${t.text}`).join('\n');
}

// A call body in HubSpot is capped at 65,536 characters. Leave room for the
// notes and summary around the transcript.
const MAX_TRANSCRIPT_HTML = 50_000;

export function transcriptHtml(turns: Turn[]): string {
  let out = '';
  for (const t of turns) {
    const line = `<p><strong>${SPEAKER_LABELS[t.speaker]}:</strong> ${escapeHtml(t.text)}</p>`;
    if (out.length + line.length > MAX_TRANSCRIPT_HTML) {
      return `${out}<p><em>Transcript cut short here: the rest is in the app.</em></p>`;
    }
    out += line;
  }
  return out;
}

// The summary model answers in free text; keep up to five bullet lines.
export function summaryLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

// About an hour of talk. Past that, the summary covers the start of the call.
const MAX_SUMMARY_INPUT = 40_000;

export function summaryMessages(turns: Turn[], contactLabel: string): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content:
        'You summarise sales calls for a CRM. Reply with 3 or 4 short bullet lines starting with "- ": ' +
        'what the prospect said about their situation, any objection or interest, and the agreed next step. ' +
        'Only state what the transcript says. No preamble.',
    },
    { role: 'user', content: `Call with ${contactLabel}.\n\n${transcriptText(turns).slice(0, MAX_SUMMARY_INPUT)}` },
  ];
}

export interface CallTranscript {
  turns: Turn[];
  summary: string[]; // bullet lines; empty if the summary failed
}

// The finished transcript stored on a dial, or null if there isn't one yet.
export function dialTranscript(
  dial: Pick<Dial, 'transcript_status' | 'transcript_json' | 'summary'>
): CallTranscript | null {
  if (dial.transcript_status !== 'done' || !dial.transcript_json) return null;
  return { turns: JSON.parse(dial.transcript_json) as Turn[], summary: summaryLines(dial.summary ?? '') };
}

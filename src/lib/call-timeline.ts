// A call drawn to scale: its phases (the phone menu, the front desk, the
// hold, them), who spoke when, and the moments worth looking at (the opening,
// the objection, the next step). Built once when the call is read for
// coaching (workflows/call-insight.ts) from the transcript's turns and where
// the rules found each thing (TurnMarks), stored as JSON on call_insights,
// and drawn by views/timeline.ts. One row per call, no rates: the shape of
// the call is the coaching. No I/O.

import { clock } from './call-history';
import type { CallFacts, RuleReading } from './call-insight';
import { turnEnd, turnSpan, type Turn } from './transcript';

export type PhaseKind = 'menu' | 'desk' | 'hold' | 'them' | 'voicemail' | 'call';
export type MarkKind = 'opening' | 'objection' | 'next_step';

export interface Phase {
  kind: PhaseKind;
  from: number; // seconds into the call
  to: number;
  label: string | null; // the front desk's name
}

export interface Tick {
  who: 'rep' | 'prospect';
  from: number;
  to: number;
  story?: true; // theirs, once they came on, STORY_SEC or longer
}

export interface Mark {
  kind: MarkKind;
  at: number;
  text: string | null;
}

export interface Timeline {
  totalSec: number;
  phases: Phase[]; // contiguous, from 0 to totalSec
  turns: Tick[]; // 'call' turns (a one-channel recording) draw nothing
  marks: Mark[];
  longestStorySec: number | null; // their longest turn once they came on; null until they did
}

// A prospect turn this long is a story: what discovery calls are for.
export const STORY_SEC = 60;

const MARK_TEXT = 80;

type Reading = Pick<RuleReading, 'marks' | 'gate' | 'gatekeeper_name' | 'reached' | 'objection' | 'next_step_text'>;

// The call drawn from its transcript. Without one, a single segment as long
// as the call (so it still compares with the others); without a length
// either, nothing to draw.
export function callTimeline(facts: CallFacts, reading: Reading): Timeline | null {
  const turns: Turn[] = facts.transcript?.turns ?? [];
  if (!turns.length) {
    if (facts.durationSec === null) return null;
    const kind: PhaseKind = reading.gate === 'voicemail' ? 'voicemail' : 'call';
    return {
      totalSec: facts.durationSec,
      phases: [{ kind, from: 0, to: facts.durationSec, label: null }],
      turns: [],
      marks: [],
      longestStorySec: null,
    };
  }
  const last = turnEnd(turns, turns.length - 1, facts.durationSec);
  const totalSec = Math.max(facts.durationSec ?? 0, last);
  const m = reading.marks;
  const startOf = (i: number | null) => (i !== null && i >= 0 && i < turns.length ? turns[i].start : null);

  // The phases, from whoever answered through each change of hands.
  const phases: Phase[] = [];
  let cursor = 0;
  const push = (kind: PhaseKind, to: number, label: string | null = null) => {
    if (to > cursor) phases.push({ kind, from: cursor, to, label });
    cursor = Math.max(cursor, to);
  };
  if (m.menuEnd !== null) push('menu', m.menuEnd < turns.length ? turns[m.menuEnd].start : totalSec);
  let kind: PhaseKind = reading.gate === 'gatekeeper' ? 'desk' : reading.gate === 'voicemail' ? 'voicemail' : 'them';
  const changes = (
    [
      ['hold', startOf(m.holdFrom)],
      ['desk', startOf(m.deskBackAt)], // back from the hold with an answer
      ['them', reading.reached ? startOf(m.ownerFrom) : null],
      ['voicemail', startOf(m.voicemailFrom)],
    ] as [PhaseKind, number | null][]
  )
    .filter((c): c is [PhaseKind, number] => c[1] !== null)
    .sort((a, b) => a[1] - b[1]);
  for (const [next, at] of changes) {
    if (next === kind) continue; // they answered themselves: no change of hands
    push(kind, at, kind === 'desk' ? reading.gatekeeper_name : null);
    kind = next;
  }
  push(kind, totalSec, kind === 'desk' ? reading.gatekeeper_name : null);

  // Who spoke when. Their turns once they came on can be stories.
  const ownerFrom = reading.reached ? m.ownerFrom : null;
  let longestStorySec: number | null = ownerFrom === null ? null : 0;
  const ticks: Tick[] = [];
  turns.forEach((t, i) => {
    if (t.speaker === 'call') return;
    const { from, to } = turnSpan(turns, i, totalSec);
    const tick: Tick = { who: t.speaker, from, to };
    if (t.speaker === 'prospect' && ownerFrom !== null && i >= ownerFrom) {
      const sec = Math.round(to - from);
      if (sec >= STORY_SEC) tick.story = true;
      if (longestStorySec === null || sec > longestStorySec) longestStorySec = sec;
    }
    ticks.push(tick);
  });

  const marks: Mark[] = [];
  const mark = (kind: MarkKind, i: number | null, text: string | null) => {
    const at = startOf(i);
    if (at !== null) marks.push({ kind, at, text: text ? text.slice(0, MARK_TEXT) : null });
  };
  mark('opening', m.openingAt, m.openingAt !== null ? turns[m.openingAt].text : null);
  mark('objection', m.objectionAt, reading.objection);
  mark('next_step', m.nextStepAt, reading.next_step_text);

  return { totalSec, phases, turns: ticks, marks, longestStorySec };
}

export const timelineJson = (t: Timeline | null): string | null => (t ? JSON.stringify(t) : null);

// call_insights keeps the timeline as JSON; a damaged value reads as none.
export function parseTimeline(json: string | null | undefined): Timeline | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object') return null;
    const t = value as Partial<Timeline>;
    return typeof t.totalSec === 'number' && Array.isArray(t.phases) && Array.isArray(t.turns) && Array.isArray(t.marks)
      ? (t as Timeline)
      : null;
  } catch {
    return null;
  }
}

// The strip in words, for whoever can't see it: each phase with its times,
// the objection and the next step, their longest story, the length.
// `outcome` names a call drawn without a transcript.
export function timelineText(t: Timeline, outcome: string | null = null): string {
  const parts: string[] = [];
  t.phases.forEach((p, i) => {
    const lastPhase = i === t.phases.length - 1;
    switch (p.kind) {
      case 'menu':
        parts.push(`Phone menu ${clock(Math.round(p.to - p.from))}`);
        break;
      case 'desk':
        parts.push(
          `Front desk${p.label ? ` (${p.label})` : ''} ${clock(Math.round(p.from))}–${clock(Math.round(p.to))}`
        );
        break;
      case 'hold':
        parts.push(
          `On hold from ${clock(Math.round(p.from))}${lastPhase ? ', they never came on' : ` to ${clock(Math.round(p.to))}`}`
        );
        break;
      case 'them':
        parts.push(`Them from ${clock(Math.round(p.from))}`);
        break;
      case 'voicemail':
        parts.push(`Voicemail from ${clock(Math.round(p.from))}`);
        break;
      case 'call':
        parts.push(outcome ?? 'The call');
        break;
    }
  });
  for (const m of t.marks) {
    if (m.kind === 'objection') parts.push(`Objection at ${clock(Math.round(m.at))}`);
    if (m.kind === 'next_step') parts.push(`Next step at ${clock(Math.round(m.at))}`);
  }
  if (t.longestStorySec !== null && t.longestStorySec >= STORY_SEC) {
    parts.push(`Their longest story ${clock(t.longestStorySec)}`);
  }
  parts.push(`${clock(Math.round(t.totalSec))} in all`);
  return parts.join(' · ');
}

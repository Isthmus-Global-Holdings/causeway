// Companies carry a fit assessment inside their free-text `description`, as a
// line like "Fit: STRONG - small, family-owned, owner-run asset carrier".
// This turns it into a label for ranking the EMAIL task queue and the calls
// due.
//
// Formats seen in the account (Sept 2026), all covered in test/fit.test.ts:
//   Fit: STRONG - …        Fit: GOOD - …          Fit: moderate - …
//   Fit: WEAK-MODERATE - … Fit: borderline - …
//   Fit: mid-size, diversified, …  (no rating word, just a description)
//   Drop flags: Fit: POOR - …, NOT A FIT - …, Recommend: drop, Likely drop, Probably drop

export type FitLabel = 'STRONG' | 'GOOD' | 'WEAK' | 'UNKNOWN' | 'DROP';

// Anything flagged as a likely drop ranks last, whatever else the description
// says. Per the hubspot-email-sent-followup skill that covers "out of
// business", "not a fit" and "poor fit" as well as an explicit drop. Plain
// "drop" isn't enough ("a drop in revenue"), so it has to be phrased as a
// recommendation or written as an uppercase flag.
const DROP_FLAGS = [
  /\bDROP\b/,
  /\bDISQUALIFIED\b/,
  /\bdo not (?:contact|pursue)\b/i,
  /\b(?:recommend(?:ation|ed)?\s*:?\s*|likely\s+|probably\s+)drop\b/i,
  /\bout of business\b/i,
  /\bnot\s+an?\s+(?:[a-z]+\s+)?fit\b/i, // "NOT A FIT", "not a good fit"
  /\bfit(?:\s+label)?\s*[:=\-–—]\s*poor\b/i, // "Fit: POOR"
  /\bpoor\s+fit\b/i,
];

// The first word after "Fit:". Only STRONG and GOOD rank above the rest:
// every other rating (moderate, borderline, WEAK-MODERATE) and every
// description without a rating word (mid-size, niche/partial) is weaker.
// POOR never gets here; it's a drop flag above.
const FIT_LINE = /\bfit(?:\s+label)?\s*[:=\-–—]\s*([a-z]+)/i;

// Prose without a Fit line: "a strong fit", "GOOD fit".
const PROSE_LABEL = /\b(strong|good)\s+fit\b/i;

export function parseFitLabel(raw: string | null | undefined): FitLabel {
  // The call script's lines are words to say to them ("rates probably drop
  // between quote and tender"), not an assessment, so they never rate a company.
  const description = withoutCallLines(raw ?? '');
  if (!description) return 'UNKNOWN';
  if (DROP_FLAGS.some((re) => re.test(description))) return 'DROP';

  const rating = FIT_LINE.exec(description)?.[1].toLowerCase();
  if (rating) {
    if (rating === 'strong' || rating === 'excellent') return 'STRONG';
    if (rating === 'good') return 'GOOD';
    return 'WEAK';
  }

  const prose = PROSE_LABEL.exec(description)?.[1].toLowerCase();
  if (prose === 'strong') return 'STRONG';
  if (prose === 'good') return 'GOOD';
  return 'UNKNOWN';
}

// Two more lines written for the call script, after the Fit line:
//   World: how freight forwarders handle quoting and shipments.
//   Pedestal: you run both ocean and air out of Miami, so no two quotes look alike.
// World is the Vision in their industry's words, said after "I'm
// researching". Pedestal is why them, one spoken clause to them, said after
// "I'm calling you because". The Fit line's reasoning is written to rank a
// prospect, so it isn't read out. Each value runs to the end of its line, or
// to the next labelled sentence when the research is one paragraph, without
// its final period. Nothing when the line is missing or empty, so the
// placeholder shows the gap.
export interface CallLines {
  theirWorld: string | null;
  pedestal: string | null;
}

const LABELS = 'fit(?:\\s+label)?|world|pedestal';

// A label's line: what's before it (the start, a newline, or the end of the
// sentence before it), then its value up to the end of its line or the next
// labelled sentence.
function lineOf(label: string, flags: string): RegExp {
  return new RegExp(
    `(^|\\n|[.!?](?=\\s))\\s*${label}\\s*:[ \\t]*(.*?)(?:[.!?](?=\\s+(?:${LABELS})\\s*:)|(?=\\n|$))`,
    flags
  );
}

// Without the final period or wrapping quotes, so it reads mid-sentence.
function spoken(value: string): string {
  return value
    .trim()
    .replace(/^["“'‘](.*)["”'’]\.?$/, '$1')
    .replace(/[.\s]+$/, '')
    .trim();
}

function labelled(description: string, label: string): string | null {
  const value = lineOf(label, 'i').exec(description)?.[2];
  return value === undefined ? null : spoken(value) || null;
}

export function parseCallLines(description: string | null | undefined): CallLines {
  if (!description) return { theirWorld: null, pedestal: null };
  return { theirWorld: labelled(description, 'world'), pedestal: labelled(description, 'pedestal') };
}

// What save_call_lines checks before writing a line: one line, short enough
// to say in one breath, in the rep's voice (no em-dashes or semicolons), and
// without another label in it. The Pedestal aims for under 20 words.
export const CALL_LINE_WORDS = { theirWorld: 15, pedestal: 25 } as const;

export function checkCallLine(kind: keyof CallLines, raw: string): { value: string } | { problem: string } {
  const name = kind === 'theirWorld' ? 'World' : 'Pedestal';
  const value = spoken(raw);
  if (!value) return { problem: `${name} is empty.` };
  // Every line break a regex's `.` stops at, or the saved line couldn't be read back.
  if (/[\r\n\u2028\u2029]/.test(value)) return { problem: `${name} has to be one line.` };
  if (/[—;]/.test(value)) return { problem: `${name}: no em-dashes or semicolons. Use a comma instead.` };
  if (new RegExp(`(?:^|\\s)(?:${LABELS})\\s*:`, 'i').test(value)) {
    return { problem: `${name} can't hold another label (Fit:, World:, Pedestal:).` };
  }
  const words = value.split(/\s+/).length;
  if (words > CALL_LINE_WORDS[kind]) {
    return { problem: `${name} is ${words} words. Keep it to ${CALL_LINE_WORDS[kind]} or fewer, said in one breath.` };
  }
  return { value };
}

// The description without its World and Pedestal lines. A line of its own
// goes with its newline; a sentence leaves the period that ended the one
// before it.
// Repeated until nothing changes: a match takes the period that ends it,
// which the next sentence of the same label needs in front of it.
function withoutCallLines(description: string): string {
  let rest = description;
  for (let was = ''; was !== rest;) {
    was = rest;
    for (const label of ['world', 'pedestal']) {
      rest = rest.replace(lineOf(label, 'gi'), (_m, before: string) => (before === '\n' ? '' : before));
    }
  }
  return rest.trim();
}

// The description with these lines in place of any it had, each on a line of
// its own at the end (after the Fit line); a null one is left out. Both are
// always given, so two saves that overlap can't each keep half of the other:
// the last one written is the whole of what's there. Everything else stays
// as written.
export function withCallLines(description: string | null | undefined, lines: CallLines): string {
  const rest = withoutCallLines(description ?? '');
  const added = [
    lines.theirWorld && `World: ${lines.theirWorld}.`,
    lines.pedestal && `Pedestal: ${lines.pedestal}.`,
  ].filter(Boolean);
  return [rest.trim(), ...added].filter(Boolean).join('\n');
}

export const FIT_RANK: Record<FitLabel, number> = { STRONG: 0, GOOD: 1, WEAK: 2, UNKNOWN: 3, DROP: 4 };

export interface Rankable {
  fit: FitLabel;
  createdAt: string | null; // ISO timestamp; older tasks win ties
}

export function rankByFit<T extends Rankable>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const byFit = FIT_RANK[a.fit] - FIT_RANK[b.fit];
    if (byFit !== 0) return byFit;
    return (a.createdAt ?? '9999').localeCompare(b.createdAt ?? '9999');
  });
}

export interface NextUp<T> {
  item: T;
  // 'draft': it still needs an email written. 'send': everything worth
  // drafting is drafted, so this is the best one to send next.
  step: 'draft' | 'send';
}

// The task to offer the rep next, never a drop-flagged one: the best-ranked
// task still needing a draft, or once all are drafted, the best one to send.
export function pickNextUp<T extends Rankable & { hasDraft: boolean }>(ranked: T[]): NextUp<T> | null {
  const candidates = ranked.filter((item) => item.fit !== 'DROP');
  const toDraft = candidates.find((item) => !item.hasDraft);
  if (toDraft) return { item: toDraft, step: 'draft' };
  return candidates.length ? { item: candidates[0], step: 'send' } : null;
}

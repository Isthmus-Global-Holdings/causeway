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

export function parseFitLabel(description: string | null | undefined): FitLabel {
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

// The reason after the rating, for the call script's {fit_reason}: "Fit:
// STRONG - runs the full quote-to-invoice workflow." gives "runs the full
// quote-to-invoice workflow". A Fit line without a rating word ("Fit:
// mid-size family carrier") is all reason. Nothing for a drop-flagged
// company, one with no Fit line, or a bare rating ("Fit: STRONG", one word),
// so the placeholder shows the gap.
const FIT_REASON_LINE = /\bfit(?:\s+label)?\s*:\s*([^\n]+)/i;
const RATING_HEAD = /^[a-z][a-z/-]*\s+[-–—](?:\s+|$)/i;

export function parseFitReason(description: string | null | undefined): string | null {
  if (!description || parseFitLabel(description) === 'DROP') return null;
  const line = FIT_REASON_LINE.exec(description)?.[1];
  if (!line) return null;
  const rated = RATING_HEAD.test(line);
  const reason = line.replace(RATING_HEAD, '').trim().replace(/\.+$/, '').trim();
  // Without a rating in front, a single word is the rating itself.
  if (!reason || (!rated && !/\s/.test(reason))) return null;
  return reason;
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

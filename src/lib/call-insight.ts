// What happened on one call, for coaching (lib/coaching.ts): the phone tree,
// who answered (them, the front desk, voicemail) and what the front desk did,
// how far it got, the objection they raised, and whether a next step was
// agreed. Read by rules from the call's transcript, turn by turn, else from
// the rep's notes, else from the logged outcome and length. Never from the
// auto-summary: it's often wrong about who said what. Each reading says which
// of its tags the rules only guessed at (`unsure`). Pure:
// workflows/call-insight.ts reads and saves.

import { clock } from './call-history';
import { parseTimeline, timelineJson, withReviewedTags } from './call-timeline';
import type { CallChannel, CallLog, Dial, MeetingLog } from './db';
import { turnSpan, type CallTranscript, type Turn } from './transcript';

// Bump it when the rules change: every call is read again (for free, by the
// cron sweep), and nothing read by older rules is left.
export const RULES_VERSION = 5;

// The review rules' version (prompts/call-review.ts, review_call's tags):
// bump it when a review can answer something it couldn't before, and every
// call reviewed under older rules comes back to calls_to_review for it.
// 1: the Mom Test (asked about the last time, pitched, their longest story,
// fluff caught, what they committed).
export const REVIEW_RULES_VERSION = 1;

// Who answered.
export const GATES = ['owner', 'gatekeeper', 'voicemail', 'no_answer', 'wrong_number'] as const;
export type Gate = (typeof GATES)[number];
export const GATE_LABELS: Record<Gate, string> = {
  owner: 'Them',
  gatekeeper: 'Front desk',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  wrong_number: 'Wrong number',
};

// What the front desk did with the call.
export const GATEKEEPER_RESULTS = [
  'put_through',
  'sent_to_voicemail',
  'not_available',
  'on_hold_no_pickup',
  'took_message',
  'refused',
] as const;
export type GatekeeperResult = (typeof GATEKEEPER_RESULTS)[number];
export const GATEKEEPER_RESULT_LABELS: Record<GatekeeperResult, string> = {
  put_through: 'put you through',
  sent_to_voicemail: 'sent you to voicemail',
  not_available: '“not available”',
  on_hold_no_pickup: 'put you on hold, and they never came on',
  took_message: 'took a message',
  refused: 'turned you away',
};

// How far a call got, in order: each stage is past the ones before it.
export const STAGES = ['no_connect', 'voicemail', 'gatekeeper', 'opening', 'conversation', 'next_step'] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  no_connect: 'No one answered',
  voicemail: 'Voicemail',
  gatekeeper: 'Front desk',
  opening: 'Opening only',
  conversation: 'Conversation',
  next_step: 'Next step agreed',
};
export const stageRank = (stage: Stage): number => STAGES.indexOf(stage);

// The objections on a discovery call, the first that matches winning, and
// what to try next time. Matched on what the person they called said (or
// the rep's notes about them), never on the front desk or the rep.
export const OBJECTIONS = [
  {
    kind: 'sales_call',
    label: 'Is this a sales call?',
    pattern: /\b(sales call|selling (me )?something|what are you selling|solicit\w*|telemarket\w*)\b/i,
    advice: 'Say plainly what the call is, then ask about their world, not yours.',
  },
  {
    kind: 'not_decision_maker',
    label: 'Not the right person',
    pattern:
      /\b(not the (right )?person|not my (call|decision|department)|talk to (my|the) (boss|owner|partner)|not the decision)/i,
    advice: 'Ask who is, and whether you can say they sent you.',
  },
  {
    kind: 'no_problem',
    label: 'Our problems aren’t software',
    pattern:
      /\b(problems? (do|does|are|is)(n'?t| not) (involve |about |with |related to )?(the )?software|not a software (problem|issue|thing)|(it'?s|that'?s|it is) not (a |the )?software|software('?s| is) (fine|not the (problem|issue))|(the )?best software|(happy|good|fine) with (our|the) (software|system|tms))/i,
    advice:
      'Good: that’s what you came to learn. Ask what the real headache is and when it last cost them: “What happened the last time that bit you?”',
  },
  {
    kind: 'trust',
    label: 'Wary of a stranger',
    pattern:
      /\b(willing to share|(share|talk) with a stranger|not comfortable (sharing|telling)|how did you get (my|this) number|who gave you (my|this) number|why do you want to know)\b/i,
    advice:
      'Say who you are and why them in one line, offer to meet in person, and start with an easy question about their day, not their numbers.',
  },
  {
    kind: 'have_solution',
    label: 'Already have something',
    pattern:
      /\b(already (have|use|got|work with)|we (have|use) (someone|a guy|a company|an agency|a vendor|a (software|system|tms))|in[- ]house|handled internally)\b/i,
    advice: 'Ask what they would change about how it works now, and what they did before it.',
  },
  {
    kind: 'send_info',
    label: 'Send me an email',
    pattern: /\b(send (me )?(an |some )?(email|info\w*|something)|email me|shoot me an email|put it in an email)\b/i,
    advice: 'Agree, then ask one question so the email fits: “Happy to. What’s the biggest headache with it now?”',
  },
  {
    kind: 'busy',
    label: 'Busy right now',
    pattern:
      /\b((i'?m|he'?s|she'?s|(he|she) (is|was)) (busy|driving|in a meeting|on (a|another) (call|job)|eating|having lunch|at lunch|with a customer|swamped|slammed)|bad time|in the middle of|(don'?t|do not) have (the )?time|not (a )?good time|not right now|another time|eating lunch|can (we|you) (talk|call( me)?( back)?) (in|later)|call (me )?back (in|later))\b/i,
    advice: 'Ask for a time instead of pushing on: “When’s better, tomorrow at 8 or Thursday afternoon?”',
  },
  {
    kind: 'not_now',
    label: 'Not now',
    pattern: /\b(maybe later|next (year|quarter|month|season)|check back|reach out (later|in)|down the road)\b/i,
    advice: 'Ask when would be, and put that time on the calendar.',
  },
  {
    kind: 'not_interested',
    label: 'Not interested',
    pattern: /\b(not interested|no interest|don'?t need (it|that|anything)|we'?re all set|no thanks|take me off)\b/i,
    advice: 'Ask how they handle it today instead of pitching: “Fair. How are you doing it now?”',
  },
  { kind: 'other', label: 'Other', pattern: null, advice: null },
] as const;
export type ObjectionKind = (typeof OBJECTIONS)[number]['kind'];
export const OBJECTION_KINDS = OBJECTIONS.map((o) => o.kind);
export const objectionFor = (kind: string | null) => OBJECTIONS.find((o) => o.kind === kind) ?? null;

// A connect shorter than this that left without a next step is flagged:
// rushed calls with nothing agreed evaporate.
export const FAST_CALL_SEC = 90;
// A connect this long is a bright spot, to see what it did differently.
export const LONG_CONNECT_SEC = 5 * 60;
// Without a transcript, a connect this long got past the opening.
const CONVERSATION_SEC = 2 * 60;
// With one, this many of their words did.
const CONVERSATION_WORDS = 80;
// Shorter than this, nobody really answered (a busy signal, a hang-up).
const ANSWERED_SEC = 20;

// The coaching tags of a call: the call_insights columns the rules fill in.
// 0/1 for yes/no, as D1 stores them.
export interface InsightFields {
  gate: Gate;
  gatekeeper_result: GatekeeperResult | null;
  gatekeeper_name: string | null;
  phone_tree_sec: number | null; // seconds of phone menu before a person answered
  phone_tree_digit: string | null; // the menu's digit for the person they called, when it said
  reached: number; // 1: spoke with the person they called for
  talk_sec: number | null; // from when that person came on to the end of the call
  stage: Stage;
  objection: string | null;
  objection_kind: ObjectionKind | null;
  got_past_objection: number;
  next_step: number;
  next_step_text: string | null;
  opening: string | null;
  gatekeeper_line: string | null;
  what_worked: string | null;
  adjust: string | null;
  // The Mom Test, on a call that reached them: null when nothing could say
  // (no transcript, never reached). The rules give a first pass from the
  // transcript; a review settles them.
  asked_last_time: number | null; // 1: asked about a specific past instance, not habits or hypotheticals
  pitched: number | null; // 1: described the idea or the product
  longest_story_sec: number | null; // their longest uninterrupted turn once they came on
  fluff_caught: number | null; // 1: brought "usually" / "I would" back to a past instance
  commitment: Commitment | null; // what they gave up at the end
}

// What they gave up at the end of a call: their time (a set time, an
// interview), their reputation (an intro to someone), or money (a paid
// pilot, a pre-order). A friendly call with none is a failure, Mom Test-wise.
export const COMMITMENTS = ['time', 'intro', 'money'] as const;
export type Commitment = (typeof COMMITMENTS)[number];
export const COMMITMENT_LABELS: Record<Commitment, string> = { time: 'their time', intro: 'an intro', money: 'money' };

// The tags a reading can be unsure of, by the names the connector shows.
export const TAGS = [
  'whoAnswered',
  'frontDeskResult',
  'reachedThem',
  'stage',
  'objection',
  'nextStep',
  'askedAboutLastTime',
  'pitched',
  'longestStorySec',
  'fluffCaught',
  'commitment',
] as const;
export type Tag = (typeof TAGS)[number];
// The tags that only mean something once they were reached.
export const MOM_TEST_TAGS: readonly Tag[] = [
  'askedAboutLastTime',
  'pitched',
  'longestStorySec',
  'fluffCaught',
  'commitment',
];

// Who decided each tag, and how sure it was (null: the rules don't say).
export interface TagSource {
  by: 'rules' | 'jev' | 'claude' | 'rep';
  p: number | null;
}
export type TagSources = Partial<Record<Tag, TagSource>>;

// Every tag decided by the rules, until Jev or a review has a say.
export const rulesSources = (): TagSources => Object.fromEntries(TAGS.map((tag) => [tag, { by: 'rules', p: null }]));

// call_insights keeps both as JSON; a damaged value reads as nothing.
export function parseUnsure(json: string | null | undefined): Tag[] {
  try {
    const value: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(value) ? TAGS.filter((t) => value.includes(t)) : [];
  } catch {
    return [];
  }
}

export function parseSources(json: string | null | undefined): TagSources {
  try {
    const value: unknown = JSON.parse(json ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as TagSources) : {};
  } catch {
    return {};
  }
}

// --- Reviews: the rep's, or Claude's through the connector ---

// Who reviewed a call. The rep's review wins over Claude's, and both over the rules.
export const REVIEWERS = ['claude', 'rep'] as const;
export type Reviewer = (typeof REVIEWERS)[number];

// A review's answer for any of the tags; a tag left out keeps the rules'.
export interface Corrections {
  whoAnswered?: Gate;
  frontDeskResult?: GatekeeperResult | null;
  reachedThem?: boolean;
  stage?: Stage;
  objection?: { kind: ObjectionKind | null; said?: string | null };
  nextStep?: { agreed: boolean; what?: string | null };
  // The Mom Test
  askedAboutLastTime?: boolean;
  pitched?: boolean;
  longestStorySec?: number | null;
  fluffCaught?: boolean;
  commitment?: Commitment | null;
}

export interface CallReview {
  reviewer: Reviewer;
  corrections: Corrections;
  what_worked: string | null;
  adjust: string | null;
  reviewed_at: string; // ISO
  dial_id?: string | null; // the call it's of; null: the call whatever its dial (see migration 0029)
}

// call_reviews keeps corrections as JSON; a damaged value reads as none.
export function parseCorrections(json: string | null | undefined): Corrections {
  try {
    const value: unknown = JSON.parse(json ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Corrections) : {};
  } catch {
    return {};
  }
}

// The tags a review answers.
export const correctedTags = (c: Corrections): Tag[] => TAGS.filter((tag) => c[tag] !== undefined);

// A call's reading with its reviews laid over it: Claude's, then the rep's,
// so the rep's wins. Each tag a review answers takes its value, is no longer
// unsure, and is marked as the reviewer's. What worked and what to adjust
// are the last review's that says. Whether they got past the objection
// follows from the result.
export function withReviews<T extends InsightFields & { unsure: string; sources: string }>(
  row: T,
  reviews: CallReview[]
): T {
  if (!reviews.length) return row;
  const out = { ...row };
  const unsure = new Set(parseUnsure(row.unsure));
  const sources = parseSources(row.sources);
  const settle = (tag: Tag, by: Reviewer) => {
    unsure.delete(tag);
    sources[tag] = { by, p: null };
  };
  const ordered = [...reviews].sort((a, b) => REVIEWERS.indexOf(a.reviewer) - REVIEWERS.indexOf(b.reviewer));
  for (const { reviewer, corrections: c, what_worked, adjust } of ordered) {
    if (c.whoAnswered !== undefined) out.gate = c.whoAnswered;
    if (c.frontDeskResult !== undefined) out.gatekeeper_result = c.frontDeskResult;
    if (c.reachedThem !== undefined) out.reached = c.reachedThem ? 1 : 0;
    if (c.stage !== undefined) out.stage = c.stage;
    if (c.objection !== undefined) {
      out.objection_kind = c.objection.kind;
      out.objection = c.objection.kind ? (c.objection.said ?? out.objection) : null;
    }
    if (c.nextStep !== undefined) {
      out.next_step = c.nextStep.agreed ? 1 : 0;
      out.next_step_text = c.nextStep.agreed ? (c.nextStep.what ?? out.next_step_text) : null;
      // How far it got follows, as the rules have it, unless the review says;
      // a stage it moves is the review's too.
      if (c.stage === undefined) {
        const stage = out.stage;
        if (!c.nextStep.agreed && out.stage === 'next_step') out.stage = 'conversation';
        if (c.nextStep.agreed && out.reached) out.stage = 'next_step';
        if (out.stage !== stage) settle('stage', reviewer);
      }
    }
    if (c.askedAboutLastTime !== undefined) out.asked_last_time = c.askedAboutLastTime ? 1 : 0;
    if (c.pitched !== undefined) out.pitched = c.pitched ? 1 : 0;
    if (c.longestStorySec !== undefined) out.longest_story_sec = c.longestStorySec;
    if (c.fluffCaught !== undefined) out.fluff_caught = c.fluffCaught ? 1 : 0;
    if (c.commitment !== undefined) out.commitment = c.commitment;
    for (const tag of correctedTags(c)) settle(tag, reviewer);
    if (what_worked) out.what_worked = what_worked;
    if (adjust) out.adjust = adjust;
  }
  out.got_past_objection =
    out.objection_kind && out.reached && stageRank(out.stage) >= stageRank('conversation') ? 1 : 0;
  // Never reached (a review took back what the rules took for them): the
  // Mom Test has nothing to judge, whatever the rules heard.
  if (!out.reached) {
    out.asked_last_time = null;
    out.pitched = null;
    out.longest_story_sec = null;
    out.fluff_caught = null;
    out.commitment = null;
    for (const tag of MOM_TEST_TAGS) unsure.delete(tag);
  }
  // The drawing, when the row carries one, follows the reviewed tags.
  const drawn = out as { timeline_json?: string | null };
  if (typeof drawn.timeline_json === 'string') {
    const t = parseTimeline(drawn.timeline_json);
    if (t) drawn.timeline_json = timelineJson(withReviewedTags(t, out));
  }
  out.unsure = JSON.stringify(TAGS.filter((t) => unsure.has(t)));
  out.sources = JSON.stringify(sources);
  return out;
}

// Who wrote the what-worked and the adjust that stand: the last review that
// said (Claude's, then the rep's, as withReviews lays them). Null: no review did.
export function feedbackBy(reviews: CallReview[]): { whatWorked: Reviewer | null; adjust: Reviewer | null } {
  const last = (said: (r: CallReview) => string | null) =>
    [...REVIEWERS].reverse().find((reviewer) => reviews.some((r) => r.reviewer === reviewer && said(r))) ?? null;
  return { whatWorked: last((r) => r.what_worked), adjust: last((r) => r.adjust) };
}

// Where in the transcript each thing happened, as turn indices (null: it
// didn't, or there's no transcript): what the call's timeline is drawn from
// (lib/call-timeline.ts). Never stored as such.
export interface TurnMarks {
  menuEnd: number | null; // the first turn after the phone menu
  ownerFrom: number | null; // where the person they called for came on
  holdFrom: number | null; // where the front desk put them on hold
  deskBackAt: number | null; // where the front desk came back after the hold, with an answer
  voicemailFrom: number | null; // where a voicemail greeting started
  openingAt: number | null; // the rep's first line to them
  objectionAt: number | null; // their objection
  nextStepAt: number | null; // where the next step was agreed, or their number given
  lastTimeAt: number[]; // the rep asking about a specific past instance
  pitchAt: number[]; // the rep describing the idea or the product
}

export const NO_MARKS: TurnMarks = {
  menuEnd: null,
  ownerFrom: null,
  holdFrom: null,
  deskBackAt: null,
  voicemailFrom: null,
  openingAt: null,
  objectionAt: null,
  nextStepAt: null,
  lastTimeAt: [],
  pitchAt: [],
};

// One call read by the rules, with the tags they only guessed at.
export interface RuleReading extends InsightFields {
  unsure: Tag[];
  marks: TurnMarks;
}

// What a call's reading starts from.
export interface CallFacts {
  label: string; // who it was with
  firstName: string | null; // theirs, to tell them from the front desk
  outcome: string; // the rep's logged outcome
  channel: CallChannel;
  durationSec: number | null;
  notes: string;
  transcript: CallTranscript | null;
  setTime: boolean; // the follow-up is at a time the contact asked for
  booked: boolean; // the call booked an interview
}

// The first name in "Nora Quill at Quill Trucking" or "Call with Nora
// Quill (Quill Trucking)".
export function firstNameOf(label: string): string | null {
  const first = label
    .replace(/^call with\s+/i, '')
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^\p{L}'-]/gu, '');
  return first || null;
}

// The rules were written for Nova-3's bare words (lowercase, no punctuation),
// which is how the older transcripts are kept. Newer ones keep Nova's
// punctuation for reading; the rules (ruleInsight, theirPart) read this plain
// copy of either, so both read the same. A colon or point stays between
// digits ("3:30").
export function plainText(text: string): string {
  return text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/\b([ap])\.m\b\.?/g, '$1m')
    .replace(/[^\p{L}\p{N}'\s:.-]/gu, ' ')
    .replace(/(?<!\p{N})[:.]|[:.](?!\p{N})/gu, ' ')
    .replace(/(^|\s)[-']+|[-']+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export const plainTurns = (turns: Turn[]): Turn[] => turns.map((t) => ({ ...t, text: plainText(t.text) }));

export function callFacts(log: CallLog, dial: Dial | null, transcript: CallTranscript | null): CallFacts {
  const dialSec = dial?.prospect_status === 'completed' ? dial.prospect_duration_sec : null;
  const label = dial?.contact_label || log.title;
  return {
    label,
    firstName: firstNameOf(label),
    outcome: log.outcome,
    channel: log.channel,
    durationSec: log.duration_sec ?? dialSec,
    notes: log.notes.trim(),
    transcript,
    setTime: log.next_set_time === 1,
    booked: Boolean(log.book_start),
  };
}

// An interview's facts, from the call made from its page (dials, subject
// 'meeting') and how the rep logged it (meeting_logs): read with the same
// rules as a cold call. Completed → connected; a no-show or a cancel → no
// answer; moved, or not logged yet → whatever the call itself says. Without
// a transcript the rep's notes on the interview are read.
export function interviewFacts(dial: Dial, log: MeetingLog | null, transcript: CallTranscript | null): CallFacts {
  const answered = dial.prospect_status === 'completed';
  const outcome =
    log?.outcome === 'COMPLETED'
      ? 'connected'
      : log?.outcome === 'NO_SHOW' || log?.outcome === 'CANCELED'
        ? 'no_answer'
        : answered
          ? 'connected'
          : 'no_answer';
  return {
    label: dial.contact_label,
    firstName: firstNameOf(dial.contact_label),
    outcome,
    channel: 'phone',
    durationSec: answered ? dial.prospect_duration_sec : null,
    notes: log?.notes.trim() ?? '',
    transcript,
    setTime: false,
    booked: false,
  };
}

// What there is to read: the transcript, else the rep's notes, else only the
// outcome and the length.
export type InsightSource = 'transcript' | 'notes' | 'outcome';

export function insightSource(facts: CallFacts): InsightSource {
  if (facts.transcript?.turns.some((t) => t.speaker === 'prospect')) return 'transcript';
  return facts.notes ? 'notes' : 'outcome';
}

// --- What the transcript shows about the rep's style ---

export interface TranscriptStats {
  prospectTalkShare: number | null; // 0–1: the prospect's share of the words
  repQuestions: number;
  youFocus: number | null; // 0–1: "you/your" over "you/your" + "we/our/us" in the rep's words
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

export function transcriptStats(turns: Turn[]): TranscriptStats {
  const rep = turns.filter((t) => t.speaker === 'rep').map((t) => t.text);
  const prospect = turns.filter((t) => t.speaker === 'prospect').map((t) => t.text);
  const repWords = rep.reduce((n, t) => n + words(t), 0);
  const prospectWords = prospect.reduce((n, t) => n + words(t), 0);
  const repText = rep.join(' ');
  const you = count(repText, /\b(you|your|you're|yours|yourself)\b/gi);
  const we = count(repText, /\b(we|our|us|we're|ours)\b/gi);
  return {
    prospectTalkShare:
      repWords + prospectWords > 0 && prospect.length ? prospectWords / (repWords + prospectWords) : null,
    repQuestions: count(repText, /\?/g),
    youFocus: you + we > 0 ? you / (you + we) : null,
  };
}

function clip(text: string | null | undefined, max: number): string | null {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// The words around a match: a transcript turn has no sentences to cut at.
function around(text: string, pattern: RegExp, max = 160): string | null {
  const m = pattern.exec(text);
  if (!m) return null;
  if (text.length <= max) return clip(text, max);
  const start = Math.max(0, text.lastIndexOf(' ', Math.max(0, m.index - max / 3)));
  const cut = clip(text.slice(start), max);
  return cut && start > 0 ? `…${cut}` : cut;
}

// The sentence around a match in the rep's notes, as the evidence for it.
function sentenceAround(text: string, pattern: RegExp): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (pattern.test(sentence)) return clip(sentence, 160);
  }
  return null;
}

const sameName = (a: string | null, b: string | null) =>
  Boolean(a && b && a.toLowerCase().replace(/[^a-z]/g, '') === b.toLowerCase().replace(/[^a-z]/g, ''));
const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
const nameIn = (text: string, name: string | null) =>
  Boolean(name && new RegExp(`\\b${name.replace(/[^\p{L}]/gu, '')}\\b`, 'iu').test(text));

// --- The transcript, turn by turn ---

// A phone menu: the turns before anyone answers.
const MENU =
  /\b(press (\d|one|two|three|four|five|six|seven|eight|nine|zero|pound|star)|menu options|options have (recently )?changed|extension|office hours|business hours|our hours are|please hold|next available|para espa)/i;
// The phone system putting the call through.
const TRANSFER =
  /\b(your call is being (transferred|connected)|please (wait|hold) while (i|we) (transfer|connect)|connecting your call)\b/i;
// A voicemail greeting, the contact's or the company's.
const VOICEMAIL =
  /\b(record your message|at the tone|after the tone|at the beep|after the beep|not available to take your call|no one (is )?available to take your call|forwarded to (an? )?(automated )?voice ?mail|voice ?mail ?box|mailbox (is full|of)|please leave (your|a) (name|message))/i;
// The rep asking the front desk for someone.
const ASK =
  /\b(is \w+ (available|in|there|around)|(can|could|may) i (speak|talk) (with|to)|i'?m looking for|transfer me|put me through|connect me (with|to))\b/i;
// The front desk putting them on hold or through.
const HOLD =
  /\b(hold|hang on|one (moment|second|sec|minute)|just a (moment|second|sec|minute)|let me (check|see|transfer|grab|get))\b/i;
const NOT_AVAILABLE =
  /\b(not available|unavailable|(he|she)('s| is) not\b|isn'?t (in|available|here)|is not (in|here)|not in (today|the office)|(just )?(barely )?(left|stepped out) for|stepped out|in and out|(on|in) (the |another |a )?(other line|another call|meetings?)|out of (the )?office|out today|left for the day|on vacation)/i;
const REFUSED =
  /\b((not able|unable|can'?t|cannot|won'?t be able) to transfer|don'?t (do|take) (sales|cold) calls|email only|only (by|over|through) email|(have|need) to (follow[- ]?up|reach out|contact \w+) (with|by|over|through|via) (the |an )?email|not (taking|accepting) (calls|solicitation))/i;
const TOOK_MESSAGE =
  /\b(take a message|leave (him |her )?a message|i'?ll (let (him|her) know|pass (it|that) (along|on)))/i;
const SAID_NAME = /\b(?:this is|my name is) ([a-z][a-z'-]+)|\b([a-z][a-z'-]+) speaking\b/i;
const NOT_A_NAME = new Set(['the', 'a', 'an', 'not', 'about', 'regarding', 'for', 'is', 'it', 'he', 'she', 'just']);

// Agreeing when to talk next.
const CALL_WORDS = /\b(call|talk|ring|reach|chat|meet)\b/i;
const WHEN =
  /\b(in (about )?(maybe )?(a |an )?(half (an )?hour|hour|\d+ minutes)|later (today|this (morning|afternoon|evening))|this (morning|afternoon|evening)|tomorrow|tonight|next week|(on )?(monday|tuesday|wednesday|thursday|friday)|(at|about) \d{1,2}(:\d{2})?|\d{1,2}:\d{2}|\d{1,2} ?(am|pm|o'?clock))\b/i;
const NUMBER_WORDS = /\b(cell|number|direct (line|number)|mobile)\b/i;

// The Mom Test, as far as words can tell. Asking about a specific past
// instance; describing the idea or the product (the one-line "I'm a
// founder, not selling anything" isn't a pitch); them offering someone else.
const LAST_TIME =
  /\b(last time|the last (one|load|quote|invoice|week|month)|walk me through|what did you do|tell me about (the|a|that) time|when (did|was) (that|it) last|how did (you|that) (handle|go|end)|what happened (when|the))\b/i;
const PITCH =
  /\b(we('re| are)? (build|building|offer|offering|help|helping|provide|providing)|our (product|software|tool|platform|solution|app)|i('m| am) building (a|an|the|software|something)|what we do is|it (lets|helps|allows|would let) you|(my|our) (startup|company) (does|makes|builds))\b/i;
const INTRO =
  /\b(talk to (my|our|the) \w+|introduce you|put you in touch|give you (his|her|their) (number|email|cell)|(he|she|they) (handles?|does|runs) (that|all of that|the \w+)|reach out to (my|our))\b/i;

const far = (t: Turn) => t.speaker !== 'rep';

export interface PhoneTree {
  sec: number; // when a person answered
  digit: string | null; // "press 4 for jeremy"
  end: number; // the index of the first turn after it
}

// The phone menu at the start of a call: far-side turns that read like one,
// with any short words from the rep in between. Null when a person answered.
export function phoneTree(turns: Turn[], firstName: string | null): PhoneTree | null {
  let end = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (far(t) && MENU.test(t.text)) end = i + 1;
    else if (far(t) || words(t.text) > 3) break;
  }
  if (!end) return null;
  const human = turns.findIndex((t, i) => i >= end && far(t));
  const menu = turns
    .slice(0, end)
    .filter(far)
    .map((t) => t.text)
    .join(' ');
  const name = firstName?.replace(/[^\p{L}]/gu, '');
  const digit = name
    ? (new RegExp(`press (\\d) for (?:\\w+ )?${name}\\b|for ${name},? press (\\d)`, 'iu').exec(menu) ?? [])
        .slice(1)
        .find(Boolean)
    : undefined;
  return {
    sec: Math.round(human >= 0 ? turns[human].start : turns[turns.length - 1].start),
    digit: digit ?? null,
    end,
  };
}

// The rep talked with someone: past any phone menu, the rep said something
// and a person said a line that isn't the menu, a transfer notice or a
// voicemail greeting. A call that only reached those didn't, and a summary
// of it would be made up.
export function talkedWithSomeone(turns: Turn[]): boolean {
  const plain = plainTurns(turns);
  const after = plain.slice(phoneTree(plain, null)?.end ?? 0);
  const repWords = after.filter((t) => t.speaker === 'rep').reduce((n, t) => n + words(t.text), 0);
  return (
    repWords >= 2 &&
    after.some(
      (t) => far(t) && words(t.text) >= 2 && !MENU.test(t.text) && !TRANSFER.test(t.text) && !VOICEMAIL.test(t.text)
    )
  );
}

// Who answered and what happened, from the transcript alone. Null when no
// person answered on it (only a menu, or nothing on their side).
export interface TranscriptReading {
  gate: 'owner' | 'gatekeeper' | 'voicemail';
  gateSure: boolean;
  result: GatekeeperResult | null;
  name: string | null; // the front desk's
  tree: PhoneTree | null;
  ownerFrom: number | null; // the turn where the person they called for came on
  holdFrom: number | null; // the turn where the front desk put them on hold
  deskBackAt: number | null; // the turn where the front desk came back after the hold, with an answer
  voicemailFrom: number | null; // the turn where a voicemail greeting started
  deskLine: string | null; // the rep's line to the front desk
  opening: string | null; // the rep's first line to them
  openingAt: number | null; // its turn
}

export function readTranscript(turns: Turn[], firstName: string | null): TranscriptReading | null {
  const tree = phoneTree(turns, firstName);
  const start = tree?.end ?? 0;
  const firstFar = turns.findIndex((t, i) => i >= start && far(t));
  if (firstFar < 0) return null;
  const base = {
    tree,
    name: null,
    result: null,
    deskLine: null,
    opening: null,
    openingAt: null,
    ownerFrom: null,
    holdFrom: null,
    deskBackAt: null,
    voicemailFrom: null,
  };
  if (VOICEMAIL.test(turns[firstFar].text)) {
    return { ...base, gate: 'voicemail', gateSure: true, voicemailFrom: firstFar };
  }

  // The rep's first lines, and what the person who answered said before them.
  const repLines = turns
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => i > firstFar && t.speaker === 'rep' && words(t.text) >= 3)
    .slice(0, 2);
  const repFirst = repLines[0]?.i ?? turns.length;
  const greeting = turns
    .slice(firstFar, repFirst)
    .filter(far)
    .map((t) => t.text)
    .join(' ');
  const said = SAID_NAME.exec(greeting);
  const saidName = (said?.[1] ?? said?.[2] ?? null)?.toLowerCase() ?? null;
  const deskName = saidName && !NOT_A_NAME.has(saidName) && !sameName(saidName, firstName) ? saidName : null;
  const ask = repLines.find(({ t }) => ASK.test(t.text))?.i ?? -1;
  const firstLineAt = (i: number) => turns.findIndex((t, j) => j >= i && t.speaker === 'rep' && words(t.text) >= 4);
  const firstLine = (i: number) => clip(turns[firstLineAt(i)]?.text, 240);
  const at = (i: number) => (i >= 0 ? i : null);

  const owner = (sure: boolean): TranscriptReading => ({
    ...base,
    gate: 'owner',
    gateSure: sure,
    ownerFrom: firstFar,
    opening: firstLine(firstFar),
    openingAt: at(firstLineAt(firstFar)),
  });
  if (sameName(saidName, firstName)) return owner(true);
  if (ask < 0 && !deskName) return owner(repLines.length > 0 && nameIn(turns[repFirst].text, firstName));

  // The front desk. What it did, from the rep's ask on.
  const from = ask >= 0 ? ask : repFirst;
  const later = turns.map((t, i) => ({ t, i })).filter(({ i }) => i > from);
  const farLater = later.filter(({ t }) => far(t));
  const vm = farLater.find(({ t }) => VOICEMAIL.test(t.text))?.i ?? -1;
  const hold = farLater.find(({ t }) => HOLD.test(t.text))?.i ?? -1;
  // Put through: after the hold, the rep talks to them by name (or they say
  // who they are), and they talk back.
  const through =
    hold < 0
      ? -1
      : (later.find(
          ({ t, i }) =>
            i > hold &&
            (vm < 0 || i < vm) &&
            ((t.speaker === 'rep' && !ASK.test(t.text) && nameIn(t.text, firstName)) ||
              (far(t) && sameName(SAID_NAME.exec(t.text)?.[1] ?? null, firstName)))
        )?.i ?? -1);
  const theyTalked =
    through >= 0 &&
    turns
      .slice(through + 1, vm >= 0 ? vm : undefined)
      .filter(far)
      .reduce((n, t) => n + words(t.text), 0) >= 15;
  const farText = farLater
    .filter(({ i }) => vm < 0 || i < vm)
    .map(({ t }) => t.text)
    .join('\n');
  // Nobody came on after the hold: everything they said since is the hold.
  const heldOnly =
    hold >= 0 && farLater.filter(({ i }) => i > hold).every(({ t }) => HOLD.test(t.text) || words(t.text) <= 2);
  // Else the front desk came back with an answer (not available, a message,
  // "I'll put you through now"): the hold ended there, whatever came next.
  const deskBack =
    hold >= 0 && !heldOnly
      ? (farLater.find(
          ({ t, i }) =>
            i > hold && !HOLD.test(t.text) && words(t.text) > 2 && (vm < 0 || i < vm) && (through < 0 || i < through)
        )?.i ?? -1)
      : -1;

  const result: GatekeeperResult | null =
    vm >= 0 && (!theyTalked || vm < through)
      ? 'sent_to_voicemail'
      : theyTalked
        ? 'put_through'
        : REFUSED.test(farText)
          ? 'refused'
          : heldOnly
            ? 'on_hold_no_pickup'
            : NOT_AVAILABLE.test(farText)
              ? 'not_available'
              : TOOK_MESSAGE.test(farText)
                ? 'took_message'
                : null;
  return {
    ...base,
    gate: 'gatekeeper',
    gateSure: true,
    result,
    name: deskName ? capitalized(deskName) : null,
    ownerFrom: result === 'put_through' ? through : null,
    holdFrom: at(hold),
    deskBackAt: at(deskBack),
    voicemailFrom: at(vm),
    deskLine: clip(turns[from]?.text, 240),
    opening: result === 'put_through' ? firstLine(through) : null,
    openingAt: result === 'put_through' ? at(firstLineAt(through)) : null,
  };
}

// --- The rep's notes ---

const DESK_WORDS =
  /\b(secretary|receptionist|reception|front desk|front office|assistant|gatekeeper|operator|office manager|switchboard|tra\w*fer+ed)\b/i;
const TALKED_WITH = /\b(?:[Tt]alked|[Ss]poke|[Ss]poken) (?:with|to) ([A-Z][a-z]+)\b/;
// "She says contact him": someone other than them.
const OTHER_PERSON = /\b(she (said|says|told me)\b[^.]*\bhim\b|he (said|says|told me)\b[^.]*\bher\b)/i;
const OWNER_NOTE = /\b((he|she) (said|says|told me|was|is|mentioned|asked|gave)|(talked|spoke) (with|to) (him|her))\b/i;
// First match wins: being sent to voicemail says "transferred" too, and so
// does a hold nobody picked up.
const NOTE_RESULTS: [GatekeeperResult, RegExp][] = [
  [
    'sent_to_voicemail',
    /\b(tra\w*fer+ed|sent|put|forwarded|went) (me )?(to|into|straight to) (his |her |their |the )?voice ?mail/i,
  ],
  ['on_hold_no_pickup', /\b(never (picked up|came on|answered|got on)|no one picked up|on hold (forever|for ages))\b/i],
  ['put_through', /\b(put (me )?through|tra\w*fer+ed me to (him|her|them)|connected me|got (past|through))\b/i],
  ['refused', REFUSED],
  ['not_available', NOT_AVAILABLE],
  ['took_message', /\b(took a message|left (a )?message with|take a message)\b/i],
];
const NEXT_STEP_NOTE =
  /\b(call(ing)? (him|her|them|me) back|callback|call back|follow up|call (him|her|them))\b.{0,40}\b(at|on|in \d+|tomorrow|today|monday|tuesday|wednesday|thursday|friday|next week|morning|afternoon|\d{1,2}(:\d{2})? ?(am|pm))\b|\bgave (me )?(his|her|their) (cell|mobile|direct (line|number)|number)\b|\b(booked|scheduled|set up) (a |an )?(call|meeting|interview|demo|time)\b/i;

interface NotesReading {
  gate: 'owner' | 'gatekeeper';
  gateSure: boolean;
  result: GatekeeperResult | null;
  name: string | null;
}

function readNotes(notes: string, firstName: string | null): NotesReading | null {
  const talkedWith = TALKED_WITH.exec(notes)?.[1] ?? null;
  const result = NOTE_RESULTS.find(([, p]) => p.test(notes))?.[0] ?? null;
  const otherName = talkedWith && !sameName(talkedWith, firstName) ? talkedWith : null;
  if (DESK_WORDS.test(notes) || otherName || OTHER_PERSON.test(notes)) {
    return { gate: 'gatekeeper', gateSure: true, result, name: otherName };
  }
  // "Not available" with nothing else: someone said so, and it wasn't them.
  if (result) return { gate: 'gatekeeper', gateSure: false, result, name: null };
  if (talkedWith || OWNER_NOTE.test(notes)) return { gate: 'owner', gateSure: true, result: null, name: null };
  return null;
}

// --- The reading ---

function objectionIn(text: string, aroundIt: (pattern: RegExp) => string | null) {
  const objection = OBJECTIONS.find((o) => o.pattern?.test(text)) ?? null;
  return objection?.pattern ? { kind: objection.kind, said: aroundIt(objection.pattern) } : null;
}

// Reads the call from its facts alone.
export function ruleInsight(facts: CallFacts): RuleReading {
  const duration = facts.durationSec ?? 0;
  const none: RuleReading = {
    gate: 'no_answer',
    gatekeeper_result: null,
    gatekeeper_name: null,
    phone_tree_sec: null,
    phone_tree_digit: null,
    reached: 0,
    talk_sec: null,
    stage: 'no_connect',
    objection: null,
    objection_kind: null,
    got_past_objection: 0,
    next_step: 0,
    next_step_text: null,
    opening: null,
    gatekeeper_line: null,
    what_worked: null,
    adjust: null,
    asked_last_time: null,
    pitched: null,
    longest_story_sec: null,
    fluff_caught: null,
    commitment: null,
    unsure: [],
    marks: NO_MARKS,
  };
  // The outcome settles a call nobody (or the wrong person) answered.
  if (facts.outcome === 'wrong_number') return { ...none, gate: 'wrong_number' };
  if (facts.outcome === 'no_answer') return none;
  if (facts.outcome === 'left_voicemail') return { ...none, gate: 'voicemail', stage: 'voicemail' };
  // Too short to have been answered; a call logged with no length (from the
  // connector) is read from its notes instead.
  if (facts.durationSec !== null && duration < ANSWERED_SEC && (facts.outcome === 'busy' || !facts.transcript)) {
    return none;
  }

  const turns = plainTurns(facts.transcript?.turns ?? []);
  const heard = insightSource(facts) === 'transcript' ? readTranscript(turns, facts.firstName) : null;
  const unsure: Tag[] = [];
  const tree = heard?.tree ?? null;

  if (heard?.gate === 'voicemail') {
    return {
      ...none,
      gate: 'voicemail',
      stage: 'voicemail',
      phone_tree_sec: tree?.sec ?? null,
      phone_tree_digit: tree?.digit ?? null,
      marks: { ...NO_MARKS, menuEnd: tree?.end ?? null, voicemailFrom: heard.voicemailFrom },
    };
  }

  // Who answered, and what the front desk did.
  let gate: 'owner' | 'gatekeeper';
  let result: GatekeeperResult | null;
  let name: string | null;
  if (heard) {
    ({ gate, result, name } = heard);
    if (!heard.gateSure) unsure.push('whoAnswered');
  } else {
    const read = readNotes(facts.notes, facts.firstName);
    if (read) {
      ({ gate, result, name } = read);
      if (!read.gateSure) unsure.push('whoAnswered');
    } else if (facts.outcome === 'left_live_message') {
      [gate, result, name] = ['gatekeeper', 'took_message', null];
    } else if (facts.outcome === 'busy') {
      // How the rep logs "they weren't available".
      [gate, result, name] = ['gatekeeper', 'not_available', null];
      unsure.push('whoAnswered');
    } else {
      // "Connected" says someone picked up, not who.
      [gate, result, name] = ['owner', null, null];
      unsure.push('whoAnswered');
    }
  }
  if (gate === 'gatekeeper' && !result) unsure.push('frontDeskResult');
  const reached = gate === 'owner' || result === 'put_through';
  if (unsure.includes('whoAnswered') || unsure.includes('frontDeskResult')) unsure.push('reachedThem');

  // What the person they called for said.
  const ownerFrom = heard?.ownerFrom ?? null;
  const ownerTurns = reached && ownerFrom !== null ? turns.slice(ownerFrom) : [];
  const theirTurns = ownerTurns.filter((t) => far(t) && !VOICEMAIL.test(t.text));
  const theySaid = theirTurns.map((t) => t.text).join('\n');
  const theirWords = theirTurns.reduce((n, t) => n + words(t.text), 0);
  const lastAt = turns.length ? turns[turns.length - 1].start + 3 : 0;
  const talkSec = !reached
    ? null
    : ownerFrom !== null
      ? Math.max(0, Math.round((facts.durationSec ?? lastAt) - turns[ownerFrom].start))
      : facts.durationSec;

  // The objection: theirs, or the front desk asking if it's a sales call.
  const allFar = turns
    .filter(far)
    .map((t) => t.text)
    .join('\n');
  const objection = heard
    ? reached
      ? objectionIn(theySaid, (p) => around(theirTurns.find((t) => p.test(t.text))?.text ?? '', p))
      : /\bsales call\b/i.test(allFar)
        ? { kind: 'sales_call' as const, said: around(allFar, /\bsales call\b/i) }
        : null
    : reached
      ? objectionIn(facts.notes, (p) => sentenceAround(facts.notes, p))
      : null;
  if (reached && !heard && !objection) unsure.push('objection');
  const objectionPattern = objection ? OBJECTIONS.find((o) => o.kind === objection.kind)?.pattern : undefined;
  const objectionTurn = objectionPattern
    ? (reached ? theirTurns : turns.filter(far)).find((t) => objectionPattern.test(t.text))
    : undefined;

  // A next step: a booked interview or a set time, else a time to talk or
  // their number, from them.
  const agreedAt = theirTurns.find((t) => {
    if (!WHEN.test(t.text)) return false;
    const i = turns.indexOf(t);
    const before = turns.slice(Math.max(0, i - 2), i).find((p) => p.speaker === 'rep');
    return CALL_WORDS.test(t.text) || Boolean(before && CALL_WORDS.test(before.text));
  });
  const digits = theySaid.replace(/\D/g, '').length;
  const gaveNumber =
    digits >= 7 &&
    (NUMBER_WORDS.test(theySaid) || ownerTurns.some((t) => t.speaker === 'rep' && NUMBER_WORDS.test(t.text)));
  const noteStep = NEXT_STEP_NOTE.test(facts.notes);
  const nextStep = reached && (facts.setTime || facts.booked || Boolean(agreedAt) || gaveNumber || noteStep);
  const nextStepText = !nextStep
    ? null
    : facts.booked
      ? 'Interview booked'
      : facts.setTime
        ? 'Call back at the time they asked for'
        : agreedAt
          ? `“${around(agreedAt.text, WHEN, 120)}”`
          : gaveNumber
            ? 'Gave their direct number'
            : sentenceAround(facts.notes, NEXT_STEP_NOTE);

  const talked = heard ? theirWords >= CONVERSATION_WORDS : (talkSec ?? 0) >= CONVERSATION_SEC;
  const stage: Stage = !reached ? 'gatekeeper' : nextStep ? 'next_step' : talked ? 'conversation' : 'opening';
  if (unsure.includes('reachedThem') || (!heard && reached)) unsure.push('stage');
  if (reached && !heard && !nextStep) unsure.push('nextStep');

  // The Mom Test, on a call that reached them with a transcript: a first
  // pass for the review to settle. The rules can hear a question about the
  // last time, a pitch, how long they talked and a time or an intro agreed;
  // whether fluff was caught, never. Not asking isn't proof of not asking.
  const judged = Boolean(heard) && reached;
  const repTurns = judged ? ownerTurns.filter((t) => t.speaker === 'rep') : [];
  const lastTimeTurns = repTurns.filter((t) => LAST_TIME.test(t.text));
  const pitchTurns = repTurns.filter((t) => PITCH.test(t.text));
  let longestStory: number | null = null;
  if (judged && ownerFrom !== null) {
    longestStory = 0;
    turns.forEach((t, i) => {
      if (i < ownerFrom || t.speaker !== 'prospect') return;
      const { from, to } = turnSpan(turns, i, facts.durationSec ?? lastAt);
      longestStory = Math.max(longestStory ?? 0, Math.round(to - from));
    });
  }
  const commitment: Commitment | null = !judged
    ? null
    : facts.booked || facts.setTime || agreedAt
      ? 'time'
      : theirTurns.some((t) => INTRO.test(t.text))
        ? 'intro'
        : null;
  if (judged) {
    if (!lastTimeTurns.length) unsure.push('askedAboutLastTime');
    if (!pitchTurns.length) unsure.push('pitched');
    if (commitment !== 'time') unsure.push('commitment');
    unsure.push('fluffCaught');
  }

  // Where each of those happened, for the timeline.
  const indexOf = (turn: Turn | undefined) => (turn ? turns.indexOf(turn) : null);
  const numberTurn = gaveNumber ? theirTurns.find((t) => t.text.replace(/\D/g, '').length >= 7) : undefined;
  const marks: TurnMarks = heard
    ? {
        menuEnd: tree?.end ?? null,
        ownerFrom: reached ? ownerFrom : null,
        holdFrom: heard.holdFrom,
        deskBackAt: heard.deskBackAt,
        voicemailFrom: heard.voicemailFrom,
        openingAt: reached ? heard.openingAt : null,
        objectionAt: indexOf(objectionTurn),
        nextStepAt: indexOf(agreedAt ?? numberTurn),
        lastTimeAt: lastTimeTurns.map((t) => turns.indexOf(t)),
        pitchAt: pitchTurns.map((t) => turns.indexOf(t)),
      }
    : NO_MARKS;

  return {
    gate,
    gatekeeper_result: gate === 'gatekeeper' ? result : null,
    gatekeeper_name: gate === 'gatekeeper' ? name : null,
    phone_tree_sec: tree?.sec ?? null,
    phone_tree_digit: tree?.digit ?? null,
    reached: reached ? 1 : 0,
    talk_sec: talkSec,
    stage,
    objection: objection?.said ?? null,
    objection_kind: objection?.kind ?? null,
    got_past_objection: objection && stageRank(stage) >= stageRank('conversation') ? 1 : 0,
    next_step: nextStep ? 1 : 0,
    next_step_text: nextStepText,
    opening: reached ? (heard?.opening ?? null) : null,
    gatekeeper_line: gate === 'gatekeeper' ? (heard?.deskLine ?? null) : null,
    what_worked: null,
    adjust: null,
    asked_last_time: judged ? (lastTimeTurns.length ? 1 : 0) : null,
    pitched: judged ? (pitchTurns.length ? 1 : 0) : null,
    longest_story_sec: longestStory,
    fluff_caught: null,
    commitment,
    unsure: [...new Set(unsure)],
    marks,
  };
}

// The turns the person they called for was on, for the style stats: all of
// them when it's not clear who that was.
export function theirPart(turns: Turn[], firstName: string | null): Turn[] {
  const heard = readTranscript(plainTurns(turns), firstName);
  if (heard?.ownerFrom != null) return turns.slice(heard.ownerFrom);
  return turns.slice(heard?.tree?.end ?? 0);
}

// --- After the call: what to adjust ---

export type NoteKind = 'flag' | 'tip' | 'bright';

export interface CoachNote {
  kind: NoteKind;
  text: string;
}

// The parts of a read call the notes need.
export type ReadCall = InsightFields & { duration_sec: number | null; label: string };

// The length that counts for a connect: from when they came on, else the
// whole call.
const talkOf = (call: Pick<ReadCall, 'talk_sec' | 'duration_sec'>) => call.talk_sec ?? call.duration_sec;

// A rushed connect that left with nothing agreed.
export function fastNoNextStep(call: Pick<ReadCall, 'reached' | 'next_step' | 'duration_sec' | 'talk_sec'>): boolean {
  const sec = talkOf(call);
  return call.reached === 1 && call.next_step === 0 && sec !== null && sec < FAST_CALL_SEC;
}

export function isLongConnect(call: Pick<ReadCall, 'reached' | 'duration_sec' | 'talk_sec'>): boolean {
  return call.reached === 1 && (talkOf(call) ?? 0) >= LONG_CONNECT_SEC;
}

// What to take from one call: flags for the weak spots (a rushed connect
// with no next step, stopping at the front desk, an objection it didn't get
// past), a bright spot for a long connect, the phone tree's shortcut, and a
// review's suggestion.
export function adjustNotes(call: ReadCall): CoachNote[] {
  const notes: CoachNote[] = [];
  const sec = talkOf(call);
  const length = sec !== null ? clock(sec) : null;
  if (fastNoNextStep(call)) {
    notes.push({
      kind: 'flag',
      text: `Ended at ${length} with no next step. When they’re rushed, leave with a time: “When’s better, tomorrow at 8 or Thursday afternoon?”`,
    });
  }
  if (call.gate === 'gatekeeper' && !call.reached) {
    const who = call.gatekeeper_name ? `${call.gatekeeper_name} at the front desk` : 'The front desk';
    const what = call.gatekeeper_result ? GATEKEEPER_RESULT_LABELS[call.gatekeeper_result] : 'stopped the call';
    const advice =
      call.gatekeeper_result === 'on_hold_no_pickup'
        ? 'Next time ask for their direct line or cell before the hold, so a dropped hold isn’t the end of it.'
        : call.gatekeeper_result === 'refused'
          ? 'Ask when they’re usually in, or for their cell, rather than for a transfer.'
          : 'Ask for them by first name as if they expect you, and if they’re out, ask when to catch them or for their direct line.';
    notes.push({ kind: 'flag', text: `${who}: ${what}. ${advice}` });
  }
  if (call.phone_tree_digit && call.phone_tree_sec) {
    notes.push({
      kind: 'tip',
      text: `The phone menu took ${clock(call.phone_tree_sec)}: press ${call.phone_tree_digit} for ${call.label.split(' ')[0]} next time.`,
    });
  }
  const objection = objectionFor(call.objection_kind);
  // "Busy" on a rushed call is the flag above, with the same advice.
  if (objection && !call.got_past_objection && !(objection.kind === 'busy' && fastNoNextStep(call))) {
    const said = call.objection ? `“${call.objection}”` : objection.label;
    const stop = /[.!?…]”?$/.test(said) ? '' : '.';
    notes.push({ kind: 'tip', text: `Objection: ${said}${stop}${objection.advice ? ` ${objection.advice}` : ''}` });
  }
  if (call.reached && call.stage === 'opening' && !fastNoNextStep(call)) {
    notes.push({
      kind: 'tip',
      text: 'It didn’t get past the opening. Lead with a question about their world, not what you do.',
    });
  }
  if (isLongConnect(call)) {
    notes.push({
      kind: 'bright',
      text: `Long connect (${length}).${call.what_worked ? ` ${call.what_worked}` : ' Look at what kept it going, and do it again.'}`,
    });
  }
  const { adjust } = call;
  if (adjust && !notes.some((n) => n.text.includes(adjust))) notes.push({ kind: 'tip', text: adjust });
  return notes;
}

// Real conversations: the calls and interviews where they talked about their
// work and the rep learned something, counted in people toward 100. The rep
// decides what counts, a box on the log form (pre-ticked when the call or
// interview looks like one) or a button on Coaching; this is the counting,
// the pace, and the line each one is remembered by. No I/O.

export const CONVERSATION_GOAL = 100;

// The one line the rep keeps from a conversation.
export const MAX_LEARNED = 280;

// A call that ran this long once it connected is probably a real
// conversation: the log form ticks the box for the rep to untick.
export const LONG_CALL_SEC = 300;

export type ConversationKind = 'call' | 'interview';

export interface ConversationRow {
  kind: ConversationKind;
  ref_id: string; // the CALL task, or the meeting
  contact_id: string;
  who: string; // "Dallas Peery at Wanship Transportation", as coaching labels a call
  learned: string | null;
  at: string; // ISO: when it was logged
  notes: string | null; // the rep's notes on the call or the interview, for an entry with no line of its own
}

// The log form's box and line, checked.
export function parseConversationForm(form: Record<string, string | undefined>): {
  counts: boolean;
  learned: string | null;
} {
  const learned = (form.learned ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEARNED);
  return { counts: form.conversation === '1', learned: learned || null };
}

// Who a conversation was with, the way a dial and coaching label them
// (workflows/dial.ts).
export function whoLabel(contact: string, company: string | null): string {
  return company ? `${contact} at ${company}` : contact;
}

// The same, from a logged call's title (callTitle in workflows/call-logged.ts):
// "Call with Dallas Peery (Wanship Transportation)".
export function whoFromTitle(title: string): string {
  const who = title.replace(/^(Call with|WhatsApp call with|WhatsApp message to) /, '');
  const m = /^(.+) \((.+)\)$/.exec(who);
  return m ? whoLabel(m[1]!, m[2]!) : who;
}

// The first sentence of the rep's notes, for a conversation counted without
// a line of its own.
export function firstLine(notes: string | null | undefined, max = 160): string | null {
  const text = (notes ?? '').trim();
  if (!text) return null;
  const line = text.split('\n')[0]!.trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

// Whether the log form starts with the box ticked: an interview that
// happened, or a call that connected and ran long. Anything that reached
// them can be counted; these are the likely ones.
export function suggestConversation(input: {
  kind: ConversationKind;
  outcome: string;
  durationSec?: number | null;
}): boolean {
  if (input.kind === 'interview') return input.outcome === 'COMPLETED';
  return input.outcome === 'connected' && (input.durationSec ?? 0) >= LONG_CALL_SEC;
}

// The outcomes a conversation can be counted on: someone was there.
export function canCount(kind: ConversationKind, outcome: string): boolean {
  return kind === 'interview' ? outcome === 'COMPLETED' : outcome === 'connected' || outcome === 'replied';
}

export interface ConversationEntry {
  kind: ConversationKind;
  refId: string;
  contactId: string;
  who: string;
  line: string | null; // what they learned, else the notes' first sentence
  own: boolean; // the line is the rep's, not the notes'
  at: string;
}

export interface ConversationReport {
  people: number; // distinct people, toward the goal
  goal: number;
  toGo: number;
  callsPerConversation: number | null; // calls logged per person reached this way; null before the first
  callsToGo: number | null; // about how many more calls the rest takes, at that rate
  entries: ConversationEntry[]; // newest first
}

// `callsLogged`: every call the rep has logged, the denominator of the pace.
export function conversationReport(rows: ConversationRow[], callsLogged: number): ConversationReport {
  const people = new Set(rows.map((r) => r.contact_id)).size;
  const toGo = Math.max(0, CONVERSATION_GOAL - people);
  const rate = people && callsLogged ? callsLogged / people : null;
  return {
    people,
    goal: CONVERSATION_GOAL,
    toGo,
    callsPerConversation: rate === null ? null : Math.round(rate),
    callsToGo: rate === null ? null : Math.round(rate * toGo),
    entries: [...rows]
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((r) => ({
        kind: r.kind,
        refId: r.ref_id,
        contactId: r.contact_id,
        who: r.who,
        line: r.learned ?? firstLine(r.notes),
        own: r.learned !== null,
        at: r.at,
      })),
  };
}

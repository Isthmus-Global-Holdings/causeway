// What they've told the rep, across every call and interview that reached
// them: the software they use, and what they said about their work, in
// their words, by theme (quoting, dispatch, invoicing, drivers, compliance).
// Read from their part of each transcript and from the rep's notes on the
// call or the interview, by rules: patterns for the tools of the trade and
// for the themes, a sentence or a turn at a time. Counts of calls, never
// rates, and the newest quotes, each linking its call. The synthesis is the
// rep's, with Claude through the connector (what_you_heard hands it the
// same): this is the record. No I/O.

import type { Turn } from './transcript';

export interface HeardSource {
  id: string; // the CALL task, or the meeting
  kind: 'call' | 'interview';
  label: string;
  atSec: number;
  turns: Turn[]; // their turns, once they came on; empty without a transcript
  notes: string; // the rep's notes on the call, or on the interview
}

export interface Said {
  text: string; // the quote, clipped
  from: 'them' | 'notes'; // the transcript, or the rep's notes
  pain: boolean; // something that hurts, by the words
  id: string;
  kind: 'call' | 'interview';
  label: string;
  atSec: number;
}

// --- The tools of the trade ---

export interface Tool {
  name: string;
  pattern: RegExp;
}

// Named software first, then the ways of working that stand in for it.
export const TOOLS: Tool[] = [
  { name: 'McLeod', pattern: /\bmc ?leod\b/i },
  { name: 'TMW / Trimble', pattern: /\b(tmw|trimble)\b/i },
  { name: 'Truckstop', pattern: /\btruck ?stop\b/i },
  { name: 'DAT', pattern: /\bdat( one| power| load ?board)?\b/i },
  { name: 'Samsara', pattern: /\bsamsara\b/i },
  { name: 'Motive / KeepTruckin', pattern: /\b(motive|keep ?truckin)\b/i },
  { name: 'QuickBooks', pattern: /\bquick ?books\b/i },
  { name: 'Excel or spreadsheets', pattern: /\b(excel|spread ?sheets?|google sheets?)\b/i },
  { name: 'Axon', pattern: /\baxon\b/i },
  { name: 'Tailwind', pattern: /\btailwind\b/i },
  { name: 'Rose Rocket', pattern: /\brose ?rocket\b/i },
  { name: 'Alvys', pattern: /\balvys\b/i },
  { name: 'Ascend', pattern: /\bascend( tms)?\b/i },
  { name: 'PCS', pattern: /\bpcs (software|tms)\b/i },
  { name: 'Turvo', pattern: /\bturvo\b/i },
  { name: 'MercuryGate', pattern: /\bmercury ?gate\b/i },
  { name: 'Descartes', pattern: /\bdescartes\b/i },
  { name: 'Omnitracs', pattern: /\bomnitracs\b/i },
  { name: 'Fleetio', pattern: /\bfleetio\b/i },
  { name: 'Geotab', pattern: /\bgeotab\b/i },
  { name: 'Verizon Connect', pattern: /\bverizon connect\b/i },
  { name: 'Teletrac', pattern: /\bteletrac\b/i },
  { name: 'PrePass', pattern: /\bpre ?pass\b/i },
  { name: 'Salesforce', pattern: /\bsalesforce\b/i },
  { name: 'HubSpot', pattern: /\bhub ?spot\b/i },
  { name: 'Zoho', pattern: /\bzoho\b/i },
  { name: 'FreshBooks', pattern: /\bfresh ?books\b/i },
  { name: 'Bill.com', pattern: /\bbill\.com\b/i },
  { name: 'Wave', pattern: /\bwave (accounting|apps?)\b/i },
  { name: 'A load board', pattern: /\bload ?boards?\b/i },
  { name: 'A TMS', pattern: /\btms\b/i },
  { name: 'An ELD', pattern: /\belds?\b/i },
  { name: 'Dispatch software', pattern: /\bdispatch(ing)? (software|system|program|app)\b/i },
  {
    name: 'Something in-house',
    pattern: /\b(in[- ]house|built (it|our own|ourselves)|custom (software|system|built))\b/i,
  },
  { name: 'Paper', pattern: /\b(pen and paper|on paper|paper(work)? (and|or) \w+|whiteboard|binders?|notebooks?)\b/i },
  {
    name: 'Phone, email and text',
    pattern: /\b(by (phone|email|text)|over (the phone|email)|text messages?|whatsapp|group ?chat)\b/i,
  },
];

// --- The themes ---

export const THEMES = ['quoting', 'dispatch', 'invoicing', 'people', 'compliance', 'software', 'other'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  quoting: 'Quoting and rates',
  dispatch: 'Dispatch and loads',
  invoicing: 'Invoicing and getting paid',
  people: 'Drivers and people',
  compliance: 'Compliance and safety',
  software: 'The software they use',
  other: 'Other',
};

const THEME_PATTERNS: Record<Exclude<Theme, 'other'>, RegExp> = {
  quoting: /\b(quot(e|es|ed|ing)|rates?|pricing|price[sd]?|bid(s|ding)?|rfps?|tariffs?|per mile|cpm|margin)\b/i,
  dispatch:
    /\b(dispatch\w*|loads?|lanes?|rout(e|es|ing)|track(ing)?|detention|appointments?|deadhead|backhaul|brokers?|shippers?|pick ?ups?|deliver(y|ies))\b/i,
  invoicing:
    /\b(invoic\w+|billing|bills?|factoring|factor|collections?|payments?|paid|pay us|accounts? receivable|a\/r|pods?|proof of delivery|bill of lading|bols?|net \d+|days to pay|cash ?flow)\b/i,
  people:
    /\b(drivers?|hir(e|es|ed|ing)|turnover|quit|stick around|skills?|staff|employees?|people|recruit\w*|retention|office (girl|lady|manager)|dispatchers?)\b/i,
  compliance:
    /\b(dot|safety|insurance|ifta|permits?|audits?|csa|compliance|hours of service|hos|inspections?|fmcsa)\b/i,
  software:
    /\b(software|systems?|apps?|programs?|platforms?|spread ?sheets?|excel|tms|automat\w+|integrat\w+|computers?|online|portal|elds?)\b/i,
};

// Something that hurts, by the words.
const PAIN =
  /\b(problems?|issues?|hard|pain|tedious|time[- ]consuming|takes? (hours|forever|all day|too long)|hours? (a|per|each|every) (day|week|month)|manual(ly)?|mess|headache|slow|late|los(e|t|ing)|mistakes?|wrong|nightmare|hassle|wast(e|ing)|struggl\w+|chas(e|ing)|frustrat\w+|annoying|biggest|worst|killing (me|us)|every (single )?(day|week)|too (much|many|long)|can'?t (keep up|find|get)|behind|double[- ]entry|twice|quits?|quitting|turnover|short[- ]?handed|no[- ]shows?)\b/i;

// A note counts when it reports what they said or do, not the rep's own plans.
const REPORTED = /\b(said|says|told|mentioned|use[sd]?|using|they|he|she|their|his|her|runs?|has|have|got)\b/i;

const QUOTE_MAX = 180;

// The sentence around a match, clipped to a window on word boundaries.
function snippet(text: string, index: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= QUOTE_MAX) return clean;
  const half = Math.floor(QUOTE_MAX / 2);
  let from = Math.max(0, index - half);
  let to = Math.min(clean.length, index + half);
  if (from > 0) from = clean.indexOf(' ', from) + 1 || from;
  if (to < clean.length) to = clean.lastIndexOf(' ', to);
  return `${from > 0 ? '…' : ''}${clean.slice(from, to).trim()}${to < clean.length ? '…' : ''}`;
}

// Notes come as sentences; a transcript as turns (a bare one has no stops).
const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);

export interface HeardOnCall {
  tools: { name: string; said: Said }[];
  said: Said[]; // what they said about their work, by theme
  themes: Theme[];
}

// One call or interview read for what they told the rep.
export function heardOnCall(source: HeardSource): HeardOnCall {
  const units: { text: string; from: Said['from'] }[] = [
    ...source.turns.filter((t) => t.speaker !== 'rep').map((t) => ({ text: t.text, from: 'them' as const })),
    ...sentences(source.notes).map((text) => ({ text, from: 'notes' as const })),
  ];
  const said = (text: string, index: number, from: Said['from'], pain: boolean): Said => ({
    text: snippet(text, index),
    from,
    pain,
    id: source.id,
    kind: source.kind,
    label: source.label,
    atSec: source.atSec,
  });

  const tools: HeardOnCall['tools'] = [];
  for (const tool of TOOLS) {
    for (const u of units) {
      const m = tool.pattern.exec(u.text);
      if (!m) continue;
      tools.push({ name: tool.name, said: said(u.text, m.index, u.from, PAIN.test(u.text)) });
      break; // one quote per tool per call
    }
  }

  const quotes: Said[] = [];
  const themes = new Set<Theme>();
  for (const u of units) {
    const pain = PAIN.test(u.text);
    const hit = (Object.keys(THEME_PATTERNS) as Exclude<Theme, 'other'>[]).filter((t) =>
      THEME_PATTERNS[t].test(u.text)
    );
    // Their turns count when they hurt or name a theme; the rep's notes only
    // when they report what they said or do.
    if (u.from === 'them' ? !pain && !hit.length : !hit.length || !(pain || REPORTED.test(u.text))) continue;
    if (u.from === 'them' && !pain && u.text.split(/\s+/).length < 6) continue; // "yeah loads" isn't a quote
    const first = hit[0] ? THEME_PATTERNS[hit[0]].exec(u.text) : PAIN.exec(u.text);
    quotes.push(said(u.text, first?.index ?? 0, u.from, pain));
    for (const t of hit.length ? hit : ['other' as const]) themes.add(t);
    if (!hit.length) themes.add('other');
  }
  return { tools, said: quotes, themes: THEMES.filter((t) => themes.has(t)) };
}

export interface ToolRow {
  name: string;
  calls: number; // how many calls or interviews named it
  quotes: Said[]; // newest first, a few
}

export interface ThemeRow {
  theme: Theme;
  label: string;
  calls: number; // how many calls or interviews touched it
  pains: number; // of those, how many with something that hurts
  quotes: Said[]; // newest first, pains first, a few
}

export interface HeardCall {
  id: string;
  kind: 'call' | 'interview';
  label: string;
  atSec: number;
  tools: string[];
  said: Said[];
}

export interface HeardReport {
  heardFrom: number; // calls and interviews with something heard
  of: number; // calls and interviews that reached them
  tools: ToolRow[]; // most named first
  themes: ThemeRow[]; // most touched first, Other last
  calls: HeardCall[]; // newest first, those with something heard
}

const QUOTES = 6;

// `sources` newest first.
export function heardReport(sources: HeardSource[]): HeardReport {
  const read = sources.map((s) => ({ source: s, heard: heardOnCall(s) }));
  const tools = new Map<string, ToolRow>();
  const themes = new Map<Theme, ThemeRow>();
  const calls: HeardCall[] = [];
  for (const { source, heard } of read) {
    for (const t of heard.tools) {
      const row = tools.get(t.name) ?? { name: t.name, calls: 0, quotes: [] };
      row.calls++;
      if (row.quotes.length < QUOTES) row.quotes.push(t.said);
      tools.set(t.name, row);
    }
    const byTheme = (theme: Theme) =>
      heard.said.filter((q) => {
        const hit = (Object.keys(THEME_PATTERNS) as Exclude<Theme, 'other'>[]).filter((t) =>
          THEME_PATTERNS[t].test(q.text)
        );
        return theme === 'other' ? !hit.length : hit.includes(theme);
      });
    for (const theme of heard.themes) {
      const row = themes.get(theme) ?? { theme, label: THEME_LABELS[theme], calls: 0, pains: 0, quotes: [] };
      const quotes = byTheme(theme);
      row.calls++;
      if (quotes.some((q) => q.pain)) row.pains++;
      for (const q of [...quotes].sort((a, b) => Number(b.pain) - Number(a.pain))) {
        if (row.quotes.length < QUOTES) row.quotes.push(q);
      }
      themes.set(theme, row);
    }
    if (heard.tools.length || heard.said.length) {
      calls.push({
        id: source.id,
        kind: source.kind,
        label: source.label,
        atSec: source.atSec,
        tools: heard.tools.map((t) => t.name),
        said: heard.said,
      });
    }
  }
  return {
    heardFrom: calls.length,
    of: sources.length,
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    themes: [...themes.values()].sort((a, b) =>
      a.theme === 'other'
        ? 1
        : b.theme === 'other'
          ? -1
          : b.calls - a.calls || THEMES.indexOf(a.theme) - THEMES.indexOf(b.theme)
    ),
    calls,
  };
}

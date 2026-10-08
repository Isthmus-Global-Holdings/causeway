// The rep's call script: one text shared by every call, shown at the top of
// the call page with the contact's details filled in. Plain text, so what the
// rep wrote is exactly what they read.

export const MAX_SCRIPT = 20_000;

export interface ScriptVars {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  fitReason: string | null;
  myName: string | null;
}

export const SCRIPT_PLACEHOLDERS: { token: string; key: keyof ScriptVars; what: string }[] = [
  { token: '{first_name}', key: 'firstName', what: 'their first name' },
  { token: '{last_name}', key: 'lastName', what: 'their last name' },
  { token: '{name}', key: 'name', what: 'their full name' },
  { token: '{title}', key: 'title', what: 'their job title' },
  { token: '{company}', key: 'company', what: 'their company' },
  { token: '{fit_reason}', key: 'fitReason', what: "why you picked them (the company's Fit: line)" },
  { token: '{my_name}', key: 'myName', what: 'your from name' },
];

// Swaps in the contact's details. A placeholder with no value, or one that
// isn't known, stays as written, so a gap shows instead of vanishing.
export function fillScript(template: string, vars: ScriptVars): string {
  return template.replace(/\{([a-z_]+)\}/gi, (match, name: string) => {
    const known = SCRIPT_PLACEHOLDERS.find((p) => p.token === `{${name.toLowerCase()}}`);
    const value = known ? vars[known.key]?.trim() : null;
    return value || match;
  });
}

export function normalizeScript(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd();
}

// The script cut into its parts for the call page's tabs. A part starts at a
// heading line: words set between rules ("━━━  1 · OPENER  ━━━", "== Close
// ==") or a Markdown heading ("# Close"). Text before the first heading is
// the part with no title, shown above the tabs. Each line keeps its words and
// indentation; its kind is only how it's styled:
//   say      a line to say out loud: it opens with a quote, after any bullet
//   cue      a stage direction: it opens with an arrow or a pause sign
//   subhead  a label in capitals ("THE LAST TIME")
//   text     anything else; blank keeps the rep's spacing.
export type ScriptLineKind = 'say' | 'cue' | 'subhead' | 'text' | 'blank';

export interface ScriptLine {
  kind: ScriptLineKind;
  text: string;
}

export interface ScriptPart {
  number: string | null; // "1" in "1 · OPENER"
  title: string | null;
  lines: ScriptLine[];
}

const RULE_CHARS = '━═─—=_*~';
const RULED_HEADING = new RegExp(`^[${RULE_CHARS}]{2,}\\s*(.*?)\\s*[${RULE_CHARS}]*$`);
const MARKDOWN_HEADING = /^#{1,3}\s+(.+?)\s*#*$/;
const NUMBERED_TITLE = /^(\d{1,2})\s*[·.):-]\s*(.+)$/;
const LIST_MARK = /^(?:[•\-*·]|\d{1,2}[.)])\s+/;
const CUE_MARKS = ['→', '⏸', '▶', '►', '⚠'];

function headingTitle(line: string): string | null {
  const t = line.trim();
  return (RULED_HEADING.exec(t)?.[1] ?? MARKDOWN_HEADING.exec(t)?.[1] ?? null)?.trim() || null;
}

function lineKind(line: string): ScriptLineKind {
  const t = line.trim();
  if (!t) return 'blank';
  if (CUE_MARKS.some((m) => t.startsWith(m))) return 'cue';
  if (/^["“]/.test(t.replace(LIST_MARK, ''))) return 'say';
  // Capitals up to any aside in brackets: "FOLLOW-UP VOICEMAIL (~10 sec)".
  const label = t.split('(')[0];
  if (/[A-Z].*[A-Z]/.test(label) && !/[a-z]/.test(label) && t.length <= 60) return 'subhead';
  return 'text';
}

// Blank lines at either end of a part are dropped; the ones between stay.
function trimBlank(lines: ScriptLine[]): ScriptLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].kind === 'blank') start++;
  while (end > start && lines[end - 1].kind === 'blank') end--;
  return lines.slice(start, end);
}

export function scriptParts(script: string): ScriptPart[] {
  const parts: ScriptPart[] = [{ number: null, title: null, lines: [] }];
  for (const line of normalizeScript(script).split('\n')) {
    const isRule = RULED_HEADING.test(line.trim()) || MARKDOWN_HEADING.test(line.trim());
    const title = isRule ? headingTitle(line) : null;
    if (title) {
      const numbered = NUMBERED_TITLE.exec(title);
      parts.push({ number: numbered?.[1] ?? null, title: numbered?.[2].trim() ?? title, lines: [] });
    } else if (isRule) {
      // A rule with no words is a divider: a blank line.
      parts[parts.length - 1].lines.push({ kind: 'blank', text: '' });
    } else {
      parts[parts.length - 1].lines.push({ kind: lineKind(line), text: line.trimEnd() });
    }
  }
  return parts.map((p) => ({ ...p, lines: trimBlank(p.lines) })).filter((p, i) => i > 0 || p.lines.length > 0);
}

// The app doesn't write email copy. It hands the rep a context bundle to paste
// into Claude, with the house rules for cold outreach attached, then stores
// whatever draft comes back.

// Condensed from the user's mom-test-vfwpa-email and my-writing-style skills,
// so the bundle works even where those skills aren't loaded. When a rule
// changes there, change it here too.
export const CONTENT_RULES = [
  'If the mom-test-vfwpa-email and my-writing-style skills are available, follow them. The rules below are the short version.',
  "Customer-discovery email in the Mom Test style: interview them, don't sell. Never mention the product or idea being built.",
  'Blend Vision → Framing → Weakness → Pedestal → Ask into natural prose. Never label the parts.',
  'Vision: the problem being researched, stated plainly.',
  'Framing: early-stage founder, still researching, nothing to sell. Never call their company or peer group "small".',
  "Weakness: an honest, specific admission of what I don't understand yet, one that invites their expertise.",
  'Pedestal: fold the reasoning a researched fact supports into a plain observation. Don\'t recite the fact as a factoid, and avoid superlative clichés like "more than almost anyone". If the research is thin, say something honest and general instead of inventing specifics or flattering.',
  'Ask: low friction (a short call or a few questions by email) plus a redirect: "or if this is better handled by someone on your team, happy to be pointed their way".',
  'Voice: warm and full, clean grammar, no em-dashes, no semicolons, no AI-isms.',
  "Subject: plain and specific to the real question, without the recipient's name.",
  'Return a Subject line and a Body, nothing else.',
];

export interface DraftContextInput {
  contactName: string;
  contactTitle: string | null;
  contactEmail: string | null;
  companyName: string | null;
  companyDescription: string | null;
  notes: string[];
  existingDraft: string | null;
}

// With rules for pasting into a Claude chat. Without them for the API call,
// where the rules are the system prompt (prompts/draft-system.ts).
export function buildDraftContext(
  input: DraftContextInput,
  opts: { includeRules: boolean } = { includeRules: true }
): string {
  const lines: string[] = [];
  lines.push('Draft a cold outreach email using the context below.', '');
  if (opts.includeRules) {
    lines.push('Rules:');
    for (const rule of CONTENT_RULES) lines.push(`- ${rule}`);
    lines.push('');
  }
  lines.push('## Recipient');
  lines.push(`Name: ${input.contactName}`);
  if (input.contactTitle) lines.push(`Title: ${input.contactTitle}`);
  if (input.contactEmail) lines.push(`Email: ${input.contactEmail}`);
  lines.push('', `## Company: ${input.companyName ?? '(no company on record)'}`);
  lines.push(input.companyDescription?.trim() || '(no description)');
  lines.push('', '## Notes on this person');
  if (input.notes.length === 0) lines.push('(none)');
  for (const note of input.notes) lines.push(`- ${note.replace(/\n+/g, ' ')}`);
  if (input.existingDraft) {
    lines.push('', '## Previous draft (revise rather than start over unless told otherwise)');
    lines.push(input.existingDraft);
  }
  return lines.join('\n');
}

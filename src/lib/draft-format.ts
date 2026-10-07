// Parses Claude's draft reply. Web search returns citations, and citations
// can't be combined with JSON structured outputs, so the reply uses tags.

export interface ParsedDraft {
  subject: string;
  body: string;
  research: string | null;
}

function lastTag(text: string, tag: string): string | null {
  // The last occurrence wins: the model may quote a tag while reasoning
  // before writing the final blocks.
  const matches = [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))];
  const last = matches.at(-1);
  return last ? last[1].trim() : null;
}

export function parseDraftResponse(text: string): ParsedDraft {
  const subject = lastTag(text, 'subject');
  const body = lastTag(text, 'body');
  if (!subject || !body) {
    throw new Error('Claude replied without a <subject> and <body>. Try again, or write the draft by hand.');
  }
  return { subject: subject.replace(/\s+/g, ' '), body, research: lastTag(text, 'research') };
}

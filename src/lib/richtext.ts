// hs_task_body is rendered by HubSpot as rich text: a plain "\n" collapses and
// the whole draft shows as one unbroken block. Line breaks must be <br> tags.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
}

export function toTaskBodyHtml(subject: string, body: string): string {
  return `Subject: ${escapeHtml(subject.trim())}<br><br>${textToHtml(body.trim())}`;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

// For showing HubSpot rich text (task bodies, notes) as plain text in our pages.
export function htmlToText(html: string): string {
  // Drafts written before this app (via the API with plain "\n") contain no
  // tags at all. Their newlines are the only structure, so keep them.
  if (!/<[a-z!/][^>]*>/i.test(html)) {
    return decodeEntities(html.replace(/\r\n?/g, '\n')).trim();
  }
  const withBreaks = html
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Reverses toTaskBodyHtml so a saved draft can be edited in the form again.
// Returns null when the body wasn't written in our "Subject: …" shape.
export function parseTaskBody(html: string): { subject: string; body: string } | null {
  const text = htmlToText(html);
  const match = /^Subject:[ \t]*(.*)\n\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  return { subject: match[1].trim(), body: match[2] };
}

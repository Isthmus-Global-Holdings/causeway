// Turns a stored draft plus the rep's signature into the email that gets sent.

import { htmlToText, textToHtml } from './richtext';

export interface ComposedEmail {
  subject: string;
  html: string; // what the recipient sees, before tracking is added
  text: string; // plain-text alternative
}

// Minimal markup on purpose: formatted cold email tends to land in spam more,
// so the HTML part is shaped like a message typed in Gmail. No fonts, colours
// or inline styles, just line breaks, with a blank line between paragraphs.
function bodyToHtml(body: string): string {
  return textToHtml(body.replace(/\r\n?/g, '\n').trim());
}

// Bare URLs in a plain-text signature become links, as Gmail would show them.
// Trailing punctuation stays outside the link.
function linkify(escapedHtml: string): string {
  return escapedHtml.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (url) => `<a href="${url}">${url}</a>`);
}

// The signature on /settings can be pasted as HTML (from HubSpot's source
// view) or as plain text. Plain text keeps its line breaks.
export function signatureToHtml(signature: string | null): string {
  const s = signature?.trim() ?? '';
  if (!s) return '';
  if (/<[a-z][^>]*>/i.test(s)) return s;
  return linkify(textToHtml(s));
}

const WRAPPER_START = '<div dir="ltr">';

export function composeEmail(subject: string, body: string, signatureRaw: string | null): ComposedEmail {
  const signature = signatureToHtml(signatureRaw);
  const html = WRAPPER_START + bodyToHtml(body) + (signature ? `<br><br>${signature}` : '') + `</div>`;
  const text = body.trim() + (signature ? `\n\n${htmlToText(signature)}` : '');
  return { subject: subject.trim(), html, text };
}

// The signature alone, exactly as it appears at the end of an email.
export function signaturePreviewHtml(signatureRaw: string | null): string {
  return `${WRAPPER_START}${signatureToHtml(signatureRaw)}</div>`;
}

// For the preview page's <iframe srcdoc>: the email as a standalone document.
export function previewDocument(html: string): string {
  // The font here is only the preview's stand-in for a mail app's default.
  // It isn't part of the email.
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px">${html}</body></html>`;
}

// Words and punctuation the rep's voice rules never use. Shown as warnings on
// the preview, not enforced: the rep decides.
export function voiceWarnings(subject: string, body: string): string[] {
  const text = `${subject}\n${body}`;
  const warnings: string[] = [];
  if (text.includes('—')) warnings.push('Contains an em-dash (—).');
  if (text.includes(';')) warnings.push('Contains a semicolon.');
  if (/\bsmall\b/i.test(text)) warnings.push('Uses the word "small".');
  return warnings;
}

// Notes left for the rep inside the body, like "[Note: verify the role]" or
// "(Note to self: …)". Nothing strips them, so they'd reach the prospect.
const PRIVATE_NOTE = /[[(]\s*note\b[^\])]*[\])]?|^[ \t]*note( to self)?\s*:.*$/gim;

export function privateNotes(body: string): string[] {
  return (body.match(PRIVATE_NOTE) ?? []).map((note) => note.trim());
}

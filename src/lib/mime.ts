// Builds the RFC 5322 message handed to Gmail's send API. Pure, so the exact
// bytes a recipient gets can be unit tested.

export interface Mailbox {
  email: string;
  name?: string | null;
}

export interface MimeInput {
  from: Mailbox;
  to: Mailbox;
  subject: string;
  html: string;
  text: string;
  messageId: string; // "<…@…>"
  date: Date;
  boundary: string; // injected so tests are deterministic
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Header values must be 7-bit. Non-ASCII (accents in a name, a curly quote
// in a subject) goes out as an RFC 2047 encoded-word.
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${utf8Base64(value)}?=`;
}

function formatMailbox({ email, name }: Mailbox): string {
  if (!name) return `<${email}>`;
  // ASCII names are quoted; encoded-words must not be.
  const display = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeHeaderValue(name);
  return `${display} <${email}>`;
}

function wrap76(base64: string): string {
  return base64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

export function buildMime(input: MimeInput): string {
  const b = input.boundary;
  return [
    `From: ${formatMailbox(input.from)}`,
    `To: ${formatMailbox(input.to)}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8Base64(input.text)),
    `--${b}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8Base64(input.html)),
    `--${b}--`,
    '',
  ].join('\r\n');
}

// Gmail's messages.send takes the whole message as base64url.
export function base64UrlEncode(text: string): string {
  return utf8Base64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64UrlEncode, buildMime, encodeHeaderValue } from '../src/lib/mime.ts';

const decode = (b64: string) => Buffer.from(b64.replace(/\r\n/g, ''), 'base64').toString('utf8');

const mime = buildMime({
  from: { email: 'isthmusglobalholdings@gmail.com', name: 'Anel Canto' },
  to: { email: 'ana@example.com', name: 'Ana Díaz' },
  subject: 'Quick question about how Acme handles quoting & invoicing',
  html: '<p>Hi Ana,</p><p>Qué tal</p>',
  text: 'Hi Ana,\n\nQué tal',
  messageId: '<hsa.1.abc@causeway>',
  date: new Date('2026-09-25T15:00:00Z'),
  boundary: 'b1',
});

test('headers: ASCII name quoted, non-ASCII name encoded, CRLF line endings', () => {
  assert.match(mime, /^From: "Anel Canto" <isthmusglobalholdings@gmail\.com>\r\n/);
  assert.match(mime, /\r\nTo: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <ana@example\.com>\r\n/);
  assert.match(mime, /\r\nSubject: Quick question about how Acme handles quoting & invoicing\r\n/);
  assert.match(mime, /\r\nMessage-ID: <hsa\.1\.abc@causeway>\r\n/);
  assert.match(mime, /\r\nContent-Type: multipart\/alternative; boundary="b1"\r\n/);
  assert.ok(!/[^\r]\n/.test(mime), 'every newline is CRLF');
});

test('both parts decode back to the exact UTF-8 content', () => {
  const parts = mime.split('--b1');
  const body = (part: string) => decode(part.split('\r\n\r\n')[1]);
  assert.equal(body(parts[1]), 'Hi Ana,\n\nQué tal');
  assert.equal(body(parts[2]), '<p>Hi Ana,</p><p>Qué tal</p>');
  assert.ok(mime.trimEnd().endsWith('--b1--'));
});

test('non-ASCII subjects become RFC 2047 encoded-words that round-trip', () => {
  const encoded = encodeHeaderValue('Pregunta rápida');
  assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
  assert.equal(decode(encoded.slice(10, -2)), 'Pregunta rápida');
});

test('base64url has no +, / or padding', () => {
  const out = base64UrlEncode('ÿÿÿ>>>???');
  assert.ok(!/[+/=]/.test(out));
  assert.equal(Buffer.from(out, 'base64url').toString('utf8'), 'ÿÿÿ>>>???');
});

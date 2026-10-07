import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decrypt, encrypt } from '../src/lib/secretbox.ts';

const key = Buffer.alloc(32, 7).toString('base64');

test('round-trips, and each encryption uses a fresh IV', async () => {
  const a = await encrypt('1//refresh-token', key);
  const b = await encrypt('1//refresh-token', key);
  assert.notEqual(a, b);
  assert.equal(await decrypt(a, key), '1//refresh-token');
});

test('a different key or a tampered value fails', async () => {
  const sealed = await encrypt('secret', key);
  await assert.rejects(decrypt(sealed, Buffer.alloc(32, 8).toString('base64')));
  const [iv, cipher] = sealed.split('.');
  const flipped = Buffer.from(cipher, 'base64');
  flipped[0] ^= 1;
  await assert.rejects(decrypt(`${iv}.${flipped.toString('base64')}`, key));
});

test('rejects keys that are not 32 bytes', async () => {
  await assert.rejects(encrypt('x', Buffer.alloc(16).toString('base64')), /32 bytes/);
});

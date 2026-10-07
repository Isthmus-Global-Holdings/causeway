// The sign-in gate. Tokens here are signed with a real RSA key generated per
// run, the same way Cloudflare Access signs them, and go through the actual
// middleware on a Hono app.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Hono } from 'hono';
import { accessAuth, verifyAccessJwt, type Jwk } from '../src/middleware/access.ts';
import type { AppEnv } from '../src/types.ts';

const TEAM = 'team-test.cloudflareaccess.com';
const AUD = 'aud-123';
const NOW = Date.parse('2026-09-25T12:00:00Z');
const APP = 'https://app.example';

let privateKey: CryptoKey;
let jwks: Jwk[];
const realFetch = globalThis.fetch;

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? bytes : Buffer.from(bytes)).toString('base64url');

async function sign(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }
): Promise<string> {
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

const goodClaims = (overrides: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  email: 'rep@example.com',
  exp: Math.floor(NOW / 1000) + 3600,
  ...overrides,
});

const deps = { keys: async () => jwks, now: () => NOW };

before(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  jwks = [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' } as Jwk];
  // The middleware fetches the team's certs itself; serve our key.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: jwks });
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

// --- verifyAccessJwt ---

test('accepts a token signed by the team for this app', async () => {
  const claims = await verifyAccessJwt(await sign(goodClaims()), TEAM, AUD, deps);
  assert.equal(claims?.email, 'rep@example.com');
});

test('rejects wrong audience, wrong issuer, and expired tokens', async () => {
  assert.equal(await verifyAccessJwt(await sign(goodClaims({ aud: ['other-app'] })), TEAM, AUD, deps), null);
  assert.equal(
    await verifyAccessJwt(await sign(goodClaims({ iss: 'https://evil.cloudflareaccess.com' })), TEAM, AUD, deps),
    null
  );
  assert.equal(
    await verifyAccessJwt(await sign(goodClaims({ exp: Math.floor(NOW / 1000) - 1 })), TEAM, AUD, deps),
    null
  );
  assert.equal(await verifyAccessJwt(await sign(goodClaims({ exp: undefined })), TEAM, AUD, deps), null);
});

test('rejects a tampered payload and a token signed by another key', async () => {
  const token = await sign(goodClaims());
  const [h, , s] = token.split('.');
  const forged = `${h}.${b64url(JSON.stringify(goodClaims({ email: 'attacker@example.com' })))}.${s}`;
  assert.equal(await verifyAccessJwt(forged, TEAM, AUD, deps), null);

  const other = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign']
  )) as CryptoKeyPair;
  const saved = privateKey;
  privateKey = other.privateKey;
  const wrongKey = await sign(goodClaims());
  privateKey = saved;
  assert.equal(await verifyAccessJwt(wrongKey, TEAM, AUD, deps), null);
});

test('rejects non-RS256 algorithms, unknown key ids and malformed tokens', async () => {
  assert.equal(await verifyAccessJwt(await sign(goodClaims(), { alg: 'none', kid: 'k1' }), TEAM, AUD, deps), null);
  assert.equal(await verifyAccessJwt(await sign(goodClaims(), { alg: 'HS256', kid: 'k1' }), TEAM, AUD, deps), null);
  let refetched = false;
  const unknownKid = await verifyAccessJwt(await sign(goodClaims(), { alg: 'RS256', kid: 'nope' }), TEAM, AUD, {
    keys: async (_team, force) => {
      if (force) refetched = true;
      return jwks;
    },
    now: () => NOW,
  });
  assert.equal(unknownKid, null);
  assert.ok(refetched, 'an unknown kid triggers one fresh key fetch (key rotation)');
  for (const junk of ['', 'a.b.c', 'not-a-jwt', '!!!.@@@.###']) {
    assert.equal(await verifyAccessJwt(junk, TEAM, AUD, deps), null);
  }
});

// --- the middleware on a real Hono app ---

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', accessAuth);
  a.get('/', (c) => c.text(c.get('actor')));
  a.post('/tasks/1/send', (c) => c.text(`sent by ${c.get('actor')}`));
  a.get('/t/o/:token', (c) => c.text('pixel'));
  a.post('/twilio/voice/answer', (c) => c.text('twiml'));
  a.get('/calls', (c) => c.text('calls'));
  a.post('/pitches', (c) => c.text(`pitched by ${c.get('actor')}`));
  return a;
}

const env = (overrides: Record<string, string> = {}) =>
  ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...overrides }) as unknown as AppEnv['Bindings'];

// The middleware checks expiry against the real clock, so use a token that's
// valid now.
const liveToken = () => sign(goodClaims({ exp: Math.floor(Date.now() / 1000) + 3600 }));

test('no token → 401; valid token → the rep is let in and identified', async () => {
  assert.equal((await app().request(`${APP}/`, {}, env())).status, 401);
  const res = await app().request(`${APP}/`, { headers: { 'Cf-Access-Jwt-Assertion': await liveToken() } }, env());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'rep@example.com');
});

test('fails closed when Access is not configured', async () => {
  const res = await app().request(
    `${APP}/`,
    { headers: { 'Cf-Access-Jwt-Assertion': await liveToken() } },
    env({ ACCESS_AUD: '' })
  );
  assert.equal(res.status, 500);
});

test('POSTs must come from the app itself, even with a valid token', async () => {
  const headers = { 'Cf-Access-Jwt-Assertion': await liveToken() };
  const post = (extra: Record<string, string>) =>
    app().request(`${APP}/tasks/1/send`, { method: 'POST', headers: { ...headers, ...extra } }, env());
  assert.equal((await post({})).status, 403, 'no Origin');
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403, 'other origin');
  const ok = await post({ Origin: APP });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'sent by rep@example.com');
});

test('the Upwork pitch extension may POST /pitches, and nothing else', async () => {
  const extension = 'chrome-extension://ddbojhokkfndnhnngibgnilicbeghkof';
  const headers = { 'Cf-Access-Jwt-Assertion': await liveToken() };
  const post = (path: string, origin: string, overrides: Record<string, string> = {}) =>
    app().request(
      `${APP}${path}`,
      { method: 'POST', headers: { ...headers, Origin: origin } },
      env({ PITCH_EXTENSION_ID: 'ddbojhokkfndnhnngibgnilicbeghkof', ...overrides })
    );
  const ok = await post('/pitches', extension);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'pitched by rep@example.com', 'still signed in through Access');
  assert.equal((await post('/tasks/1/send', extension)).status, 403, 'only /pitches');
  assert.equal((await post('/pitches', 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh')).status, 403);
  assert.equal((await post('/pitches', 'https://evil.example')).status, 403);
  assert.equal((await post('/pitches', extension, { PITCH_EXTENSION_ID: '' })).status, 403, 'unset: none');
  assert.equal((await post('/pitches', 'chrome-extension://', { PITCH_EXTENSION_ID: '' })).status, 403);
});

test('tracking routes are public; everything else is not', async () => {
  assert.equal((await app().request(`${APP}/t/o/abc`, {}, env())).status, 200);
  assert.equal(
    (await app().request(`${APP}/tasks/1/send`, { method: 'POST', headers: { Origin: APP } }, env())).status,
    401
  );
});

test('Twilio webhooks skip Access (they check their own signature); /calls does not', async () => {
  // Twilio posts from its own servers: no Access cookie and no Origin header.
  const hook = await app().request(`${APP}/twilio/voice/answer`, { method: 'POST' }, env());
  assert.equal(hook.status, 200);
  assert.equal((await app().request(`${APP}/calls`, {}, env())).status, 401);
  assert.equal((await app().request(`${APP}/twiliox`, {}, env())).status, 401, 'only the /twilio/ prefix');
});

test('the dev bypass only works on localhost', async () => {
  const bypass = env({ DEV_BYPASS_ACCESS: 'true' });
  const local = await app().request('http://localhost:8787/', {}, bypass);
  assert.equal(local.status, 200);
  assert.equal(await local.text(), 'dev@localhost');
  assert.equal((await app().request(`${APP}/`, {}, bypass)).status, 401, 'ignored on the real host');
});

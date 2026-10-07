// Cloudflare Access sits in front of this Worker and only lets the reps'
// identities through. This middleware checks the JWT Access attaches as well,
// so the app stays closed if Access is ever switched off or bypassed (e.g. a
// request straight to the workers.dev URL).
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

export interface Jwk extends JsonWebKey {
  kid: string;
}

export interface AccessClaims {
  aud: string | string[];
  email?: string;
  exp: number;
  iss: string;
}

// Keys rotate rarely; refetch at most every 10 minutes, or sooner if a token
// names a kid we haven't seen.
const KEY_CACHE_MS = 10 * 60 * 1000;
const keyCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

async function signingKeys(teamDomain: string, force: boolean): Promise<Jwk[]> {
  const cached = keyCache.get(teamDomain);
  if (cached && !force && Date.now() - cached.fetchedAt < KEY_CACHE_MS) return cached.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  keyCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

function base64UrlDecode(segment: string): Uint8Array {
  const base64 = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
}

export interface VerifyDeps {
  // Signing keys for the team. Defaults to Cloudflare's certs endpoint (cached).
  keys?: (teamDomain: string, force: boolean) => Promise<Jwk[]>;
  now?: () => number; // epoch ms
}

// Returns the claims only if the token is an RS256 JWT signed by one of the
// team's keys, for this app's audience, from this team, and not expired.
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
  deps: VerifyDeps = {}
): Promise<AccessClaims | null> {
  const keysFor = deps.keys ?? signingKeys;
  const now = deps.now ?? Date.now;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  let header: { alg: string; kid: string };
  try {
    header = decodeJson(headerSeg);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  let jwk = (await keysFor(teamDomain, false)).find((k) => k.kid === header.kid);
  jwk ??= (await keysFor(teamDomain, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(signatureSeg),
    new TextEncoder().encode(`${headerSeg}.${payloadSeg}`)
  );
  if (!valid) return null;

  let claims: AccessClaims;
  try {
    claims = decodeJson(payloadSeg);
  } catch {
    return null;
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return null;
  if (claims.iss !== `https://${teamDomain}`) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now()) return null;
  return claims;
}

function isLocalhost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

export const accessAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Open/click tracking is hit by recipients' mail clients, who can't sign in.
  // Those routes only answer to random tokens (routes/tracking.ts), and the
  // Cloudflare Access application needs a matching Bypass policy for /t/*.
  // Twilio's webhooks can't sign in either. routes/twilio.ts checks each one's
  // X-Twilio-Signature instead, and Access needs a Bypass policy for /twilio/*.
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/t/') || path.startsWith('/twilio/')) return next();

  // Forms post back to this app only. Rejecting other origins stops a page
  // elsewhere from submitting to it with the rep's Access cookie attached.
  // The one exception is the Upwork pitch extension (extension/), whose
  // origin is pinned by the key in its manifest, and only on /pitches.
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    const extension = c.env.PITCH_EXTENSION_ID ? `chrome-extension://${c.env.PITCH_EXTENSION_ID}` : null;
    const allowed = origin === new URL(c.req.url).origin || (path === '/pitches' && origin === extension);
    if (!allowed) return c.text('Cross-origin request refused', 403);
  }

  if (c.env.DEV_BYPASS_ACCESS === 'true' && isLocalhost(c.req.url)) {
    c.set('actor', 'dev@localhost');
    return next();
  }

  const { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience } = c.env;
  if (!teamDomain || !audience) {
    return c.text('Cloudflare Access is not configured for this Worker (ACCESS_TEAM_DOMAIN / ACCESS_AUD).', 500);
  }

  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return c.text('Unauthorized', 401);

  let claims: AccessClaims | null = null;
  try {
    claims = await verifyAccessJwt(token, teamDomain, audience);
  } catch (err) {
    console.error('Access JWT verification error', err);
  }
  if (!claims?.email) return c.text('Unauthorized', 401);

  c.set('actor', claims.email);
  return next();
};

// The access token the call page's Twilio Voice SDK signs in with, so the rep
// can call from the browser. It's a JWT signed (HS256) with an API key's
// secret, and grants only outgoing calls through the app's TwiML App, whose
// Voice URL (/twilio/voice/client) decides what the call does. No SDK: it's
// one HMAC. https://www.twilio.com/docs/iam/access-tokens

export interface VoiceTokenOptions {
  accountSid: string; // AC…
  apiKeySid: string; // SK…
  apiKeySecret: string;
  appSid: string; // AP…, the TwiML App
  identity: string; // who the browser is to Twilio; only letters, digits and _
  nowSec: number;
  ttlSec: number;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encodePart(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

// Twilio client identities: letters, digits and underscores only.
export function clientIdentity(actor: string): string {
  return actor.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 121) || 'rep';
}

export async function voiceAccessToken(o: VoiceTokenOptions): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const claims = {
    jti: `${o.apiKeySid}-${o.nowSec}`,
    iss: o.apiKeySid,
    sub: o.accountSid,
    iat: o.nowSec,
    exp: o.nowSec + o.ttlSec,
    grants: {
      identity: o.identity,
      voice: { outgoing: { application_sid: o.appSid } },
    },
  };
  const signingInput = `${encodePart(header)}.${encodePart(claims)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(o.apiKeySecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64url(mac)}`;
}

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { clientIdentity, voiceAccessToken } from '../src/lib/voice-token.ts';

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('the token is an HS256 JWT signed with the API key secret, granting outgoing calls through the TwiML App', async () => {
  const token = await voiceAccessToken({
    accountSid: 'AC1',
    apiKeySid: 'SK1',
    apiKeySecret: 'shh',
    appSid: 'AP1',
    identity: 'ana_example_com',
    nowSec: 1_790_000_000,
    ttlSec: 3600,
  });
  const [header, claims, signature] = token.split('.');
  assert.deepEqual(decode(header), { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' });
  assert.deepEqual(decode(claims), {
    jti: 'SK1-1790000000',
    iss: 'SK1',
    sub: 'AC1',
    iat: 1_790_000_000,
    exp: 1_790_003_600,
    grants: { identity: 'ana_example_com', voice: { outgoing: { application_sid: 'AP1' } } },
  });
  const expected = createHmac('sha256', 'shh').update(`${header}.${claims}`).digest('base64url');
  assert.equal(signature, expected);
});

test('client identities keep only letters, digits and underscores', () => {
  assert.equal(clientIdentity('ana.díaz@example.com'), 'ana_d_az_example_com');
  assert.equal(clientIdentity(''), 'rep');
});

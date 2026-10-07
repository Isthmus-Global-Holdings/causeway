import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError } from '../src/lib/errors.ts';
import { accessToken, GoogleApiError, GoogleConnectionExpiredError, withAccessToken } from '../src/lib/google.ts';

const CFG = { clientId: 'client', clientSecret: 'secret' };

// Google's token endpoint, answering a new token each time.
async function withTokenEndpoint(run: (refreshes: () => number) => Promise<void>) {
  let count = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    count += 1;
    return Response.json({ access_token: `access-${count}`, expires_in: 3600 });
  }) as unknown as typeof fetch;
  try {
    await run(() => count);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('an access token is reused until a minute before it expires', async () => {
  await withTokenEndpoint(async (refreshes) => {
    let now = 1_000_000;
    const clock = () => now;
    assert.equal(await accessToken('refresh-a', CFG, clock), 'access-1');
    now += 58 * 60_000;
    assert.equal(await accessToken('refresh-a', CFG, clock), 'access-1');
    assert.equal(refreshes(), 1);
    now += 60_000; // 59 minutes in: within the last minute
    assert.equal(await accessToken('refresh-a', CFG, clock), 'access-2');
    assert.equal(await accessToken('refresh-b', CFG, clock), 'access-3', 'another account has its own');
  });
});

test('a token Google refuses is replaced and the call made once more', async () => {
  await withTokenEndpoint(async (refreshes) => {
    const used: string[] = [];
    const result = await withAccessToken('refresh-c', CFG, async (token) => {
      used.push(token);
      if (used.length === 1) throw new GoogleApiError(401, 'invalid credentials', 'send');
      return 'sent';
    });
    assert.equal(result, 'sent');
    assert.deepEqual(used, ['access-1', 'access-2']);
    assert.equal(refreshes(), 2);
  });
});

test('other errors are not retried', async () => {
  await withTokenEndpoint(async () => {
    let calls = 0;
    await assert.rejects(
      withAccessToken('refresh-d', CFG, async () => {
        calls += 1;
        throw new GoogleApiError(500, 'backend error', 'send');
      }),
      GoogleApiError
    );
    assert.equal(calls, 1, 'a 5xx may have sent: never repeat it');
  });
});

test('a refresh token Google expired or revoked says to reconnect, and the call is never made', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      { status: 400 }
    )) as unknown as typeof fetch;
  try {
    let calls = 0;
    const err = await withAccessToken('refresh-e', CFG, async () => {
      calls += 1;
      return 'sent';
    }).catch((e: unknown) => e);
    assert.ok(err instanceof GoogleConnectionExpiredError);
    assert.ok(err instanceof GoogleApiError, 'still a 4xx from Google: a send knows nothing went out');
    assert.match(err.message, /Reconnect Gmail in Settings/);
    assert.equal(calls, 0);
    assert.equal(describeError(err).title, 'Google connection expired');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an API turned off in the Cloud project says to enable it, with Google’s link', () => {
  const body = JSON.stringify({
    error: {
      code: 403,
      message:
        'Google Calendar API has not been used in project 252643501861 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=252643501861 then retry.',
      status: 'PERMISSION_DENIED',
      details: [{ reason: 'SERVICE_DISABLED' }],
    },
  });
  const err = new GoogleApiError(403, body, 'calendar');
  assert.ok(err.apiDisabled);
  assert.match(
    err.message,
    /Google Calendar API is turned off .* at https:\/\/console\.developers\.google\.com\/apis\/api\/calendar-json\.googleapis\.com\/overview\?project=252643501861,/
  );
  assert.equal(describeError(err).title, 'Google API turned off');
  assert.ok(!new GoogleApiError(403, '{"error":{"status":"PERMISSION_DENIED"}}', 'calendar').apiDisabled);
});

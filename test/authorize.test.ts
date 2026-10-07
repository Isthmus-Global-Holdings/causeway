// Approving the Claude connector: GET/POST /authorize behind Access, with a
// stand-in for the OAuth provider's helpers (the real ones need Workers).

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { allowedRedirect } from '../src/routes/authorize.ts';
import type { AppEnv } from '../src/types.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const BASE = 'http://localhost';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
let db: D1Database;
let calls: { method: string; args: unknown[] }[];
let redirectUri: string;
let parseError: Error | null;

class AuthorizationError extends Error {
  override name = 'AuthorizationError';
  constructor(
    readonly description: string,
    readonly redirectTo?: string
  ) {
    super(description);
  }
}

beforeEach(() => {
  db = sqliteD1();
  calls = [];
  redirectUri = CLAUDE;
  parseError = null;
});

function oauth() {
  const record =
    (method: string, answer: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return answer(...args);
    };
  const request = () => ({ clientId: 'c1', redirectUri, scope: [], state: 's', responseType: 'code' });
  return {
    parseAuthRequest: record('parseAuthRequest', () => {
      if (parseError) throw parseError;
      return request();
    }),
    describeConsent: record('describeConsent', () => ({
      clientId: 'c1',
      clientName: 'Claude <script>',
      redirectUri,
      redirectHost: new URL(redirectUri).hostname,
      redirectIsLoopback: false,
      scope: [],
    })),
    beginConsent: record('beginConsent', () => ({
      handle: 'h1',
      headers: new Headers({ 'Set-Cookie': '__Host-oauth-consent-h1=x; Secure; Path=/', 'X-Frame-Options': 'DENY' }),
    })),
    approveConsent: record('approveConsent', () => ({ request: request(), headers: new Headers() })),
    denyConsent: record('denyConsent', () => ({
      request: request(),
      redirectTo: `${redirectUri}?error=access_denied`,
      headers: new Headers({ Location: `${redirectUri}?error=access_denied` }),
    })),
    lookupClient: record('lookupClient', () => ({ clientId: 'c1', clientName: 'Claude', redirectUris: [CLAUDE] })),
    completeAuthorization: record('completeAuthorization', () => ({ redirectTo: `${CLAUDE}?code=abc&state=s` })),
    listUserGrants: record('listUserGrants', () => ({
      items: [
        {
          id: 'g1',
          clientId: 'c1',
          userId: 'dev@localhost',
          scope: [],
          metadata: { label: 'Claude' },
          createdAt: 1790640000,
        },
      ],
    })),
    revokeGrant: record('revokeGrant', () => undefined),
  };
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const { default: app } = await import('../src/index.ts');
  return app.request(
    `${BASE}${path}`,
    { ...init, headers: { Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded', ...init.headers } },
    {
      DB: db,
      DEV_BYPASS_ACCESS: 'true',
      TZ: 'America/Panama',
      OAUTH_PROVIDER: oauth(),
    } as unknown as AppEnv['Bindings']
  );
}

const approve = (decision = 'approve') =>
  request('/authorize', { method: 'POST', body: new URLSearchParams({ handle: 'h1', decision }) });

test('only Claude’s callback may receive a token, and a local app only on localhost', () => {
  assert.equal(allowedRedirect(CLAUDE, false), true);
  assert.equal(allowedRedirect('https://claude.com/api/mcp/auth_callback', false), true);
  assert.equal(allowedRedirect('https://evil.example/api/mcp/auth_callback', false), false);
  assert.equal(allowedRedirect('http://localhost:6274/oauth/callback', false), false);
  assert.equal(allowedRedirect('http://localhost:6274/oauth/callback', true), true);
  assert.equal(allowedRedirect('https://localhost.evil.example/cb', true), false);
});

test('the consent page names the client (escaped), where access goes, and the rep', async () => {
  const res = await request('/authorize?response_type=code&client_id=c1');
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /Connect Claude &lt;script&gt;\?/);
  assert.match(page, /claude\.ai/);
  assert.match(page, /dev@localhost/);
  assert.match(page, /name="handle" value="h1"/);
  assert.match(res.headers.get('Set-Cookie') ?? '', /__Host-oauth-consent-h1/);
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
});

test('a request whose tokens would go anywhere but Claude is refused before any consent starts', async () => {
  redirectUri = 'https://evil.example/cb';
  const res = await request('/authorize?response_type=code&client_id=c1');
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Only Claude can connect/);
  assert.ok(!calls.some((c) => c.method === 'beginConsent'));
});

test('approving completes the authorization as the rep, audits it, and returns to Claude', async () => {
  const res = await approve();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `${CLAUDE}?code=abc&state=s`);
  const complete = calls.find((c) => c.method === 'completeAuthorization');
  const options = complete?.args[0] as { userId: string; props: unknown };
  assert.equal(options.userId, 'dev@localhost');
  assert.deepEqual(options.props, { actor: 'dev@localhost' });
  const audit = await db.prepare(`SELECT actor, workflow, action FROM audit_log`).all();
  assert.deepEqual(
    audit.results.map((r) => ({ ...r })),
    [{ actor: 'dev@localhost', workflow: 'connector', action: 'approve Claude connector' }]
  );
});

test('cancelling sends Claude an access_denied, and grants nothing', async () => {
  const res = await approve('deny');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `${CLAUDE}?error=access_denied`);
  assert.ok(!calls.some((c) => c.method === 'completeAuthorization'));
});

test('a form posted from another site is refused before it reaches the provider', async () => {
  const res = await request('/authorize', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: new URLSearchParams({ handle: 'h1', decision: 'approve' }),
  });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('the provider’s errors go back to Claude only when it says where; otherwise they show here', async () => {
  parseError = new AuthorizationError('Bad scope.', `${CLAUDE}?error=invalid_scope`);
  const back = await request('/authorize?response_type=code&client_id=c1');
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('Location'), `${CLAUDE}?error=invalid_scope`);

  parseError = new AuthorizationError('Unknown client.');
  const here = await request('/authorize?response_type=code&client_id=nope');
  assert.equal(here.status, 400);
  assert.match(await here.text(), /Unknown client\. Start connecting again from Claude\./);
});

test('Settings shows the connector URL to add in Claude, and the connections approved', async () => {
  const res = await request('/settings');
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /value="http:\/\/localhost\/mcp"/);
  assert.match(page, /Add custom connector/);
  assert.match(page, /<td>Claude<\/td>/);
  assert.match(page, /name="grant_id" value="g1"/);
  assert.deepEqual(calls.find((c) => c.method === 'listUserGrants')?.args, ['dev@localhost']);
});

test('disconnecting revokes that connection for the rep, and audits it', async () => {
  const res = await request('/settings/connector/disconnect', {
    method: 'POST',
    body: new URLSearchParams({ grant_id: 'g1' }),
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), '/settings?connector=disconnected');
  assert.deepEqual(calls.find((c) => c.method === 'revokeGrant')?.args, ['g1', 'dev@localhost']);
  const audit = await db.prepare(`SELECT action FROM audit_log`).all<{ action: string }>();
  assert.deepEqual(
    audit.results.map((r) => r.action),
    ['disconnect Claude connector']
  );
});

test('Claude still gets its code when the approval can’t be audited', async () => {
  await db.prepare('DROP TABLE audit_log').run();
  const res = await approve();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `${CLAUDE}?code=abc&state=s`);
});

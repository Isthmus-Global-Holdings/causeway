// GET/POST /authorize — the rep approves the Claude connector. This is the
// OAuth authorization page for OAuthProvider (src/worker.ts): claude.ai sends
// the rep's browser here, Cloudflare Access signs them in as for any page,
// and approving hands claude.ai a token that acts as that rep on /mcp.
// The provider keeps the request server-side between the two steps; the form
// only carries a one-time handle bound to this browser.

import type { AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { Hono, type Context } from 'hono';
import { insertAudit } from '../lib/db';
import type { ConnectorProps } from '../mcp/app';
import type { AppEnv } from '../types';
import { consentPage } from '../views/authorize';
import { errorPage } from '../views/layout';

export const authorizeRoute = new Hono<AppEnv>();

// Where a connector's tokens may go: Claude's own callback. On localhost
// (local dev, where Access is bypassed) also a local app such as the MCP
// Inspector.
export const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

export function isLocalRequest(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

export function allowedRedirect(uri: string, local: boolean): boolean {
  if (CLAUDE_CALLBACKS.includes(uri)) return true;
  if (!local) return false;
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

const REFUSED = 'Only Claude can connect to this app. This request came from somewhere else, so nothing was approved.';

function withHeaders(res: Response, headers: Headers): Response {
  for (const [key, value] of headers) res.headers.append(key, value);
  return res;
}

// The provider's module only loads on Workers (it imports cloudflare:workers),
// so its errors are told apart by name, and the app still runs in the tests.
function isAuthorizationError(err: unknown): err is AuthorizationError {
  return err instanceof Error && err.name === 'AuthorizationError';
}

// An error the provider raised about the request. It goes back to the
// client only once the client and its redirect were checked (the error says
// where); otherwise it's shown here. Anything else is a bug or an outage.
function authorizationFailure(c: Context<AppEnv>, err: unknown): Response | Promise<Response> {
  if (isAuthorizationError(err) && err.redirectTo) return c.redirect(err.redirectTo, 302);
  if (isAuthorizationError(err)) {
    return c.html(
      errorPage('Can’t connect', `${err.description} Start connecting again from Claude.`, c.get('actor')),
      400
    );
  }
  if (err instanceof Error && err.name === 'CimdFetchError') {
    return c.html(errorPage('Can’t connect', 'The app asking to connect couldn’t be verified.', c.get('actor')), 400);
  }
  throw err;
}

authorizeRoute.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  const actor = c.get('actor');
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    if (!allowedRedirect(request.redirectUri, isLocalRequest(c.req.url))) {
      return await c.html(errorPage('Can’t connect', REFUSED, actor), 400);
    }
    // Described first: a failed lookup leaves nothing in KV.
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    return withHeaders(await c.html(consentPage(details, consent.handle, actor)), consent.headers);
  } catch (err) {
    return authorizationFailure(c, err);
  }
});

authorizeRoute.post('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  const actor = c.get('actor');
  const form = await c.req.parseBody();
  const handle = typeof form.handle === 'string' ? form.handle : '';
  try {
    if (form.decision !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    if (!allowedRedirect(approved.request.redirectUri, isLocalRequest(c.req.url))) {
      return await c.html(errorPage('Can’t connect', REFUSED, actor), 400);
    }
    const client = await oauth.lookupClient(approved.request.clientId);
    const props: ConnectorProps = { actor };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: actor,
      metadata: { label: client?.clientName ?? approved.request.clientId },
      scope: approved.request.scope,
      props,
    });
    // The grant exists and the consent handle is spent, so Claude must get
    // its code back whatever happens to the audit row.
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'connector',
      taskId: '-',
      action: 'approve Claude connector',
      outcome: 'success',
      detail: { clientId: approved.request.clientId, clientName: client?.clientName ?? null },
    }).catch((err: unknown) => console.error('auditing a connector approval', err));
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (err) {
    return authorizationFailure(c, err);
  }
});

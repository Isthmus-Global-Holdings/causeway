// The Worker's entry point. OAuthProvider sits in front of the app for the
// Claude connector:
// - it answers the OAuth endpoints claude.ai calls itself: discovery
//   (/.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/mcp),
//   client registration (/oauth/mcp/register) and tokens (/oauth/mcp/token);
// - it checks the bearer token on /mcp and hands the request to src/mcp/app.ts
//   with the props the rep approved it with;
// - everything else goes to the app (src/index.ts) as before, including the
//   approval page, /authorize, behind Cloudflare Access.
// Grants and tokens are kept in the OAUTH_KV namespace. The cron trigger runs
// coaching's sweep (scheduled).

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import app from './index';
import { mcpApp } from './mcp/app';
import { sweepDeps } from './lib/app-settings';
import { allowedRedirect, isLocalRequest } from './routes/authorize';
import type { Env } from './types';
import { runCoachingSweep } from './workflows/coaching-sweep';

// The resource a token is for is this Worker's own /mcp, so it's built from
// the request: the deployed URL, or localhost under `npm run dev`.
function provider(origin: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: { fetch: (request, env, ctx) => mcpApp.fetch(request, env, ctx) },
    defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/mcp/token',
    clientRegistrationEndpoint: '/oauth/mcp/register',
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Causeway' },
    // Only Claude may register (and a local app in local dev): a client
    // with any other redirect never gets as far as the approval page.
    clientRegistrationCallback: ({ clientMetadata, request }) => {
      const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
      const local = isLocalRequest(request.url);
      if (uris.length === 0 || !uris.every((uri) => typeof uri === 'string' && allowedRedirect(uri, local))) {
        return { code: 'invalid_redirect_uri', description: 'Only Claude can connect to this app.' };
      }
    },
  });
}

export default {
  fetch(request, env, ctx) {
    return provider(new URL(request.url).origin).fetch(request, env, ctx);
  },

  // The cron trigger in wrangler.jsonc: coaching's sweep (stuck transcripts,
  // calls to read), so it never waits on a page being opened.
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCoachingSweep(sweepDeps(env), Date.now()));
  },
} satisfies ExportedHandler<Env>;

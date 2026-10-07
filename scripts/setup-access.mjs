// One-time Cloudflare Access setup: Google sign-in (passkey-capable) in front
// of the Worker, with a public bypass for the tracking routes.
//
//   read -rs "CLOUDFLARE_API_TOKEN?Cloudflare API token: " && export CLOUDFLARE_API_TOKEN && echo
//   node scripts/setup-access.mjs ~/Downloads/client_secret_….json
//
// The token needs, at account level: "Access: Organizations, Identity
// Providers, and Groups: Edit" and "Access: Apps and Policies: Edit".
// The Google JSON is the OAuth client created for Access, whose redirect URI is
// https://<team>.cloudflareaccess.com/cdn-cgi/access/callback.
//
// Safe to re-run: it reuses the login method and apps it finds by name/domain.
// It prints only non-secret values: team domain, AUD tag, ids.

import { readFileSync } from 'node:fs';

const ACCOUNT_ID = '0d2651d439742b40232173f68725de78';
const HOST = 'hubspot-automations.frosty-darkness-3dd3.workers.dev';
// Only this account is a test user on the Google consent screen, so it's the
// only one Google will let sign in while the Google app is in Testing.
const ALLOWED_EMAILS = ['isthmusglobalholdings@gmail.com'];
const IDP_NAME = 'Google';

const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const jsonPath = process.argv[2];
if (!token || !jsonPath) {
  console.error('Usage: CLOUDFLARE_API_TOKEN=… node scripts/setup-access.mjs <google-client.json>');
  process.exit(1);
}
// API tokens are a single run of letters, digits, "-" and "_". Anything else
// (JSON, a URL, terminal text) means the wrong thing got pasted.
if (!/^[A-Za-z0-9_-]{30,}$/.test(token)) {
  console.error(
    `That doesn't look like a Cloudflare API token (${token.length} characters, starts with "${token.slice(0, 1)}"). ` +
      'Copy the token itself from the page shown right after creating it.'
  );
  process.exit(1);
}
const google = JSON.parse(readFileSync(jsonPath, 'utf8')).web;

async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

const org = await cf('GET', '/access/organizations');
console.log('Team domain:', org.auth_domain);
const expectedRedirect = `https://${org.auth_domain}/cdn-cgi/access/callback`;
if (!google.redirect_uris?.includes(expectedRedirect)) {
  throw new Error(
    `The Google client's redirect URIs don't include ${expectedRedirect}. Is this the Access client's JSON?`
  );
}

// 1. Google as a login method.
const idps = await cf('GET', '/access/identity_providers');
let idp = idps.find((p) => p.type === 'google' && p.name === IDP_NAME);
const idpConfig = { client_id: google.client_id, client_secret: google.client_secret };
if (idp) {
  idp = await cf('PUT', `/access/identity_providers/${idp.id}`, { name: IDP_NAME, type: 'google', config: idpConfig });
  console.log('Google login: updated', idp.id);
} else {
  idp = await cf('POST', '/access/identity_providers', { name: IDP_NAME, type: 'google', config: idpConfig });
  console.log('Google login: created', idp.id);
}

// 2. Apps. A path-specific app (/t/*) takes precedence over the host-wide one.
const apps = await cf('GET', '/access/apps');

async function upsertApp(domain, body) {
  const existing = apps.find((a) => a.domain === domain);
  const app = existing
    ? await cf('PUT', `/access/apps/${existing.id}`, { ...body, domain })
    : await cf('POST', '/access/apps', { ...body, domain });
  console.log(`${existing ? 'Updated' : 'Created'} app ${domain}`);
  return app;
}

const mainApp = await upsertApp(HOST, {
  name: 'hubspot-automations',
  type: 'self_hosted',
  session_duration: '720h',
  allowed_idps: [idp.id],
  auto_redirect_to_identity: true, // straight to Google, no picker page
  app_launcher_visible: false,
  policies: [
    {
      name: 'Allow the reps',
      decision: 'allow',
      precedence: 1,
      include: ALLOWED_EMAILS.map((email) => ({ email: { email } })),
    },
  ],
});

await upsertApp(`${HOST}/t/*`, {
  name: 'hubspot-automations tracking (public)',
  type: 'self_hosted',
  session_duration: '24h',
  app_launcher_visible: false,
  policies: [
    { name: 'Mail clients load tracking links', decision: 'bypass', precedence: 1, include: [{ everyone: {} }] },
  ],
});

console.log('\nPut these in wrangler.jsonc vars:');
console.log(`  "ACCESS_TEAM_DOMAIN": "${org.auth_domain}",`);
console.log(`  "ACCESS_AUD": "${mainApp.aud}"`);

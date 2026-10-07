// Runs before `npm run dev`: stops it unless .dev.vars.test points the
// Worker at the test CRM. Wrangler's own --env-file loader only logs a
// missing file and carries on, which would leave the live token from
// .dev.vars and the live portal from wrangler.jsonc in place.

import { readFileSync } from 'node:fs';

const LIVE_PORTAL_ID = '247260710';

function fail(message) {
  console.error(`npm run dev: ${message}\nSee README → "Test CRM". (npm run dev:live runs against the live CRM.)`);
  process.exit(1);
}

let text;
try {
  text = readFileSync('.dev.vars.test', 'utf8'); // follows the worktree symlink
} catch {
  fail('.dev.vars.test is missing (or a broken symlink).');
}

const vars = {};
for (const line of text.split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

if (!vars.HUBSPOT_ACCESS_TOKEN) fail('.dev.vars.test has no HUBSPOT_ACCESS_TOKEN.');
if (!vars.HUBSPOT_PORTAL_ID) fail('.dev.vars.test has no HUBSPOT_PORTAL_ID.');
if (vars.HUBSPOT_PORTAL_ID === LIVE_PORTAL_ID) fail('.dev.vars.test points at the live portal.');

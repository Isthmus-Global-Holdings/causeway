// Work that runs after the page has answered: the rep moves on while HubSpot
// is written to. waitUntil keeps the Worker running for it (up to 30 seconds
// after the response). The work records its own outcome, in D1 and the audit
// log, where the "didn't finish" notice (GET /unfinished) finds a failure.

import type { Context } from 'hono';
import type { AppEnv } from '../types';

export function afterResponse(c: Context<AppEnv>, what: string, work: () => Promise<unknown>): void {
  c.executionCtx.waitUntil(work().catch((err: unknown) => console.error(`${what}, after the response`, err)));
}

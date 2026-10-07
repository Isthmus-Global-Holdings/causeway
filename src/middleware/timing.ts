// How long each page took, so a slow one shows up in Workers Logs and in the
// browser's devtools (the Server-Timing header, under the request's Timing
// tab). HubSpot requests log their own time too (lib/hubspot.ts).

import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

export const timing: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  try {
    c.res.headers.append('Server-Timing', `app;dur=${ms}`);
  } catch {
    // A response passed through from another fetch keeps immutable headers.
  }
  console.log(JSON.stringify({ route: `${c.req.method} ${new URL(c.req.url).pathname}`, status: c.res.status, ms }));
};

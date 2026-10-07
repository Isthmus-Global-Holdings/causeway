import { Hono } from 'hono';
import { recordPitch } from '../actions/pitches';
import { describeError } from '../lib/errors';
import type { AppEnv } from '../types';
import { recordUrl } from '../views/layout';

export const pitchesRoute = new Hono<AppEnv>();

// POST /pitches — the Upwork pitch extension, right after it pasted a pitch:
// log the job's deal in HubSpot. JSON in and out; the extension shows the
// answer, or the error, in a toast on the Upwork page. The middleware lets
// this one path take the extension's origin (middleware/access.ts).
pitchesRoute.post('/pitches', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Send the pitch as JSON.' }, 400);
  }
  try {
    const { dealId, created } = await recordPitch(c, body);
    return c.json({ dealId, created, dealUrl: recordUrl(c.env.HUBSPOT_PORTAL_ID, '0-3', dealId) });
  } catch (err) {
    const { message, status, log } = describeError(err);
    if (log) console.error(err);
    return c.json({ error: message }, status);
  }
});

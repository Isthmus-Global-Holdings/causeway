import { Hono } from 'hono';
import { unfinishedWrites } from '../lib/db';
import type { AppEnv } from '../types';
import { unfinishedNotice } from '../views/unfinished';

export const unfinishedRoute = new Hono<AppEnv>();

// GET /unfinished — the notice about HubSpot writes still running after the
// page answered, or stopped short. D1 only; every page fetches it.
unfinishedRoute.get('/unfinished', async (c) => {
  const items = await unfinishedWrites(c.env.DB, Math.floor(Date.now() / 1000));
  c.header('Cache-Control', 'no-store');
  return c.html(unfinishedNotice(items));
});

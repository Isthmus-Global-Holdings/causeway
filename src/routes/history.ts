import { Hono } from 'hono';
import { loadAppSettings, twilioConfigured } from '../lib/app-settings';
import { HISTORY_PAGE, historyFilters } from '../lib/call-history';
import { callHistory, callInsightsFor } from '../lib/db';
import type { AppEnv } from '../types';
import { coachedTaskId, historyPage } from '../views/history';

// Mounted at /calls. Only GET /calls: the call task pages (/calls/:id) are
// routes/calls.ts.
export const historyRoute = new Hono<AppEnv>();

// GET /calls — the record of every call, in and out, newest first, with its
// summary and transcript: filtered by direction (?dir=in|out), searched
// (?q=), and paged (?before=, the last call's start), each logged call with
// what coaching read from it. All from D1, so nothing waits on HubSpot.
historyRoute.get('/', async (c) => {
  const filters = historyFilters({ dir: c.req.query('dir'), q: c.req.query('q'), before: c.req.query('before') });
  const nowSec = Math.floor(Date.now() / 1000);
  const [page, settings] = await Promise.all([callHistory(c.env.DB, filters, HISTORY_PAGE), loadAppSettings(c.env)]);
  const insights = await callInsightsFor(
    c.env.DB,
    page.items.map(coachedTaskId).filter((id): id is string => id !== null)
  );
  const setup = {
    twilioReady: twilioConfigured(c.env),
    fromNumber: settings.twilioFromNumber,
    repPhone: settings.repPhone,
  };
  const back = new URL(c.req.url);
  return c.html(
    historyPage(
      { page, filters, setup, nowSec, timeZone: settings.timeZone, insights, back: back.pathname + back.search },
      c.get('actor')
    )
  );
});

import { Hono } from 'hono';
import { coachingOverview, heardOverview, setCallExcluded } from '../actions/coaching';
import type { AppEnv } from '../types';
import { coachingPage } from '../views/coaching';
import { heardPage } from '../views/heard';

export const coachingRoute = new Hono<AppEnv>();

// GET /coaching — the patterns across every logged call: when people pick
// up, the front desk, rushed connects with no next step, what the long
// connects did, objections and the openings that got past them, follow-up
// timing. All from D1; calls not read yet are read after it answers.
coachingRoute.get('/', async (c) => {
  return c.html(coachingPage(await coachingOverview(c), c.get('actor')));
});

// GET /coaching/heard — what they've told the rep: the software they use
// and what they said about their work, in their words, by theme, across
// every call and interview that reached them.
coachingRoute.get('/heard', async (c) => {
  return c.html(heardPage(await heardOverview(c), c.get('actor')));
});

// POST /coaching/calls/:id/exclude — leave a logged call out of coaching (a
// test call), or put it back (excluded=0). Back to the page it was pressed on.
coachingRoute.post('/calls/:id/exclude', async (c) => {
  const form = await c.req.parseBody();
  await setCallExcluded(c, c.req.param('id'), form.excluded !== '0');
  const back = typeof form.back === 'string' && /^\/(?!\/)/.test(form.back) ? form.back : '/calls';
  return c.redirect(back, 303);
});

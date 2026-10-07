import { Hono } from 'hono';
import { markEmailSent } from '../actions/emails';
import type { AppEnv } from '../types';
import { redirectToNextEmail } from './next-email';

export const sentRoute = new Hono<AppEnv>();

// POST /tasks/:id/sent — the rep confirms the email went out. Completes the
// EMAIL task and creates tomorrow's CALL task after the page answers, then
// shows the re-ranked queue.
sentRoute.post('/:id/sent', async (c) => {
  const taskId = c.req.param('id');
  const settings = await markEmailSent(c, taskId);
  return redirectToNextEmail(c, taskId, settings, null);
});

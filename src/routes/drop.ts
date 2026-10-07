import { Hono } from 'hono';
import { dropEmailTask } from '../actions/emails';
import type { AppEnv } from '../types';
import { droppedFlash } from '../views/queue';

export const dropRoute = new Hono<AppEnv>();

// POST /tasks/:id/drop — the rep won't send this one. Marks the EMAIL task
// DEFERRED in HubSpot, which takes it off the queue, and creates no follow-up.
dropRoute.post('/:id/drop', async (c) => {
  const taskId = c.req.param('id');
  await dropEmailTask(c, taskId);
  // The queue's script (X-Fragment) takes the row off itself: just the notice.
  if (c.req.header('X-Fragment')) return c.html(droppedFlash(taskId));
  return c.redirect(`/?${new URLSearchParams({ dropped: taskId })}`, 303);
});

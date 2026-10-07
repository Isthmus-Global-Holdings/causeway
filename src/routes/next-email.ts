import type { Context } from 'hono';
import type { AppSettings } from '../lib/app-settings';
import { localDate } from '../lib/dates';
import { recentlyWorked } from '../lib/db';
import { nextInPlan } from '../lib/work-plan';
import type { AppEnv } from '../types';

// After an email is sent (or marked sent): straight on to the next email in
// today's order, its draft page or, if it's drafted, its send page. Back to
// the queue when there's no order for today or it's all done.
export async function redirectToNextEmail(
  c: Context<AppEnv>,
  taskId: string,
  settings: AppSettings,
  via: 'gmail' | null
): Promise<Response> {
  const worked = await recentlyWorked(c.env.DB, 'email');
  const next = nextInPlan(settings.emailPlan ?? null, localDate(Date.now(), settings.timeZone), taskId, worked, {
    undraftedFirst: true,
  });
  const query = new URLSearchParams({ sent: taskId, ...(via ? { via } : {}) });
  if (!next) return c.redirect(`/?${query}&saving=1`, 303);
  return c.redirect(`/tasks/${encodeURIComponent(next.id)}/${next.drafted ? 'send' : 'draft'}?${query}`, 303);
}

// The note on the next email's page about the one just sent.
export function sentNotice(c: Context<AppEnv>): string | null {
  if (!c.req.query('sent')) return null;
  const what = c.req.query('via') === 'gmail' ? 'Email sent from Gmail.' : 'Email marked sent.';
  return `${what} Its task is being completed and tomorrow’s follow-up call task created in HubSpot, and the notice above says if anything didn’t finish. Here’s the next one.`;
}

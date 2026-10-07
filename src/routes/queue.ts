import { Hono } from 'hono';
import { loadAppSettings } from '../lib/app-settings';
import { localDate } from '../lib/dates';
import { recentlyWorked, recentSends, savePlan, waitingOnCallBack } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import { QUEUE_TAB_PATHS, rememberedQueueTab, rememberQueueTab } from '../lib/queue-tab';
import { rankSends } from '../lib/sent-rank';
import type { AppEnv } from '../types';
import { queuePage, type QueueFlash } from '../views/queue';
import { loadEmailQueue } from '../workflows/email-queue';
import { recordNames } from '../workflows/records';
import { loadTodayCounts } from '../workflows/today';

export const queueRoute = new Hono<AppEnv>();

// GET / — the Queue's first tab: every open EMAIL task ranked by company fit,
// with the next one to draft on top. The "email sent" workflow and Drop redirect here with their result.
queueRoute.get('/', async (c) => {
  rememberQueueTab(c, 'emails');
  const sent = c.req.query('sent');
  const call = c.req.query('call');
  const dropped = c.req.query('dropped') || null;
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  // HubSpot's search can still return a task just sent, marked sent or
  // dropped (its index trails writes, and a send's HubSpot steps run after the
  // page answered): the redirect's and those worked through the app lately
  // are left out.
  const worked = await recentlyWorked(c.env.DB, 'email');
  const closed = [...worked, ...[sent, dropped].filter((id): id is string => Boolean(id))];
  // Today's counts need the time zone from settings; the rest starts at once.
  const loadingSettings = loadAppSettings(c.env);
  const [queue, { sends, names }, settings, today, waiting] = await Promise.all([
    loadingSettings.then((s) => loadEmailQueue(hs, closed, Date.now(), s.timeZone)),
    // The emails sent lately, the people worth calling now first, with the
    // names of who they went to.
    recentSends(c.env.DB).then(async (rows) => {
      const sends = rankSends(rows);
      return { sends, names: await recordNames(hs, sends) };
    }),
    loadingSettings,
    loadingSettings.then((s) => loadTodayCounts(c.env.DB, hs, Date.now(), s.timeZone)),
    // For the Calls to make tab's count.
    waitingOnCallBack(c.env.DB, Math.floor(Date.now() / 1000)),
  ]);

  // Today's emails in the queue's order, so sending one can go straight to
  // the next (routes/next-email.ts).
  await savePlan(c.env.DB, 'email_plan', {
    date: localDate(Date.now(), settings.timeZone),
    items: queue.rows.filter((r) => r.fit !== 'DROP').map((r) => ({ id: r.taskId, drafted: r.hasDraft })),
  });

  const flash: QueueFlash | null = sent
    ? {
        sentTaskId: sent,
        followUp: call ? { callTaskId: call, created: c.req.query('created') === '1' } : null,
        viaGmail: c.req.query('via') === 'gmail',
      }
    : null;

  return c.html(
    queuePage(queue, sends, names, flash, dropped, today, waiting.length, settings.timeZone, c.get('actor'))
  );
});

// GET /queue — the navbar's Queue link: the tab the rep was last on, so
// working through calls, Queue goes straight back to Calls to make.
queueRoute.get('/queue', (c) => c.redirect(QUEUE_TAB_PATHS[rememberedQueueTab(c)], 302));

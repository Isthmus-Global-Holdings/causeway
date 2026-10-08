import { Hono } from 'hono';
import { bookInterview, callsOverview, logCall, snoozeCallTask } from '../actions/calls';
import { callCoaching } from '../actions/coaching';
import { loadAppSettings } from '../lib/app-settings';
import { MAX_SCRIPT, normalizeScript } from '../lib/call-script';
import { localDate } from '../lib/dates';
import {
  d1CallLogStore,
  d1DialStore,
  deleteSetting,
  insertAudit,
  latestSendToContact,
  recentlyWorked,
  savePlan,
  setSetting,
  waitingOnCallBack,
} from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import { rememberQueueTab } from '../lib/queue-tab';
import { nextInPlan, planProgress } from '../lib/work-plan';
import type { AppEnv } from '../types';
import { callPage, callsPage, type CallsFlash } from '../views/calls';
import { HISTORY_LINKS, loadCallContext } from '../workflows/call-context';
import { mountDialRoutes, setupOf } from './dialing';
import { planItems } from '../workflows/call-queue';
import { bookingFieldsOf } from '../workflows/book-interview';
import { contactMeetings } from '../workflows/meeting-queue';
import { dialState } from '../workflows/dial';
import { loadTask, WorkflowError } from '../workflows/parties';
import { loadTodayCounts } from '../workflows/today';
import { recordingState, syncTranscript } from '../workflows/transcribe';

export const callsRoute = new Hono<AppEnv>();

// Mounted at /queue/calls: the Queue's second tab.
export const callQueueRoute = new Hono<AppEnv>();

// GET /queue/calls — every open CALL task: today's ranked by who to call
// first, with the next one on top, then the upcoming ones, and the callers
// waiting on a call back above them. Logging or moving a call redirects here
// with its result.
callQueueRoute.get('/', async (c) => {
  rememberQueueTab(c, 'calls');
  const logged = c.req.query('logged') || null;
  const flash: CallsFlash | null = logged
    ? {
        loggedTaskId: logged,
        nextTaskId: c.req.query('next') || null,
        nextTaskCreated: c.req.query('created') === '1',
        logMissing: c.req.query('log') === 'missing',
        leadStatus: c.req.query('lead') || null,
        interviewId: c.req.query('interview') || null,
        saving: c.req.query('saving') === '1',
      }
    : null;
  const movedId = c.req.query('moved');
  const movedDue = Number(c.req.query('due'));
  const moved =
    movedId && Number.isFinite(movedDue)
      ? { taskId: movedId, dueAt: movedDue, setTime: c.req.query('set') === '1' }
      : null;
  const [{ hs, now, settings, queue, plan, meetings }, waiting] = await Promise.all([
    callsOverview(c, { logged, moved }),
    waitingOnCallBack(c.env.DB, Math.floor(Date.now() / 1000)),
  ]);
  const [today] = await Promise.all([
    loadTodayCounts(c.env.DB, hs, now, settings.timeZone, meetings),
    // Today's calls in the order the page ranks them, so logging one can go
    // straight to the next (see POST /:id/log).
    savePlan(c.env.DB, 'call_plan', {
      date: localDate(now, settings.timeZone),
      items: planItems(plan),
    }),
  ]);
  return c.html(
    callsPage(queue, flash, moved, setupOf(c.env, settings), now, settings.timeZone, today, waiting, c.get('actor'))
  );
});

// GET /calls/:id — one CALL task: the call script, the contact's numbers,
// the last email the app sent them, who they are and their HubSpot history,
// the live status of a call, and the form to log it.
callsRoute.get('/:id', async (c) => {
  const taskId = c.req.param('id');
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  const now = Date.now();
  // The task, contact and company come with the ids of the contact's history
  // and meetings, so everything after is one batch read each, side by side.
  // The call just logged, when logging it landed here: said at the top.
  const loggedId = c.req.query('logged') || null;
  const [parties, dial, log, settings, worked, previous] = await Promise.all([
    loadTask(hs, taskId, 'CALL', [...HISTORY_LINKS, 'meetings']),
    d1DialStore(c.env.DB).latestForTask(taskId),
    d1CallLogStore(c.env.DB).get(taskId),
    loadAppSettings(c.env),
    recentlyWorked(c.env.DB, 'call'),
    loggedId ? d1CallLogStore(c.env.DB).get(loggedId) : null,
  ]);
  const today = localDate(now, settings.timeZone);
  const nextCall = nextInPlan(settings.callPlan ?? null, today, taskId, worked, { now });
  const [context, meetings, lastEmail, coaching] = await Promise.all([
    loadCallContext(hs, parties),
    // Only for the notice: the call page still works if meetings can't be read.
    contactMeetings(hs, parties.contact.id, now, settings.timeZone, parties.related?.meetings).catch((err: unknown) => {
      console.error('interviews for call page', err);
      return { interviews: [], missed: null };
    }),
    latestSendToContact(c.env.DB, parties.contact.id),
    // After the call just logged (the previous one, or this task's own), and
    // before this one.
    callCoaching(c, parties, loggedId || (log ? taskId : null), settings, now),
  ]);
  // A transcript that finished but never reached the logged HubSpot call
  // (HubSpot failed at the time) is written now. It's idempotent, and runs
  // after the page is sent.
  if (dial && log?.logged_call_id && !log.transcript_synced_at && dial.transcript_status === 'done') {
    c.executionCtx.waitUntil(
      syncTranscript(hs, d1CallLogStore(c.env.DB), dial, { now, baseUrl: c.env.PUBLIC_BASE_URL }).catch((err) =>
        console.error('transcript sync on view', err)
      )
    );
  }
  return c.html(
    callPage(
      {
        parties,
        dial,
        dialState: dial ? dialState(dial, Math.floor(now / 1000)) : null,
        recordingState: dial ? recordingState(dial, Math.floor(now / 1000)) : null,
        log,
        lastEmail,
        context,
        callScript: settings.callScript,
        fromName: settings.fromName,
        scriptSaved: c.req.query('script') === 'saved',
        setup: setupOf(c.env, settings),
        interviews: meetings.interviews,
        missedInterview: meetings.missed,
        portalId: c.env.HUBSPOT_PORTAL_ID,
        now,
        timeZone: settings.timeZone,
        justLogged: loggedId ? { taskId: loggedId, log: previous } : null,
        nextCallId: nextCall?.id ?? null,
        today: planProgress(settings.callPlan ?? null, today, taskId, worked, { now }),
        callNow: c.req.query('call') === '1',
        coaching,
      },
      c.get('actor')
    )
  );
});

// POST /calls/:id/script — save the call script. There's one, shared by every
// call; it's posted from a call page so saving lands back on that call.
callsRoute.post('/:id/script', async (c) => {
  const taskId = c.req.param('id');
  const form = await c.req.parseBody();
  const script = normalizeScript(typeof form.script === 'string' ? form.script : '');
  if (script.length > MAX_SCRIPT) {
    throw new WorkflowError(`The call script is limited to ${MAX_SCRIPT.toLocaleString('en-US')} characters.`);
  }
  if (script.trim()) await setSetting(c.env.DB, 'call_script', script);
  else await deleteSetting(c.env.DB, 'call_script');
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: 'call',
    taskId,
    action: 'save call script',
    outcome: 'success',
    detail: { chars: script.length },
  });
  return c.redirect(`/calls/${encodeURIComponent(taskId)}?script=saved`, 303);
});

// POST /calls/:id/log — log the call on the contact, complete the task,
// create the follow-up.
callsRoute.post('/:id/log', async (c) => {
  const taskId = c.req.param('id');
  const form = await c.req.parseBody();
  const text = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : undefined);
  const logged = await logCall(
    c,
    taskId,
    {
      channel: text('channel'),
      whatsapp_field: text('whatsapp_field'),
      outcome: text('outcome'),
      notes: text('notes'),
      next_type: text('next_type'),
      next_date: text('next_date'),
      next_time: text('next_time'),
      book: text('book'),
      ...bookingFieldsOf(text),
      conversation: text('conversation'),
      learned: text('learned'),
    },
    text('dial_id') ?? null
  );

  if (logged.saving) {
    // Straight on to the next call in today's order, or back to the list
    // when there's no order for today or it's all done.
    const { settings } = logged;
    const worked = await recentlyWorked(c.env.DB, 'call');
    const now = Date.now();
    const next = nextInPlan(settings.callPlan ?? null, localDate(now, settings.timeZone), taskId, worked, { now });
    return next
      ? c.redirect(`/calls/${encodeURIComponent(next.id)}?${new URLSearchParams({ logged: taskId })}`, 303)
      : c.redirect(`/queue/calls?${new URLSearchParams({ logged: taskId, saving: '1' })}`, 303);
  }

  const { result } = logged;
  const query = new URLSearchParams({
    logged: taskId,
    ...(result.nextTaskId ? { next: result.nextTaskId, created: result.nextTaskCreated ? '1' : '0' } : {}),
    ...(result.loggedCallId || result.loggedMessageId ? {} : { log: 'missing' }),
    ...(result.leadStatus ? { lead: result.leadStatus } : {}),
    ...(result.bookedMeetingId ? { interview: result.bookedMeetingId } : {}),
  });
  return c.redirect(`/queue/calls?${query}`, 303);
});

// POST /calls/:id/book — book an interview set up another way (an email
// reply, a text) as a meeting in HubSpot, without logging a call.
callsRoute.post('/:id/book', async (c) => {
  const form = await c.req.parseBody();
  const text = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : undefined);
  const result = await bookInterview(c, c.req.param('id'), bookingFieldsOf(text));
  return c.redirect(`/meetings/${encodeURIComponent(result.meetingId)}?booked=1`, 303);
});

// POST /calls/:id/snooze — move the call to another day, or a set time,
// without logging one.
callsRoute.post('/:id/snooze', async (c) => {
  const taskId = c.req.param('id');
  const form = await c.req.parseBody();
  const field = (name: string) => (typeof form[name] === 'string' ? form[name] : '');
  const { dueAt } = await snoozeCallTask(c, taskId, field('date'), field('time'));
  const query = { moved: taskId, due: String(dueAt), ...(field('time') ? { set: '1' } : {}) };
  return c.redirect(`/queue/calls?${new URLSearchParams(query)}`, 303);
});

mountDialRoutes(callsRoute, 'task');

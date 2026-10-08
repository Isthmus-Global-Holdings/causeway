// What the call pages and the Claude connector both do with CALL tasks: the
// ranked list, logging a call, moving one, dropping one, booking an
// interview, taking a caller off "Waiting on a call back". Each checks,
// runs the workflow and writes the audit row; the caller only parses its
// input and answers (a redirect, or a tool result).

import type { Context } from 'hono';
import { googleCalendar, insightDeps, loadAppSettings, type AppSettings } from '../lib/app-settings';
import { afterResponse } from '../lib/background';
import { localDate, parseTime } from '../lib/dates';
import {
  addSetTimeCallToPlan,
  d1CallLogStore,
  d1DialStore,
  d1MeetingBookingStore,
  dismissCallBack,
  engagementByContact,
  insertAudit,
  recentCallLogs,
  recentlyWorked,
  removeFromPlan,
  type RecentCallLog,
} from '../lib/db';
import { createHubSpot, type HubSpot } from '../lib/hubspot';
import { callableFrom } from '../lib/set-time';
import { dialTranscript } from '../lib/transcript';
import type { AppEnv } from '../types';
import { parseBookingForm, runBooking } from '../workflows/book-interview';
import { whoFromTitle } from '../lib/conversations';
import { readCall } from '../workflows/call-insight';
import {
  doneResult,
  finishCallLog,
  parseCallLogForm,
  prepareCallLog,
  type CallLoggedResult,
  type PreparedCallLog,
} from '../workflows/call-logged';
import {
  applyRecentChange,
  loadCallQueue,
  planCalls,
  withEngagement,
  withInterviews,
  type CallPlan,
  type CallQueue,
  type MovedCall,
} from '../workflows/call-queue';
import { dialState, isLive } from '../workflows/dial';
import { loadMeetings, type MeetingRow } from '../workflows/meeting-queue';
import { WorkflowError } from '../workflows/parties';
import { dropCall, snoozeCall } from '../workflows/task-actions';
import { syncTranscript } from '../workflows/transcribe';
import { countFromLog } from './coaching';

// How many of the calls logged from the app the connector's call overview lists.
const RECENTLY_LOGGED = 15;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface CallsOverview {
  hs: HubSpot;
  now: number;
  settings: AppSettings;
  queue: CallQueue;
  plan: CallPlan; // today's ranked, then the upcoming ones
  meetings: MeetingRow[] | null; // null when HubSpot's meetings couldn't be read
  recent: RecentCallLog[];
}

// Every open CALL task, with today's ranked by who to call first. `logged`
// and `moved` are a change the page's redirect reports, which HubSpot's
// search may not show yet.
export async function callsOverview(
  c: Context<AppEnv>,
  change: { logged: string | null; moved: MovedCall | null } = { logged: null, moved: null }
): Promise<CallsOverview> {
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  const now = Date.now();
  const [loaded, engagement, settings, worked, meetings, recent] = await Promise.all([
    loadCallQueue(hs),
    engagementByContact(c.env.DB),
    loadAppSettings(c.env),
    recentlyWorked(c.env.DB, 'call'),
    // Only for the interview badges and today's count: the calls still show
    // if meetings can't be read.
    loadMeetings(hs, now).catch((err: unknown) => {
      console.error('meetings for call badges', err);
      return null;
    }),
    recentCallLogs(c.env.DB, RECENTLY_LOGGED),
  ]);
  const logged = change.logged ? new Set([...worked, change.logged]) : worked;
  const queue = withInterviews(
    withEngagement(applyRecentChange(loaded, { logged, moved: change.moved }), engagement),
    meetings ?? [],
    now,
    settings.timeZone
  );
  return { hs, now, settings, queue, plan: planCalls(queue.rows, now, settings.timeZone), meetings, recent };
}

export type CallLogged =
  | { saving: true; settings: AppSettings } // the HubSpot steps run after the response
  | { saving: false; settings: AppSettings; result: CallLoggedResult };

// Logs the call on the contact, completes the task and creates the follow-up.
// `form` has the log form's fields (see parseCallLogForm). `dialId` is the
// app's call this outcome is for: only a dial for this same task counts.
export async function logCall(
  c: Context<AppEnv>,
  taskId: string,
  form: Record<string, string | undefined>,
  dialId: string | null
): Promise<CallLogged> {
  const actor = c.get('actor');
  const now = Date.now();
  const settings = await loadAppSettings(c.env);
  const { timeZone } = settings;
  const parsed = parseCallLogForm(form, localDate(now, timeZone));
  const dials = d1DialStore(c.env.DB);
  // The page hides the form during a call, but a form left open in another
  // tab can still be submitted. Refuse it until the task's latest call is over.
  const latest = await dials.latestForTask(taskId);
  if (latest && isLive(dialState(latest, Math.floor(now / 1000)))) {
    throw new WorkflowError('A call for this task is still in progress. Log it once the call has ended.', 409);
  }
  // A WhatsApp call or message isn't the page's Twilio dial, nor its transcript.
  const found = dialId && parsed.channel === 'phone' ? await dials.get(dialId) : null;
  const dial = found?.task_id === taskId && found.subject === 'task' ? found : null;
  const callLogs = d1CallLogStore(c.env.DB);
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  const opts = { now, timeZone, baseUrl: c.env.PUBLIC_BASE_URL, calendar: googleCalendar(c.env, settings) };
  const auditSuccess = (result: CallLoggedResult) =>
    insertAudit(c.env.DB, {
      actor,
      workflow: 'call',
      taskId,
      action: 'log call + complete call task + create follow-up + lead status + book interview',
      outcome: 'success',
      detail: result,
    });
  const auditFailure = (err: unknown) =>
    insertAudit(c.env.DB, {
      actor,
      workflow: 'call',
      taskId,
      action: 'log call',
      outcome: 'failed',
      error: errorText(err),
    });

  // The HubSpot steps, then the transcript if it finished while the call
  // was being logged (the call is logged either way; this only adds it).
  const finish = async (prepared: Extract<PreparedCallLog, { kind: 'locked' }>) => {
    const result = await finishCallLog(hs, callLogs, prepared, dial ? dialTranscript(dial) : null, opts);
    // A follow-up at a set time later today wasn't there when today's plan
    // was saved: it joins it, so the rep is sent to it when its time comes.
    const { next_set_time, next_due } = prepared.row;
    if (
      result.nextTaskId &&
      next_set_time &&
      next_due &&
      localDate(Date.parse(next_due), timeZone) === localDate(now, timeZone)
    ) {
      await addSetTimeCallToPlan(
        c.env.DB,
        localDate(now, timeZone),
        result.nextTaskId,
        callableFrom(Date.parse(next_due))
      );
    }
    if (dial) {
      const latest = await dials.get(dial.id);
      if (latest) {
        await syncTranscript(hs, callLogs, latest, { now, baseUrl: c.env.PUBLIC_BASE_URL }).catch((err) =>
          console.error('transcript sync after logging', err)
        );
      }
    }
    await auditSuccess(result);
    // Coaching reads the call once it's logged, in the background.
    afterResponse(c, `reading call ${taskId} for coaching`, () => readCall(insightDeps(c.env), taskId, Date.now()));
    return result;
  };

  let prepared: PreparedCallLog;
  try {
    prepared = await prepareCallLog(hs, callLogs, taskId, { ...parsed, dial }, opts);
  } catch (err) {
    await auditFailure(err);
    throw err;
  }
  // A real conversation, if the rep ticked it: D1 only, before the answer.
  // It's checked against the outcome first logged, so a retry can't count a
  // voicemail; ticked on a retry, it counts, as on Coaching. A failure here
  // only logs: the call's own steps go on, and Coaching's Count is the way back.
  await countFromLog(c, form, {
    kind: 'call',
    refId: taskId,
    contactId: prepared.row.contact_id,
    who: dial?.contact_label ?? whoFromTitle(prepared.row.title),
    outcome: prepared.row.outcome,
  }).catch((err: unknown) => console.error('counting the call as a real conversation', err));

  // Usually the HubSpot steps run after the response, and the rep moves on.
  // A call that books an interview is finished first, so the answer can
  // point to the interview (and say if the invite couldn't go out).
  if (prepared.kind === 'locked' && !prepared.row.book_start) {
    const locked = prepared;
    afterResponse(c, `logging call ${taskId}`, () => finish(locked).catch((err: unknown) => auditFailure(err)));
    return { saving: true, settings };
  }

  try {
    const result = prepared.kind === 'done' ? doneResult(prepared.row) : await finish(prepared);
    return { saving: false, settings, result };
  } catch (err) {
    await auditFailure(err);
    throw err;
  }
}

// Books an interview set up another way (an email reply, a text) as a
// meeting in HubSpot, without logging a call. `form` has the book_* fields.
export async function bookInterview(c: Context<AppEnv>, taskId: string, form: Record<string, string | undefined>) {
  const actor = c.get('actor');
  const now = Date.now();
  const settings = await loadAppSettings(c.env);
  const { timeZone } = settings;
  const input = parseBookingForm(form, localDate(now, timeZone));
  try {
    const result = await runBooking(
      createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN),
      googleCalendar(c.env, settings),
      d1MeetingBookingStore(c.env.DB),
      taskId,
      input,
      { now, timeZone }
    );
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'meeting',
      taskId,
      action: `book interview for ${result.startAt}${result.invited ? ' + calendar invite' : ''}`,
      outcome: 'success',
      detail: result,
    });
    return result;
  } catch (err) {
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'meeting',
      taskId,
      action: 'book interview',
      outcome: 'failed',
      error: errorText(err),
    });
    throw err;
  }
}

// Moves the call to another day ("YYYY-MM-DD") without logging one, at
// `time` ("HH:MM", or "" to keep its time of day): a time makes it a set-time
// call (lib/set-time.ts).
export async function snoozeCallTask(
  c: Context<AppEnv>,
  taskId: string,
  date: string,
  time = ''
): Promise<{ dueAt: number }> {
  const actor = c.get('actor');
  const { timeZone } = await loadAppSettings(c.env);
  const at = time ? parseTime(time) : null;
  const moveTo = time ? `${date} ${time}` : date;
  try {
    if (time && !at) throw new WorkflowError('Enter a time like 4pm or 4:30pm, or leave it blank.');
    const { dueAt } = await snoozeCall(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), taskId, date, at, {
      now: Date.now(),
      timeZone,
    });
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'task-action',
      taskId,
      action: `move call task to ${moveTo}`,
      outcome: 'success',
      detail: { dueAt: new Date(dueAt).toISOString() },
    });
    // Moved, it isn't next today any more, unless it's to a time later today:
    // then it's next once that time comes.
    const today = localDate(Date.now(), timeZone);
    if (at && localDate(dueAt, timeZone) === today) {
      await addSetTimeCallToPlan(c.env.DB, today, taskId, callableFrom(dueAt));
    } else {
      await removeFromPlan(c.env.DB, 'call_plan', taskId);
    }
    return { dueAt };
  } catch (err) {
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'task-action',
      taskId,
      action: `move call task to ${moveTo}`,
      outcome: 'failed',
      error: errorText(err),
    });
    throw err;
  }
}

// The rep won't make this call. Marks the CALL task DEFERRED in HubSpot,
// which takes it off the queue, and creates no follow-up. Refused while a
// call for it is live.
export async function dropCallTask(c: Context<AppEnv>, taskId: string): Promise<void> {
  const actor = c.get('actor');
  const audit = (outcome: 'success' | 'failed', error?: string) =>
    insertAudit(c.env.DB, { actor, workflow: 'task-action', taskId, action: 'drop call task', outcome, error });
  try {
    const latest = await d1DialStore(c.env.DB).latestForTask(taskId);
    if (latest && isLive(dialState(latest, Math.floor(Date.now() / 1000)))) {
      throw new WorkflowError('A call for this task is still in progress. Drop it once the call has ended.', 409);
    }
    await dropCall(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), d1CallLogStore(c.env.DB), taskId);
    await audit('success');
    await removeFromPlan(c.env.DB, 'call_plan', taskId);
  } catch (err) {
    await audit('failed', errorText(err));
    throw err;
  }
}

// Takes a caller off "Waiting on a call back" without calling them: a wrong
// number, a robocall. `inboundCallId` is their latest call. Only D1.
export async function dismissWaitingCaller(c: Context<AppEnv>, inboundCallId: string): Promise<void> {
  if (!(await dismissCallBack(c.env.DB, inboundCallId, new Date().toISOString()))) {
    throw new WorkflowError('That call isn’t waiting on a call back.', 404);
  }
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: 'call',
    taskId: inboundCallId, // no task: the inbound call's id
    action: 'dismiss call back',
    outcome: 'success',
    detail: { inboundCallId },
  });
}

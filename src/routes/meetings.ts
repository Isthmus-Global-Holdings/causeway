import { Hono } from 'hono';
import { callNotes } from '../actions/coaching';
import { latestMeetingDial, logMeeting, meetingsOverview } from '../actions/meetings';
import { loadAppSettings } from '../lib/app-settings';
import { parseHubSpotTime } from '../lib/dates';
import { d1MeetingLogStore, latestSendToContact } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import type { AppEnv } from '../types';
import { meetingPage, meetingsPage, type MeetingsFlash } from '../views/meetings';
import { HISTORY_LINKS, loadCallContext } from '../workflows/call-context';
import { dialState } from '../workflows/dial';
import { meetingLogId } from '../workflows/meeting-logged';
import { bucketMeetings, loadMeeting, meetingOutcome } from '../workflows/meeting-queue';
import { loadTodayCounts } from '../workflows/today';
import { recordingState } from '../workflows/transcribe';
import { mountDialRoutes, setupOf } from './dialing';

export const meetingsRoute = new Hono<AppEnv>();

// GET /meetings — interviews from a week back to two weeks ahead. Logging one
// redirects here with its result.
meetingsRoute.get('/', async (c) => {
  const logged = c.req.query('logged');
  const flash: MeetingsFlash | null = logged
    ? {
        meetingId: logged,
        outcome: meetingOutcome(c.req.query('outcome')),
        startAt: parseHubSpotTime(c.req.query('start')),
        nextTaskId: c.req.query('next') || null,
        nextTaskCreated: c.req.query('created') === '1',
        inviteUpdated: c.req.query('invite') === '1',
      }
    : null;
  const { hs, now, settings, rows, error } = await meetingsOverview(
    c,
    flash ? { meetingId: flash.meetingId, outcome: flash.outcome, startAt: flash.startAt } : null
  );
  const today = await loadTodayCounts(c.env.DB, hs, now, settings.timeZone, error ? null : rows);
  return c.html(
    meetingsPage(bucketMeetings(rows, now, settings.timeZone), flash, error, settings.timeZone, today, c.get('actor'))
  );
});

// GET /meetings/:id — prep for one interview: when and how to join, the
// questions, what's on the contact's timeline, and the form to log it.
meetingsRoute.get('/:id', async (c) => {
  const meetingId = c.req.param('id');
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  // The contact comes with its history's ids, so the history is one batch
  // read of each.
  const [parties, settings, dial] = await Promise.all([
    loadMeeting(hs, meetingId, [...HISTORY_LINKS]),
    loadAppSettings(c.env),
    latestMeetingDial(c.env, meetingId),
  ]);
  const startAt = parseHubSpotTime(parties.meeting.properties.hs_meeting_start_time);
  const [context, lastEmail, log, coaching] = await Promise.all([
    loadCallContext(hs, parties),
    latestSendToContact(c.env.DB, parties.contact.id),
    // One that stopped partway first: after a reschedule landed, it's no
    // longer under the meeting's current start time.
    d1MeetingLogStore(c.env.DB)
      .unfinished(meetingId)
      .then((row) => row ?? d1MeetingLogStore(c.env.DB).get(meetingLogId(meetingId, startAt))),
    // What coaching read from the call made from this page, once it ended.
    dial ? callNotes(c.env.DB, meetingId) : null,
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  return c.html(
    meetingPage(
      {
        parties,
        context,
        lastEmail,
        log,
        booked: c.req.query('booked') === '1',
        dial,
        dialState: dial ? dialState(dial, nowSec) : null,
        recordingState: dial ? recordingState(dial, nowSec) : null,
        coaching,
        setup: setupOf(c.env, settings),
        portalId: c.env.HUBSPOT_PORTAL_ID,
        now: Date.now(),
        timeZone: settings.timeZone,
      },
      c.get('actor')
    )
  );
});

// POST /meetings/:id/log — the interview's outcome and notes on the meeting,
// the follow-up task, and Lead Status.
meetingsRoute.post('/:id/log', async (c) => {
  const meetingId = c.req.param('id');
  const form = await c.req.parseBody();
  const text = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : undefined);
  const result = await logMeeting(
    c,
    meetingId,
    {
      outcome: text('outcome'),
      canceled_by: text('canceled_by'),
      notes: text('notes'),
      new_date: text('new_date'),
      new_time: text('new_time'),
      next_type: text('next_type'),
      next_date: text('next_date'),
    },
    text('start')
  );
  // Rescheduled stays open in HubSpot, so the list shows it at its new time.
  const query = new URLSearchParams({
    logged: meetingId,
    outcome: result.outcome === 'RESCHEDULED' ? 'SCHEDULED' : result.outcome,
    ...(result.newStartAt === null ? {} : { start: String(result.newStartAt) }),
    ...(result.nextTaskId ? { next: result.nextTaskId, created: result.nextTaskCreated ? '1' : '0' } : {}),
    ...(result.inviteUpdated ? { invite: '1' } : {}),
  });
  return c.redirect(`/meetings?${query}`, 303);
});

mountDialRoutes(meetingsRoute, 'meeting');

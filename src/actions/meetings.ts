// What the interview pages and the Claude connector both do with meetings:
// the list, and logging how one went. Each checks, runs the workflow and
// writes the audit row; the caller only parses its input and answers.

import type { Context } from 'hono';
import { googleCalendar, insightDeps, loadAppSettings, type AppSettings } from '../lib/app-settings';
import { afterResponse } from '../lib/background';
import { localDate, parseHubSpotTime } from '../lib/dates';
import { d1ConversationStore, d1DialStore, d1MeetingLogStore, insertAudit, type Dial } from '../lib/db';
import { createHubSpot, HubSpotApiError, type HubSpot } from '../lib/hubspot';
import { dialTranscript } from '../lib/transcript';
import type { AppEnv, Env } from '../types';
import { readInterview } from '../workflows/call-insight';
import { dialState, isLive } from '../workflows/dial';
import { parseMeetingLogForm, runMeetingLogged, type MeetingLoggedResult } from '../workflows/meeting-logged';
import type { MeetingOutcome } from '../lib/hubspot';
import { applyLoggedOutcome, loadMeetings, type MeetingRow } from '../workflows/meeting-queue';
import { contactName, WorkflowError } from '../workflows/parties';
import { countFromLog } from './coaching';

// The latest call made from this interview's page.
export async function latestMeetingDial(env: Env, meetingId: string): Promise<Dial | null> {
  const dial = await d1DialStore(env.DB).latestForTask(meetingId);
  return dial?.subject === 'meeting' ? dial : null;
}

// A 403 on meetings means the HubSpot app's token can't read them yet.
function meetingsError(err: unknown): string {
  if (err instanceof HubSpotApiError && err.status === 403) {
    return 'HubSpot refused to list meetings (403): the app’s HubSpot token needs access to meetings (see README).';
  }
  throw err;
}

export interface MeetingsOverview {
  hs: HubSpot;
  now: number;
  settings: AppSettings;
  rows: MeetingRow[];
  error: string | null; // why HubSpot's meetings couldn't be read
}

// Interviews from a week back to two weeks ahead. `logged` is an outcome the
// page's redirect reports, which HubSpot's search may not show yet.
export async function meetingsOverview(
  c: Context<AppEnv>,
  logged: { meetingId: string; outcome: MeetingOutcome; startAt: number | null } | null = null
): Promise<MeetingsOverview> {
  const now = Date.now();
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  const [settings, loaded] = await Promise.all([
    loadAppSettings(c.env),
    loadMeetings(hs, now).then(
      (rows) => ({ rows, error: null }),
      (err: unknown) => ({ rows: [], error: meetingsError(err) })
    ),
  ]);
  return { hs, now, settings, rows: applyLoggedOutcome(loaded.rows, logged), error: loaded.error };
}

// The interview's outcome and notes on the meeting (or its new time), the
// follow-up task and Lead Status. `form` has the log form's fields (see
// parseMeetingLogForm); `seenStart` is the start time the rep saw, so a
// meeting moved since isn't logged against the wrong time.
export async function logMeeting(
  c: Context<AppEnv>,
  meetingId: string,
  form: Record<string, string | undefined>,
  seenStart: string | undefined
): Promise<MeetingLoggedResult> {
  const actor = c.get('actor');
  const now = Date.now();
  const settings = await loadAppSettings(c.env);
  const { timeZone } = settings;
  const input = parseMeetingLogForm(form, localDate(now, timeZone));
  // Like a call task: a form left open in another tab can't log the
  // interview while a call from its page is still going.
  const dial = await latestMeetingDial(c.env, meetingId);
  if (dial && isLive(dialState(dial, Math.floor(now / 1000)))) {
    throw new WorkflowError('A call from this interview is still in progress. Log it once the call has ended.', 409);
  }
  try {
    const result = await runMeetingLogged(
      createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN),
      d1MeetingLogStore(c.env.DB),
      meetingId,
      parseHubSpotTime(seenStart),
      { ...input, transcript: dial ? dialTranscript(dial) : null },
      { now, timeZone, calendar: googleCalendar(c.env, settings) }
    );
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'meeting',
      taskId: meetingId,
      action: `log interview ${result.outcome} + follow-up + lead status`,
      outcome: 'success',
      detail: result,
    });
    // A real conversation, if the rep ticked it. The interview is logged by
    // now, so a failure here is only logged: Coaching's Count is the way back.
    if (input.outcome === 'COMPLETED' && form.conversation === '1') {
      await countInterview(c, form, meetingId, result).catch((err: unknown) =>
        console.error('counting the interview as a real conversation', err)
      );
    }
    // Coaching reads the interview (its recording, or these notes) in the
    // background, as it does a logged call.
    afterResponse(c, 'reading the interview for coaching', () =>
      readInterview(insightDeps(c.env), meetingId, Date.now())
    );
    return result;
  } catch (err) {
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'meeting',
      taskId: meetingId,
      action: 'log interview',
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// `who` is read with the meeting; a log finished on an earlier run keeps the
// name it was counted under, else asks HubSpot.
async function countInterview(
  c: Context<AppEnv>,
  form: Record<string, string | undefined>,
  meetingId: string,
  result: MeetingLoggedResult
): Promise<void> {
  const who =
    result.who ??
    (await d1ConversationStore(c.env.DB).get('interview', meetingId))?.who ??
    contactName(
      await createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN).getObject('contacts', result.contactId, [
        'firstname',
        'lastname',
        'email',
      ])
    );
  await countFromLog(c, form, {
    kind: 'interview',
    refId: meetingId,
    contactId: result.contactId,
    who,
    outcome: result.outcome,
  });
}

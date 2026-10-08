import type { Env } from '../types';
import { CLAUDE_MODELS, EFFORT_LEVELS, type ClaudeModel, type EffortLevel } from './claude';
import {
  withAccessToken,
  calendarEventId,
  cancelCalendarEvent,
  insertCalendarEvent,
  moveCalendarEvent,
  sendRawMessage,
} from './google';
import { decrypt } from './secretbox';
import { createTwilio, type Twilio } from './twilio';
import { clientIdentity, voiceAccessToken } from './voice-token';
import { workersAiTranscriber } from './ai';
import { stateTimeZone } from './address';
import { parsePlan, type WorkPlan } from './work-plan';
import { whatsappOpens, type WhatsAppOpens } from './whatsapp';
import {
  d1CallInsightStore,
  d1CallReviewStore,
  d1CallLogStore,
  d1DialStore,
  d1InboundCallStore,
  d1MeetingLogStore,
  DIAL_MODES,
  getSettings,
  type DialMode,
} from './db';
import { createHubSpot } from './hubspot';
import { formatPhone } from './phone';
import type { InsightDeps } from '../workflows/call-insight';
import type { SweepDeps } from '../workflows/coaching-sweep';
import type { TranscribeDeps } from '../workflows/transcribe';
import type { InboundTranscribeDeps } from '../workflows/inbound';
import type { Mailer } from '../workflows/send-email';
import type { Calendar, Invite } from '../workflows/book-interview';
import { WorkflowError } from '../workflows/parties';

export interface AppSettings {
  signatureHtml: string | null;
  fromName: string;
  claudeModel: ClaudeModel;
  claudeEffort: EffortLevel;
  googleEmail: string | null;
  googleRefreshTokenSealed: string | null;
  trackOpens: boolean;
  trackClicks: boolean;
  logToHubSpot: boolean;
  repPhone: string | null; // E.164; the phone Twilio rings first for click-to-call
  twilioFromNumber: string | null; // E.164; caller ID on both legs, picked from the account's numbers
  recordCalls: boolean; // record every call (with a notice to the prospect) and transcribe it
  callWith: DialMode; // ring the rep's phone, or talk through the call page
  whatsappOpens: WhatsAppOpens; // where a WhatsApp link opens: the Desktop app or WhatsApp Web
  timeZone: string; // IANA zone every time is shown and scheduled in: the setting, else TZ
  callScript: string | null; // shown on every call page, edited there
  callPlan: WorkPlan | null; // today's calls in order, saved by the Calls page
  emailPlan: WorkPlan | null; // today's emails in order, saved by the Queue page
}

export const DEFAULT_FROM_NAME = 'Anel Canto';

export async function loadAppSettings(env: Env): Promise<AppSettings> {
  const s = await getSettings(env.DB);
  const model = CLAUDE_MODELS.find((m) => m === s.claude_model) ?? 'claude-opus-5';
  const effort = EFFORT_LEVELS.find((e) => e === s.claude_effort) ?? 'high';
  return {
    signatureHtml: s.signature_html?.trim() || null,
    fromName: s.from_name?.trim() || DEFAULT_FROM_NAME,
    claudeModel: model,
    claudeEffort: effort,
    googleEmail: s.google_email ?? null,
    googleRefreshTokenSealed: s.google_refresh_token ?? null,
    // Opens default off: for cold email the pixel costs deliverability and
    // Apple Mail pre-loading makes the numbers unreliable anyway. Replies are
    // the signal that counts. Clicks default on. Both switch on /settings.
    trackOpens: s.track_opens === '1',
    trackClicks: s.track_clicks !== '0',
    // Off by default: with the Gmail inbox connected to HubSpot, HubSpot
    // already logs every email sent from it, so the app logging it too made
    // duplicates (seen in the first live test, 2026-09-25).
    logToHubSpot: s.log_to_hubspot === '1',
    repPhone: s.rep_phone || null,
    twilioFromNumber: s.twilio_from_number || null,
    // Off until the rep turns it on: recording needs the prospect told first.
    recordCalls: s.record_calls === '1',
    callWith: dialMode(s.call_with),
    whatsappOpens: whatsappOpens(s.whatsapp_opens),
    timeZone: s.time_zone && isTimeZone(s.time_zone) ? s.time_zone : env.TZ,
    callScript: s.call_script?.trim() ? s.call_script : null,
    callPlan: parsePlan(s.call_plan),
    emailPlan: parsePlan(s.email_plan),
  };
}

// An IANA time zone this runtime knows, e.g. "America/Denver".
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

// The Worker can reach Twilio. Which numbers to use is picked on /settings.
export function twilioConfigured(env: Env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
}

export function twilioClient(env: Env): Twilio {
  if (!twilioConfigured(env)) throw new WorkflowError('Twilio isn’t connected on this Worker yet (see README).');
  return createTwilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
}

// How the rep calls, from the setting or the Settings form: the phone unless
// it names another mode.
export function dialMode(value: unknown): DialMode {
  return DIAL_MODES.find((m) => m === value) ?? 'phone';
}

// The Worker can hand the call page a token for Twilio's Voice SDK.
export function browserCallingConfigured(env: Env): boolean {
  return (
    twilioConfigured(env) && Boolean(env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET && env.TWILIO_TWIML_APP_SID)
  );
}

// Longer than any call: the SDK's signalling, hanging up included, stops when
// the token expires. A leaked token can still only start what
// /twilio/voice/client accepts: a fresh browser dial's call, once.
const VOICE_TOKEN_TTL_SEC = 4 * 60 * 60;

export function browserCallToken(env: Env, actor: string, nowMs: number): Promise<string> {
  if (!browserCallingConfigured(env)) {
    throw new WorkflowError(
      'Calling from the browser isn’t set up on this Worker yet (TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET and TWILIO_TWIML_APP_SID; see README). Switch to your phone in Settings meanwhile.'
    );
  }
  return voiceAccessToken({
    accountSid: env.TWILIO_ACCOUNT_SID!,
    apiKeySid: env.TWILIO_API_KEY_SID!,
    apiKeySecret: env.TWILIO_API_KEY_SECRET!,
    appSid: env.TWILIO_TWIML_APP_SID!,
    identity: clientIdentity(actor),
    nowSec: Math.floor(nowMs / 1000),
    ttlSec: VOICE_TOKEN_TTL_SEC,
  });
}

// Everything runTranscription needs, from the Worker's bindings.
export function transcribeDeps(env: Env): TranscribeDeps {
  if (!env.AI) throw new WorkflowError('Workers AI isn’t bound to this Worker (the "ai" binding in wrangler.jsonc).');
  const twilio = twilioClient(env);
  return {
    dials: d1DialStore(env.DB),
    callLogs: d1CallLogStore(env.DB),
    hs: createHubSpot(env.HUBSPOT_ACCESS_TOKEN),
    ai: workersAiTranscriber(env.AI),
    recording: (sid, channels) => twilio.recording(sid, { channels }),
  };
}

// Everything runInboundTranscription needs, from the Worker's bindings.
export function inboundTranscribeDeps(env: Env): InboundTranscribeDeps {
  const { ai, hs, recording } = transcribeDeps(env);
  return { calls: d1InboundCallStore(env.DB), hs, ai, recording };
}

// Everything reading calls for coaching needs (workflows/call-insight.ts).
export function insightDeps(env: Env): InsightDeps {
  const hs = createHubSpot(env.HUBSPOT_ACCESS_TOKEN);
  const zoneOf = async (type: 'contacts' | 'companies', id: string) => {
    const [record] = await hs.batchRead(type, [id], ['state', 'country']);
    return record ? stateTimeZone(record.properties.state, record.properties.country) : null;
  };
  return {
    callLogs: d1CallLogStore(env.DB),
    dials: d1DialStore(env.DB),
    meetingLogs: d1MeetingLogStore(env.DB),
    insights: d1CallInsightStore(env.DB),
    reviews: d1CallReviewStore(env.DB),
    place: async (contactId, companyId) =>
      (await zoneOf('contacts', contactId)) ?? (companyId ? await zoneOf('companies', companyId) : null),
  };
}

// Everything the cron sweep needs (workflows/coaching-sweep.ts). Without
// Workers AI or Twilio it only reads calls.
export function sweepDeps(env: Env): SweepDeps {
  let transcribe: TranscribeDeps | null = null;
  try {
    transcribe = transcribeDeps(env);
  } catch (err) {
    console.error('coaching sweep: no transcription', err);
  }
  return { insight: insightDeps(env), transcribe, baseUrl: env.PUBLIC_BASE_URL };
}

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY);
}

// Sends as the Google account connected on /settings.
export async function gmailMailer(env: Env, settings: AppSettings): Promise<Mailer> {
  if (!googleConfigured(env)) {
    throw new WorkflowError(
      "Gmail sending isn't set up yet: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY are needed."
    );
  }
  if (!settings.googleEmail || !settings.googleRefreshTokenSealed) {
    throw new WorkflowError('No Gmail account connected. Connect one on the Settings page.');
  }
  const refreshToken = await decrypt(settings.googleRefreshTokenSealed, env.TOKEN_ENCRYPTION_KEY!);
  const cfg = { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! };
  return {
    fromEmail: settings.googleEmail,
    async send(raw) {
      return withAccessToken(refreshToken, cfg, (token) => sendRawMessage(token, raw));
    },
  };
}

// What the invite tells the contact about how to join.
export function inviteDescription(invite: Pick<Invite, 'joinUrl' | 'phone'>): string {
  if (invite.phone) {
    return (
      `Thanks for making the time to talk. I'll call you at ${formatPhone(invite.phone)}. ` +
      "If another number's better, just reply and let me know."
    );
  }
  return invite.joinUrl
    ? `Thanks for making the time to talk. Join here: ${invite.joinUrl}`
    : 'Thanks for making the time to talk. The Google Meet link is on this invite.';
}

// The connected Google account's calendar, for interview invites. It's the
// same connection as Gmail sending: connecting in Settings asks for both.
export function googleCalendar(env: Env, settings: AppSettings): Calendar {
  const withToken = async <T>(call: (token: string) => Promise<T>): Promise<T> => {
    if (!googleConfigured(env) || !settings.googleRefreshTokenSealed) {
      throw new WorkflowError(
        'No Google account connected, so the calendar invite can’t be changed. Connect one in Settings.'
      );
    }
    const refreshToken = await decrypt(settings.googleRefreshTokenSealed, env.TOKEN_ENCRYPTION_KEY!);
    return withAccessToken(
      refreshToken,
      { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! },
      call
    );
  };
  return {
    async invite(invite) {
      const eventId = await calendarEventId(invite.key);
      const event = await withToken((token) =>
        insertCalendarEvent(token, {
          id: eventId,
          summary: `${settings.fromName} and ${invite.withWhom}`,
          description: inviteDescription(invite),
          startAt: invite.startAt,
          endAt: invite.endAt,
          timeZone: settings.timeZone,
          attendeeEmail: invite.attendeeEmail,
          location: invite.phone ? 'Phone call' : invite.joinUrl,
          withMeet: !invite.phone && !invite.joinUrl,
        })
      );
      return { eventId: event.id, meetUrl: event.meetUrl };
    },
    async move(eventId, startAt, endAt) {
      await withToken((token) => moveCalendarEvent(token, eventId, { startAt, endAt, timeZone: settings.timeZone }));
    },
    async cancel(eventId) {
      await withToken((token) => cancelCalendarEvent(token, eventId));
    },
  };
}

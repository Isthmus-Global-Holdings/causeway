// Google OAuth, Gmail send and Calendar invites for the rep's connected
// account (isthmusglobalholdings@gmail.com, the same account HubSpot sends
// from).
//
// Scopes are the minimum: gmail.send can send but not read mail,
// calendar.events can add events (interview invites) but not read other
// calendars, and openid/email tells us which account signed in. Both are
// "sensitive" scopes, so an unverified app in Production works for the
// account owner after a one-time warning screen. A read scope like
// gmail.readonly is "restricted" and would need Google's security review, so
// the app never asks for one.

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
];

export class GoogleApiError extends Error {
  // The API is turned off in the app's Google Cloud project (403
  // SERVICE_DISABLED): Google did nothing, and only enabling it there fixes it.
  readonly apiDisabled: boolean;

  constructor(
    readonly status: number,
    readonly body: string,
    readonly what: string
  ) {
    const disabled = status === 403 && /SERVICE_DISABLED|accessNotConfigured/.test(body);
    super(disabled ? apiDisabledMessage(what, body) : `Google ${what} failed (${status}): ${body.slice(0, 300)}`);
    this.apiDisabled = disabled;
  }
}

// Kept on the row as its error, so the "didn't finish" notice says what to do.
function apiDisabledMessage(what: string, body: string): string {
  const api = what === 'calendar' ? 'Google Calendar API' : 'Gmail API';
  const link = /https:\/\/console\.developers\.google\.com\/apis\/api\/[^\s"\\]+/.exec(body)?.[0];
  return (
    `The ${api} is turned off in the app's Google Cloud project, so nothing was sent to Google. ` +
    `Enable it${link ? ` at ${link}` : ' under APIs & Services → Library in Google Cloud'}, wait a few minutes, then try again.`
  );
}

// The refresh token no longer works: Google expired it (an OAuth app left in
// Testing signs out after 7 days) or the account revoked it, for instance
// with a password change. Nothing reached Gmail or Calendar, and nothing but
// reconnecting in Settings fixes it, so the message says so.
export class GoogleConnectionExpiredError extends GoogleApiError {
  constructor(status: number, body: string) {
    super(status, body, 'token refresh');
    this.message =
      'The Google connection has expired or was revoked, so nothing was sent to Google. Reconnect Gmail in Settings, then try again.';
  }
}

export function authorizationUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline + consent: Google only returns a refresh token on consent.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number; // seconds
  refresh_token?: string;
  id_token?: string;
}

async function tokenRequest(body: Record<string, string>, what: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new GoogleApiError(res.status, text, what);
  return JSON.parse(text) as TokenResponse;
}

function emailFromIdToken(idToken: string, clientId: string): string {
  // Received straight from Google's token endpoint over TLS, so the payload
  // is trusted without a signature check. The audience check still guards
  // against a token meant for another app.
  const payload = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    )
  ) as { aud: string; email?: string; email_verified?: boolean };
  if (payload.aud !== clientId) throw new Error('Google id_token audience mismatch');
  if (!payload.email || payload.email_verified === false) throw new Error('Google account email not verified');
  return payload.email;
}

export async function exchangeCode(
  code: string,
  cfg: { clientId: string; clientSecret: string; redirectUri: string }
): Promise<{ refreshToken: string; email: string }> {
  const tokens = await tokenRequest(
    {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    },
    'code exchange'
  );
  if (!tokens.refresh_token || !tokens.id_token) {
    throw new Error('Google did not return a refresh token. Remove the app from the Google account and connect again.');
  }
  return { refreshToken: tokens.refresh_token, email: emailFromIdToken(tokens.id_token, cfg.clientId) };
}

// An access token lasts about an hour. Getting a new one before every send
// or invite cost a round trip to Google each time, so each Worker instance
// keeps the current one until a minute before it expires (like the Access
// keys in middleware/access.ts). Keyed by refresh token: reconnecting the
// account starts afresh.
const TOKEN_MARGIN_MS = 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function accessToken(
  refreshToken: string,
  cfg: { clientId: string; clientSecret: string },
  now: () => number = Date.now
): Promise<string> {
  const cached = tokenCache.get(refreshToken);
  if (cached && now() < cached.expiresAt - TOKEN_MARGIN_MS) return cached.token;
  const tokens = await tokenRequest(
    {
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
    },
    'token refresh'
  ).catch((err: unknown) => {
    if (err instanceof GoogleApiError && err.status === 400 && /"invalid_grant"/.test(err.body)) {
      throw new GoogleConnectionExpiredError(err.status, err.body);
    }
    throw err;
  });
  if (tokens.expires_in) {
    tokenCache.set(refreshToken, { token: tokens.access_token, expiresAt: now() + tokens.expires_in * 1000 });
  }
  return tokens.access_token;
}

// Runs one Google call with the current access token. A 401 means Google
// refused the token (revoked early, say) and did nothing, so the call is
// made once more with a new one.
export async function withAccessToken<T>(
  refreshToken: string,
  cfg: { clientId: string; clientSecret: string },
  call: (token: string) => Promise<T>
): Promise<T> {
  try {
    return await call(await accessToken(refreshToken, cfg));
  } catch (err) {
    if (!(err instanceof GoogleApiError && err.status === 401)) throw err;
    tokenCache.delete(refreshToken);
    return call(await accessToken(refreshToken, cfg));
  }
}

export async function sendRawMessage(token: string, rawBase64Url: string): Promise<{ id: string; threadId: string }> {
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: rawBase64Url }),
  });
  const text = await res.text();
  if (!res.ok) throw new GoogleApiError(res.status, text, 'send');
  return JSON.parse(text) as { id: string; threadId: string };
}

export interface NewCalendarEvent {
  id: string; // chosen by the app (calendarEventId), so a retry can't make a second
  summary: string;
  description: string;
  startAt: string; // ISO
  endAt: string;
  timeZone: string;
  attendeeEmail: string;
  location: string | null; // a join link the rep gave, if any
  withMeet: boolean; // add a Google Meet link
}

interface EventResource {
  id: string;
  status?: string; // 'cancelled' once deleted
  hangoutLink?: string;
  start?: { dateTime?: string };
}

async function getCalendarEvent(token: string, eventId: string): Promise<EventResource | null> {
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new GoogleApiError(res.status, text, 'calendar');
  return JSON.parse(text) as EventResource;
}

// Moves an event and emails the attendee the new time. An event already at
// that time (a retry) or no longer there is left alone, so nobody gets the
// same update twice.
export async function moveCalendarEvent(
  token: string,
  eventId: string,
  move: { startAt: string; endAt: string; timeZone: string }
): Promise<void> {
  const event = await getCalendarEvent(token, eventId);
  if (!event || event.status === 'cancelled') return;
  if (event.start?.dateTime && Date.parse(event.start.dateTime) === Date.parse(move.startAt)) return;
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: { dateTime: move.startAt, timeZone: move.timeZone },
      end: { dateTime: move.endAt, timeZone: move.timeZone },
    }),
  });
  if (!res.ok) throw new GoogleApiError(res.status, await res.text(), 'calendar');
}

// Cancels an event and emails the attendee. One already gone is fine.
export async function cancelCalendarEvent(token: string, eventId: string): Promise<void> {
  const res = await fetch(`${EVENTS_URL}/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok || res.status === 404 || res.status === 410) return;
  throw new GoogleApiError(res.status, await res.text(), 'calendar');
}

// Adds the event to the account's primary calendar and emails the invite to
// the attendee. An event with this id already there (a retry) is returned
// as it is, without sending anything.
export async function insertCalendarEvent(
  token: string,
  event: NewCalendarEvent
): Promise<{ id: string; meetUrl: string | null }> {
  const res = await fetch(`${EVENTS_URL}?conferenceDataVersion=1&sendUpdates=all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: event.id,
      summary: event.summary,
      description: event.description,
      ...(event.location ? { location: event.location } : {}),
      start: { dateTime: event.startAt, timeZone: event.timeZone },
      end: { dateTime: event.endAt, timeZone: event.timeZone },
      attendees: [{ email: event.attendeeEmail }],
      ...(event.withMeet
        ? {
            conferenceData: { createRequest: { requestId: event.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
          }
        : {}),
    }),
  });
  const text = await res.text();
  if (res.status === 409) {
    const found = await fetch(`${EVENTS_URL}/${encodeURIComponent(event.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await found.text();
    if (!found.ok) throw new GoogleApiError(found.status, body, 'calendar');
    const existing = JSON.parse(body) as EventResource;
    return { id: existing.id, meetUrl: existing.hangoutLink ?? null };
  }
  if (!res.ok) throw new GoogleApiError(res.status, text, 'calendar');
  const created = JSON.parse(text) as EventResource;
  return { id: created.id, meetUrl: created.hangoutLink ?? null };
}

// Google Calendar event ids are 5 to 1024 characters of base32hex (a-v, 0-9).
// Hex digits are a subset, so a hash of the booking's key works.
export async function calendarEventId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `hsa${hex.slice(0, 40)}`;
}

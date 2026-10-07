// What to tell the rep when a request fails: the pages show it as an error
// page (src/index.ts), the Claude connector as a tool error (src/mcp/tools.ts).
// Every step in the workflows is safe to repeat, so most say to try again.

import { ClaudeDraftError } from './claude';
import { missingMigration } from './db';
import { GoogleApiError, GoogleConnectionExpiredError } from './google';
import { HubSpotApiError, missingScopes, RateLimitError } from './hubspot';
import { TwilioApiError } from './twilio';
import { WorkflowError } from '../workflows/parties';

export interface ErrorDescription {
  title: string;
  message: string;
  status: 400 | 404 | 409 | 500 | 502 | 503;
  // An unexpected failure, worth the Worker's log (a WorkflowError is the rep's doing).
  log: boolean;
}

// Why a call's recording didn't start, for the call page. 21220: the call was
// no longer in progress, because it ended in the seconds after it was answered.
export function recordingNotStarted(err: unknown): string {
  if (err instanceof TwilioApiError && err.code === 21220) {
    return 'The call ended before the recording could start, so there’s nothing to transcribe.';
  }
  return `The recording didn't start: ${err instanceof Error ? err.message : String(err)}`;
}

export function describeError(err: unknown): ErrorDescription {
  if (err instanceof WorkflowError) {
    return { title: 'Can’t do that', message: err.message, status: err.status, log: false };
  }
  if (err instanceof RateLimitError) {
    return {
      title: 'HubSpot rate limit',
      message: `HubSpot asked us to slow down. Try again in ${err.retryAfterSec} seconds.`,
      status: 503,
      log: false,
    };
  }
  if (err instanceof GoogleConnectionExpiredError) {
    return { title: 'Google connection expired', message: err.message, status: 502, log: false };
  }
  if (err instanceof GoogleApiError && err.apiDisabled) {
    return { title: 'Google API turned off', message: err.message, status: 502, log: false };
  }
  if (err instanceof GoogleApiError && err.what === 'calendar') {
    // The OAuth client's Google Cloud project hasn't turned the Calendar API on:
    // reconnecting can't fix that, only enabling it can (Google's body links the page).
    const disabled = err.status === 403 && /SERVICE_DISABLED|accessNotConfigured/.test(err.body);
    const enableUrl =
      /https:\/\/console\.developers\.google\.com\/apis\/api\/calendar-json\.googleapis\.com\/overview\?project=\d+/.exec(
        err.body
      )?.[0];
    const message = disabled
      ? `The Google Calendar API is turned off in the app’s Google Cloud project. Enable it${enableUrl ? ` at ${enableUrl}` : ' in Google Cloud (APIs & Services)'}, wait a few minutes, then try again. The interview wasn’t booked yet.`
      : err.status === 401 || err.status === 403
        ? 'Google Calendar refused the invite. Reconnect Gmail in Settings so the app can add calendar events (and check the Calendar API is enabled in Google Cloud), then try again. The interview wasn’t booked yet.'
        : `Google Calendar returned an error (${err.status}). It’s safe to try again: the invite is never sent twice.`;
    return { title: 'Google Calendar error', message, status: 502, log: true };
  }
  if (err instanceof GoogleApiError) {
    const message =
      err.status === 400 || err.status === 401
        ? 'Gmail rejected the request. The Google connection may have expired: reconnect it in Settings, then try again.'
        : `Gmail returned an error (${err.status}), so it's unclear whether the email went out. Open the task's send page again in a minute: the app will ask you to check Gmail's Sent folder before doing anything.`;
    return { title: 'Gmail error', message, status: 502, log: true };
  }
  if (err instanceof TwilioApiError) {
    // Starting a call: a 4xx means Twilio refused it; anything else may have gone through.
    const startingCall = err.path.endsWith('/Calls.json');
    const message =
      err.status === 401 || err.status === 403
        ? 'Twilio rejected the app’s credentials. Check TWILIO_ACCOUNT_SID and the TWILIO_AUTH_TOKEN secret.'
        : !startingCall
          ? `Twilio returned an error (${err.status}). It’s safe to try again.`
          : err.status < 500
            ? `Twilio refused the call (${err.status}), so your phone wasn’t rung and nobody was dialled. It’s safe to try again.`
            : `Twilio returned an error (${err.status}), so it's unclear whether the call started. If your phone rings, answer it as usual. Otherwise the Call button comes back within two minutes.`;
    return { title: 'Twilio error', message, status: 502, log: true };
  }
  if (err instanceof ClaudeDraftError) {
    return { title: 'Claude couldn’t draft this', message: err.message, status: 502, log: false };
  }
  const scopes = missingScopes(err);
  if (scopes) {
    return {
      title: 'HubSpot app is missing a scope',
      message: `HubSpot refused the request because the app hasn’t been granted ${scopes.length > 1 ? `any of these scopes: ${scopes.join(', ')}` : `the ${scopes[0] ?? 'needed'} scope`}. Add one to hubspot/src/app/app-hsmeta.json, run npm run hs:upload, and approve the new scope on the app's install.`,
      status: 502,
      log: true,
    };
  }
  if (err instanceof HubSpotApiError) {
    return err.status === 404
      ? { title: 'HubSpot error', message: 'HubSpot couldn’t find that record.', status: 404, log: true }
      : {
          title: 'HubSpot error',
          message: `HubSpot returned an error (${err.status}). It’s safe to go back and try again.`,
          status: 502,
          log: true,
        };
  }
  const missing = missingMigration(err);
  if (missing) {
    return {
      title: 'Database needs a migration',
      message: `The database is behind the code (${missing}). Run npm run db:migrate (npm run db:migrate:local for local dev), then try again: every step is safe to repeat.`,
      status: 500,
      log: true,
    };
  }
  return {
    title: 'Something went wrong',
    message: 'Unexpected error. It’s safe to go back and try again.',
    status: 500,
    log: true,
  };
}

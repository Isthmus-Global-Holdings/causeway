import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  browserCallingConfigured,
  dialMode,
  googleConfigured,
  isTimeZone,
  loadAppSettings,
  twilioClient,
  twilioConfigured,
} from '../lib/app-settings';
import { CLAUDE_MODELS, EFFORT_LEVELS } from '../lib/claude';
import { deleteSetting, insertAudit, setSetting, type DialMode } from '../lib/db';
import { authorizationUrl, exchangeCode } from '../lib/google';
import { encrypt } from '../lib/secretbox';
import { randomToken } from '../lib/tracking';
import { listedNumber, TwilioApiError } from '../lib/twilio';
import { whatsappOpens } from '../lib/whatsapp';
import type { AppEnv } from '../types';
import { settingsPage, type ConnectorState, type TwilioState } from '../views/settings';
import { WorkflowError } from '../workflows/parties';

export const settingsRoute = new Hono<AppEnv>();

const STATE_COOKIE = 'hsa_google_oauth_state';

function redirectUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}/oauth/google/callback`;
}

// What the Calling section shows: whether the Worker can reach Twilio, and
// if so the account's numbers to pick from.
async function twilioState(env: AppEnv['Bindings']): Promise<TwilioState> {
  if (!twilioConfigured(env)) return { status: 'not-configured' };
  try {
    return { status: 'connected', accountSid: env.TWILIO_ACCOUNT_SID!, numbers: await twilioClient(env).listNumbers() };
  } catch (err) {
    if (!(err instanceof TwilioApiError)) throw err;
    console.error(err.message);
    return {
      status: 'error',
      message:
        err.status === 401
          ? 'Twilio rejected the credentials. Check TWILIO_ACCOUNT_SID and the TWILIO_AUTH_TOKEN secret.'
          : `Twilio returned an error (${err.status}). Reload to try again.`,
    };
  }
}

// The Claude connector's URL, and the connections this rep approved
// (routes/authorize.ts). A failed listing doesn't take the page down.
async function connectorState(c: Context<AppEnv>): Promise<ConnectorState> {
  const url = `${new URL(c.req.url).origin}/mcp`;
  try {
    const { items } = await c.env.OAUTH_PROVIDER.listUserGrants(c.get('actor'));
    const grants = items.map((g) => ({
      id: g.id,
      label: typeof g.metadata?.label === 'string' ? g.metadata.label : g.clientId,
      connectedAt: g.createdAt * 1000,
    }));
    return { url, grants: grants.sort((a, b) => b.connectedAt - a.connectedAt) };
  } catch (err) {
    console.error('listing Claude connector grants', err);
    return { url, grants: null };
  }
}

settingsRoute.get('/settings', async (c) => {
  const [settings, twilio, connector] = await Promise.all([
    loadAppSettings(c.env),
    twilioState(c.env),
    connectorState(c),
  ]);
  return c.html(
    settingsPage(
      {
        settings,
        googleReady: googleConfigured(c.env),
        anthropicReady: Boolean(c.env.ANTHROPIC_API_KEY),
        twilio,
        browserReady: browserCallingConfigured(c.env),
        connector,
        flash: c.req.query('saved')
          ? 'Settings saved.'
          : c.req.query('google') === 'connected'
            ? 'Gmail connected.'
            : c.req.query('connector') === 'disconnected'
              ? 'Claude connector disconnected.'
              : null,
        error: null,
      },
      c.get('actor')
    )
  );
});

settingsRoute.post('/settings', async (c) => {
  const form = await c.req.parseBody();
  const text = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : '');
  // The two calling numbers are only in the form when Twilio answered, and
  // each must be one Twilio lists for the account. Checked before anything
  // is saved, so a bad pick doesn't half-save the form.
  let calling: { from: string; rep: string; record: boolean; callWith: DialMode } | null = null;
  if (typeof form.twilio_from_number === 'string' && typeof form.rep_phone === 'string') {
    const numbers = await twilioClient(c.env).listNumbers();
    const pick = (value: string, options: typeof numbers.voice, what: string) => {
      if (!value) return '';
      const listed = listedNumber(value, options);
      if (!listed)
        throw new WorkflowError(
          `${value} isn't one of the account's ${what} in Twilio. Reload Settings and pick again.`
        );
      return listed;
    };
    const callWith = dialMode(form.call_with);
    if (callWith === 'browser' && !browserCallingConfigured(c.env)) {
      throw new WorkflowError(
        'Calling from the browser isn’t set up on this Worker yet (see README). Pick My phone under Call with.'
      );
    }
    calling = {
      from: pick(form.twilio_from_number, numbers.voice, 'voice numbers'),
      rep: pick(form.rep_phone, numbers.verified, 'verified numbers'),
      record: form.record_calls === '1',
      callWith,
    };
  }

  await setSetting(c.env.DB, 'signature_html', text('signature_html').trim());
  await setSetting(c.env.DB, 'from_name', text('from_name').trim());
  if (isTimeZone(text('time_zone'))) await setSetting(c.env.DB, 'time_zone', text('time_zone'));
  const model = CLAUDE_MODELS.find((m) => m === text('claude_model'));
  const effort = EFFORT_LEVELS.find((e) => e === text('claude_effort'));
  // Unticked checkboxes aren't sent at all, so absence means off.
  await setSetting(c.env.DB, 'track_opens', form.track_opens === '1' ? '1' : '0');
  await setSetting(c.env.DB, 'track_clicks', form.track_clicks === '1' ? '1' : '0');
  await setSetting(c.env.DB, 'log_to_hubspot', form.log_to_hubspot === '1' ? '1' : '0');
  await setSetting(c.env.DB, 'whatsapp_opens', whatsappOpens(text('whatsapp_opens')));
  if (calling) {
    await setSetting(c.env.DB, 'twilio_from_number', calling.from);
    await setSetting(c.env.DB, 'rep_phone', calling.rep);
    await setSetting(c.env.DB, 'record_calls', calling.record ? '1' : '0');
    await setSetting(c.env.DB, 'call_with', calling.callWith);
  }
  if (model) await setSetting(c.env.DB, 'claude_model', model);
  if (effort) await setSetting(c.env.DB, 'claude_effort', effort);
  return c.redirect('/settings?saved=1', 303);
});

// Revokes one of the rep's connector approvals: its tokens stop working at once.
settingsRoute.post('/settings/connector/disconnect', async (c) => {
  const form = await c.req.parseBody();
  const grantId = typeof form.grant_id === 'string' ? form.grant_id : '';
  if (!grantId) throw new WorkflowError('Pick a connection to disconnect.');
  await c.env.OAUTH_PROVIDER.revokeGrant(grantId, c.get('actor'));
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: 'connector',
    taskId: '-',
    action: 'disconnect Claude connector',
    outcome: 'success',
    detail: { grantId },
  });
  return c.redirect('/settings?connector=disconnected', 303);
});

settingsRoute.post('/settings/google/disconnect', async (c) => {
  await deleteSetting(c.env.DB, 'google_refresh_token');
  await deleteSetting(c.env.DB, 'google_email');
  return c.redirect('/settings', 303);
});

// Step 1 of the Google sign-in. The random state in a short-lived cookie is
// checked on the way back, so a callback we didn't start is rejected.
settingsRoute.get('/oauth/google/start', (c) => {
  if (!googleConfigured(c.env)) throw new WorkflowError("Gmail sending isn't configured on this Worker yet.");
  const state = randomToken();
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/oauth/google',
    maxAge: 600,
  });
  return c.redirect(authorizationUrl(c.env.GOOGLE_CLIENT_ID!, redirectUri(c.req.url), state));
});

settingsRoute.get('/oauth/google/callback', async (c) => {
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/oauth/google' });
  const error = c.req.query('error');
  if (error) throw new WorkflowError(`Google sign-in was cancelled or failed (${error}).`);
  const code = c.req.query('code');
  if (!code || !expected || c.req.query('state') !== expected) {
    throw new WorkflowError('Google sign-in could not be verified. Start again from Settings.');
  }

  const { refreshToken, email } = await exchangeCode(code, {
    clientId: c.env.GOOGLE_CLIENT_ID!,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET!,
    redirectUri: redirectUri(c.req.url),
  });
  await setSetting(c.env.DB, 'google_refresh_token', await encrypt(refreshToken, c.env.TOKEN_ENCRYPTION_KEY!));
  await setSetting(c.env.DB, 'google_email', email);
  await insertAudit(c.env.DB, {
    actor: c.get('actor'),
    workflow: 'send-email',
    taskId: '-',
    action: `connect gmail ${email}`,
    outcome: 'success',
  });
  return c.redirect('/settings?google=connected', 303);
});

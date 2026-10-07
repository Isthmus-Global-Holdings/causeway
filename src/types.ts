import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  // The Claude connector's OAuth clients, grants and tokens (src/worker.ts).
  OAUTH_KV: KVNamespace;
  // Set by OAuthProvider on every request it hands to the app (routes/authorize.ts).
  OAUTH_PROVIDER: OAuthHelpers;
  AI?: Ai; // Workers AI: call transcripts and summaries

  // Secrets
  HUBSPOT_ACCESS_TOKEN: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string; // base64, 32 bytes; encrypts the Google refresh token in D1
  ANTHROPIC_API_KEY?: string; // only needed for "Draft with Claude"
  TWILIO_AUTH_TOKEN?: string; // calls Twilio's API and checks its webhook signatures
  TWILIO_API_KEY_SECRET?: string; // signs the browser's Voice SDK access tokens

  // Vars
  TZ: string; // default time zone; the one picked on /settings wins
  HUBSPOT_PORTAL_ID: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  GOOGLE_CLIENT_ID?: string;
  // Public origin put into tracking links. Always the deployed Worker, even in
  // local dev, since recipients can't reach localhost.
  PUBLIC_BASE_URL: string;
  TWILIO_ACCOUNT_SID?: string;
  // Calling from the browser: the API key (SK…) that signs access tokens, and
  // the TwiML App (AP…) whose Voice URL is /twilio/voice/client.
  TWILIO_API_KEY_SID?: string;
  TWILIO_TWIML_APP_SID?: string;
  // The Upwork pitch extension's ID (from the key in extension/manifest.json):
  // its origin may POST /pitches.
  PITCH_EXTENSION_ID?: string;

  // Local dev only (.dev.vars). Honoured only for requests to localhost.
  DEV_BYPASS_ACCESS?: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    // Email of the rep making the request, from the Cloudflare Access JWT, or
    // for the Claude connector the rep who approved it (src/mcp/app.ts).
    actor: string;
  };
}

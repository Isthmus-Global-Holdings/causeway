// The two Twilio things this app needs, in plain fetch and WebCrypto: start a
// call, and check that a webhook really came from Twilio. No SDK: the twilio
// package is Node-first and large, and each of these is one request or one HMAC.

const BASE_URL = 'https://api.twilio.com/2010-04-01';

export class TwilioApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string
  ) {
    super(`Twilio API ${status} on ${path}: ${body.slice(0, 500)}`);
  }

  // Twilio's own error code (https://www.twilio.com/docs/errors), when the body has one.
  get code(): number | null {
    try {
      const code = (JSON.parse(this.body) as { code?: unknown }).code;
      return typeof code === 'number' ? code : null;
    } catch {
      return null;
    }
  }
}

export interface NewCall {
  to: string; // E.164
  from: string; // a Twilio number on the account, E.164
  url: string; // TwiML webhook Twilio requests when the call is answered
  statusCallback: string; // requested once, with the call's final status
  timeoutSec: number; // how long to ring before giving up
}

export interface TwilioNumber {
  phoneNumber: string; // E.164
  friendlyName: string;
}

export interface AccountNumbers {
  // Numbers on the account that can place calls: the choices for "Call from".
  voice: TwilioNumber[];
  // Numbers the account owner verified with Twilio: the choices for "Your phone".
  verified: TwilioNumber[];
}

// Workflows take this interface, so tests can hand them a fake.
export interface Twilio {
  createCall(call: NewCall): Promise<{ sid: string }>;
  listNumbers(): Promise<AccountNumbers>;
  // A call recording's MP3, straight from Twilio (which requires auth to
  // download it). `range` is passed through so the app's audio player can seek.
  recording(sid: string, opts: { channels: number | null; range?: string | null }): Promise<Response>;
  // Starts a two-channel recording of an in-progress call (both legs, one
  // channel each); Twilio reports it to `callbackUrl` when it's ready.
  startRecording(callSid: string, callbackUrl: string): Promise<{ sid: string }>;
}

// The option the rep picked, only if it's one Twilio listed. A form can post
// anything, so a number must never be trusted just because it arrived.
export function listedNumber(value: string, options: TwilioNumber[]): string | null {
  return options.find((o) => o.phoneNumber === value)?.phoneNumber ?? null;
}

export function createTwilio(accountSid: string, authToken: string, fetchImpl: typeof fetch = fetch): Twilio {
  const auth = `Basic ${btoa(`${accountSid}:${authToken}`)}`;

  async function get<T>(path: string): Promise<T> {
    const res = await fetchImpl(BASE_URL + path, { headers: { Authorization: auth } });
    const text = await res.text();
    if (!res.ok) throw new TwilioApiError(res.status, text, path);
    return JSON.parse(text) as T;
  }

  return {
    async createCall(call) {
      const path = `/Accounts/${accountSid}/Calls.json`;
      const res = await fetchImpl(BASE_URL + path, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: call.to,
          From: call.from,
          Url: call.url,
          Method: 'POST',
          StatusCallback: call.statusCallback,
          StatusCallbackMethod: 'POST',
          Timeout: String(call.timeoutSec),
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new TwilioApiError(res.status, text, path);
      return { sid: (JSON.parse(text) as { sid: string }).sid };
    },

    async startRecording(callSid, callbackUrl) {
      const path = `/Accounts/${accountSid}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;
      const res = await fetchImpl(BASE_URL + path, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          RecordingChannels: 'dual',
          RecordingStatusCallback: callbackUrl,
          RecordingStatusCallbackMethod: 'POST',
          RecordingStatusCallbackEvent: 'completed',
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new TwilioApiError(res.status, text, path);
      return { sid: (JSON.parse(text) as { sid: string }).sid };
    },

    async recording(sid, { channels, range }) {
      // Two channels keep the rep and the prospect apart; asking for 2 on a
      // one-channel recording is an error, so only ask when there are 2.
      const query = channels === 2 ? '?RequestedChannels=2' : '';
      return fetchImpl(`${BASE_URL}/Accounts/${accountSid}/Recordings/${encodeURIComponent(sid)}.mp3${query}`, {
        headers: { Authorization: auth, ...(range ? { Range: range } : {}) },
      });
    },

    // One page of 100 each: far more numbers than one rep's account holds.
    async listNumbers() {
      type Raw = { phone_number: string; friendly_name: string; capabilities?: { voice?: boolean } };
      const [incoming, verified] = await Promise.all([
        get<{ incoming_phone_numbers: Raw[] }>(`/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=100`),
        get<{ outgoing_caller_ids: Raw[] }>(`/Accounts/${accountSid}/OutgoingCallerIds.json?PageSize=100`),
      ]);
      const toNumber = (n: Raw): TwilioNumber => ({ phoneNumber: n.phone_number, friendlyName: n.friendly_name });
      return {
        voice: incoming.incoming_phone_numbers.filter((n) => n.capabilities?.voice).map(toNumber),
        verified: verified.outgoing_caller_ids.map(toNumber),
      };
    },
  };
}

// X-Twilio-Signature: base64 HMAC-SHA1, keyed with the auth token, of the full
// request URL followed by every POST parameter as name+value, sorted by name.
// https://www.twilio.com/docs/usage/security#validating-requests
export async function validTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined
): Promise<boolean> {
  if (!signature) return false;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((name) => name + params[name])
      .join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...mac));
  // Compare every character so the time taken doesn't reveal how much matched.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

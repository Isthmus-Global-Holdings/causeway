// The TwiML documents the bridge answers with. Twilio runs them on the rep's
// leg of the call: first a prompt, then, once the rep presses 1, the dial to
// the prospect. https://www.twilio.com/docs/voice/twiml
// The second half answers calls to the Twilio number (workflows/inbound.ts).

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function response(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

// Played when the rep picks up. Nothing reaches the prospect until the rep
// presses 1, so a rep's voicemail answering can never dial them.
export function bridgePrompt(contactLabel: string, connectUrl: string): string {
  return response(
    `<Gather numDigits="1" timeout="10" action="${escapeXml(connectUrl)}" method="POST">` +
      `<Say>Call to ${escapeXml(contactLabel)}. Press 1 to connect.</Say>` +
      `</Gather><Say>No key pressed. Goodbye.</Say>`
  );
}

// With `noticeUrl`, the prospect hears the recording notice when they answer,
// before being connected; the rep doesn't (it plays on the prospect's leg
// only). Recording itself starts after the notice (recordingNotice).
// With `extension`, Twilio keys it in once the line answers, after a two
// second pause ("w" waits half a second) for the phone menu to start
// listening. The rep can still key digits in by hand if the menu wants more.
export function dialProspect(opts: {
  to: string;
  callerId: string;
  statusCallbackUrl: string;
  noticeUrl?: string | null;
  extension?: string | null;
}): string {
  const notice = opts.noticeUrl ? ` url="${escapeXml(opts.noticeUrl)}" method="POST"` : '';
  const digits = opts.extension && /^\d+$/.test(opts.extension) ? ` sendDigits="wwww${opts.extension}"` : '';
  return response(
    `<Dial callerId="${escapeXml(opts.callerId)}" timeout="30">` +
      `<Number statusCallback="${escapeXml(opts.statusCallbackUrl)}" statusCallbackMethod="POST"${notice}${digits}>${escapeXml(opts.to)}</Number>` +
      `</Dial>`
  );
}

export const RECORDING_NOTICE = 'This call may be recorded.';

// Played to the prospect on answering, before they're connected. The empty
// one-second Gather hands control back to the app (`afterNoticeUrl`) once the
// notice has finished, and that is where recording starts: nothing before or
// during the notice is recorded.
export function recordingNotice(afterNoticeUrl: string): string {
  return response(
    `<Say>${escapeXml(RECORDING_NOTICE)}</Say>` +
      `<Gather numDigits="1" timeout="1" actionOnEmptyResult="true" action="${escapeXml(afterNoticeUrl)}" method="POST"/>`
  );
}

// Ends the prospect's pre-connect TwiML, so Twilio connects the two legs.
export function connect(): string {
  return response('');
}

export function sayAndHangUp(message: string): string {
  return response(`<Say>${escapeXml(message)}</Say><Hangup/>`);
}

// --- Calls to the Twilio number ---

// How long the rep's phone rings before the caller is offered voicemail.
const REP_RING_SEC = 20;

// Answers a call to the Twilio number. With `notice`, the caller hears the
// recording notice first; recording itself starts only once the rep takes
// the call. The rep's phone shows the caller's number (Twilio's default when
// forwarding a call), and `whisperUrl` runs on the rep's leg when they pick
// up, while the caller still hears ringing. When the rep's leg ends, or never
// connects, Twilio asks `doneUrl` what to do with the caller.
export function forwardToRep(opts: {
  repNumber: string;
  whisperUrl: string;
  doneUrl: string;
  notice: boolean;
}): string {
  return response(
    (opts.notice ? `<Say>${escapeXml(RECORDING_NOTICE)}</Say>` : '') +
      `<Dial timeout="${REP_RING_SEC}" action="${escapeXml(opts.doneUrl)}" method="POST">` +
      `<Number url="${escapeXml(opts.whisperUrl)}" method="POST">${escapeXml(opts.repNumber)}</Number>` +
      `</Dial>`
  );
}

// Played to the rep on picking up. The caller is only connected once the rep
// presses 1, so the rep's own voicemail answering can't take the call: the
// leg hangs up and the caller gets the app's voicemail instead.
export function inboundWhisper(callerLabel: string, acceptUrl: string): string {
  return response(
    `<Gather numDigits="1" timeout="8" action="${escapeXml(acceptUrl)}" method="POST">` +
      `<Say>Call from ${escapeXml(callerLabel)}. Press 1 to answer.</Say>` +
      `</Gather><Hangup/>`
  );
}

export const VOICEMAIL_GREETING = 'Nobody can take your call right now. Please leave a message after the tone.';

// Records a message of up to three minutes. Twilio posts the finished
// recording to `recordingUrl`, and asks `doneUrl` what next once the caller
// stops (a <Record> with no action would start this document over).
export function voicemail(recordingUrl: string, doneUrl: string): string {
  return response(
    `<Say>${escapeXml(VOICEMAIL_GREETING)}</Say>` +
      `<Record maxLength="180" timeout="5" playBeep="true" action="${escapeXml(doneUrl)}" method="POST"` +
      ` recordingStatusCallback="${escapeXml(recordingUrl)}" recordingStatusCallbackMethod="POST"` +
      ` recordingStatusCallbackEvent="completed"/>`
  );
}

export function hangUp(): string {
  return response('<Hangup/>');
}

// A number read out digit by digit, for a caller who isn't in HubSpot:
// "+18015550164" → "8 0 1, 5 5 5, 0 1 6 4".
export function spokenNumber(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  const groups = us ? us.slice(1) : [e164.replace(/\D/g, '')];
  return groups.map((g) => g.split('').join(' ')).join(', ');
}

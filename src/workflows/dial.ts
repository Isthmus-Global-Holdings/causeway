// Click-to-call, in one of two ways (Settings → Calling):
//
// Through the rep's own phone ('phone'):
//   1. Twilio rings the rep's phone from the Twilio number.
//   2. The rep answers and hears who's next; pressing 1 dials the prospect
//      (routes/twilio.ts). A voicemail picking up the rep's leg presses
//      nothing, so it can never reach the prospect.
//   3. Twilio reports each leg's final status to /twilio/voice/*-status.
//
// From the browser ('browser'):
//   1. startDial records the dial and the page gets an access token for
//      Twilio's Voice SDK. Nothing rings: the page starts the call itself.
//   2. Twilio asks /twilio/voice/client what to do with it, which dials the
//      prospect. Clicking Call is the rep's go-ahead, as pressing 1 is on the
//      phone, and each dial connects at most once.
//   3. The prospect's leg reports as above; the browser's leg reports to the
//      TwiML App's status callback, /twilio/voice/client-status.
//
// A dial starts from a CALL task (the Calls page) or an interview (a meeting,
// the Interviews page), and the number comes from the HubSpot contact or
// company it belongs to. Or it calls back someone who rang the Twilio number
// (call-back.ts), at the number Twilio reported for that call.
//
// Nothing here writes to HubSpot. Logging the call is a separate step the rep
// takes afterwards (call-logged.ts, or meeting-logged.ts for an interview); a
// call back logs itself (call-back.ts).

import type { Dial, DialMode, DialStore, DialSubject } from '../lib/db';
import type { HubSpot } from '../lib/hubspot';
import { extensionOf, toE164 } from '../lib/phone';
import { TwilioApiError, type Twilio } from '../lib/twilio';
import { randomToken } from '../lib/tracking';
import { isOpen, loadMeeting, meetingOutcome } from './meeting-queue';
import { companyName, contactName, loadTask, withTaskLock, WorkflowError, type TaskParties } from './parties';

// A dial for the same task within this window that hasn't ended blocks a new
// one, so a double-click doesn't ring the rep's phone twice. A browser dial's
// call must start within it too.
export const DIAL_GUARD_SEC = 120;
// Longer than any real call. A dial with no final status by then lost its
// webhook, and is treated as ended so the page stops waiting on it.
export const DIAL_MAX_SEC = 2 * 60 * 60;
// Twilio reports each leg on its own. Once the rep's leg ends, the page waits
// this long for the prospect's (its status and length) before showing the
// log form, so a quick log doesn't save the call without them.
const PROSPECT_REPORT_GRACE_SEC = 20;
// How long the rep's phone rings before Twilio gives up.
const REP_RING_SEC = 25;

// The HubSpot numbers the rep can dial: the contact's phone and mobile, and
// the company's main line (often the only number for a small carrier).
export type PhoneField = 'phone' | 'mobilephone' | 'company';
export const PHONE_FIELDS: { field: PhoneField; label: string }[] = [
  { field: 'phone', label: 'Phone' },
  { field: 'mobilephone', label: 'Mobile' },
  { field: 'company', label: 'Company line' },
];

export function phoneFor(parties: Pick<TaskParties, 'contact' | 'company'>, field: PhoneField): string | null {
  const value = field === 'company' ? parties.company?.properties.phone : parties.contact.properties[field];
  return value?.trim() || null;
}

export interface DialDeps {
  hs: HubSpot;
  twilio: Twilio;
  dials: DialStore;
}

export interface DialOptions {
  now: number; // epoch ms
  baseUrl: string; // public origin Twilio's webhooks reach
  fromNumber: string; // the Twilio number, E.164
  mode: DialMode;
  repNumber: string | null; // the rep's phone, E.164; not used from the browser
  record: boolean; // record this call (Settings → Calling), with a notice to the prospect
  newId?: () => string;
}

export async function startDial(deps: DialDeps, taskId: string, field: PhoneField, opts: DialOptions): Promise<Dial> {
  // Under the task's lock from the status check to the dial's row: a Drop
  // waits for it and sees the dial live, or wrote DEFERRED first and is seen here.
  return withTaskLock(deps.dials, taskId, Math.floor(opts.now / 1000), async (beforeWrite) => {
    const { task, contact, company } = await loadTask(deps.hs, taskId, 'CALL');
    if (task.properties.hs_task_status === 'COMPLETED') {
      throw new WorkflowError('This call task is already completed.', 409);
    }
    if (task.properties.hs_task_status === 'DEFERRED') throw new WorkflowError(DROPPED, 409);
    beforeWrite();
    return beginDial(deps, { subject: 'task', id: taskId }, hubspotTarget({ contact, company }, field), opts);
  });
}

const DROPPED = 'This call task was dropped, so it wasn’t dialled.';

// The browser call of a dial from a page: the dial is claimed, so each
// connects at most once, within DIAL_GUARD_SEC of the click. A task's dial is
// claimed under the task's lock, with the cutoff taken inside it: a Drop that
// saw the dial as over came first and this sees it over too, or this came
// first and the Drop sees the call live. Null when it can't be claimed.
export async function claimBrowserDial(
  dials: DialStore,
  id: string,
  callSid: string,
  now: () => number
): Promise<Dial | null> {
  const claim = () => {
    const at = now();
    return dials.claimBrowserCall(id, callSid, new Date(at).toISOString(), Math.floor(at / 1000) - DIAL_GUARD_SEC);
  };
  const dial = await dials.get(id);
  if (!dial) return null;
  if (dial.subject !== 'task') return claim();
  try {
    return await withTaskLock(dials, dial.task_id, Math.floor(now() / 1000), claim);
  } catch (err) {
    if (err instanceof WorkflowError) return null; // a Drop, a log or another dial holds the task
    throw err;
  }
}

// Calls the contact of an interview, from its prep page.
export async function startMeetingDial(
  deps: DialDeps,
  meetingId: string,
  field: PhoneField,
  opts: DialOptions
): Promise<Dial> {
  const { meeting, contact, company } = await loadMeeting(deps.hs, meetingId);
  if (!isOpen(meetingOutcome(meeting.properties.hs_meeting_outcome))) {
    throw new WorkflowError('This interview already has an outcome.', 409);
  }
  return beginDial(deps, { subject: 'meeting', id: meetingId }, hubspotTarget({ contact, company }, field), opts);
}

// Who a dial calls: the number, and who's there, read to the rep before
// connecting and shown on the page.
export interface DialTarget {
  to: string; // E.164
  extension?: string | null; // keyed in once the line answers
  contactId: string; // '' when they aren't in HubSpot
  label: string;
}

// The contact's (or company's) number from HubSpot, never from the form, so
// the page can't be used to dial an arbitrary number.
export function hubspotTarget(
  { contact, company }: Pick<TaskParties, 'contact' | 'company'>,
  field: PhoneField
): DialTarget {
  const raw = phoneFor({ contact, company }, field);
  const to = toE164(raw);
  if (!to) {
    const label = PHONE_FIELDS.find((f) => f.field === field)?.label.toLowerCase() ?? 'phone';
    throw new WorkflowError(
      raw
        ? `"${raw}" isn't a number the app can dial. Fix it in HubSpot (include the country code if it's outside the US).`
        : `No ${label} number in HubSpot for ${field === 'company' ? (companyName(company) ?? 'this contact') : contactName(contact)}.`
    );
  }
  const company_ = companyName(company);
  return {
    to,
    extension: extensionOf(raw),
    contactId: contact.id,
    label: company_ ? `${contactName(contact)} at ${company_}` : contactName(contact),
  };
}

// What a dial is for, in the message when one is already live.
const SUBJECT_NOUN: Record<DialSubject, string> = { task: 'task', meeting: 'interview', inbound: 'caller' };

export async function beginDial(
  deps: Pick<DialDeps, 'twilio' | 'dials'>,
  from: { subject: DialSubject; id: string },
  target: DialTarget,
  opts: DialOptions
): Promise<Dial> {
  // Only a phone dial rings the rep's phone; a browser dial rings nothing.
  const repNumber = opts.mode === 'phone' ? opts.repNumber : null;
  if (opts.mode === 'phone' && !repNumber) throw new WorkflowError('Pick your phone in Settings first.');

  const id = (opts.newId ?? randomToken)();
  const base = opts.baseUrl.replace(/\/+$/, '');
  const extension = target.extension ?? null;
  const dial = {
    id,
    task_id: from.id,
    subject: from.subject,
    contact_id: target.contactId,
    contact_label: target.label,
    to_number: target.to,
    to_extension: extension,
    from_number: opts.fromNumber,
    rep_number: repNumber ?? 'browser',
    mode: opts.mode,
    started_sec: Math.floor(opts.now / 1000),
    // Not a call to an extension: the notice would play to the phone menu
    // that answers, before the extension rings, so whoever picks up there
    // would be recorded without hearing it.
    record: opts.record && !extension ? 1 : 0,
  };
  if (!(await deps.dials.begin(dial, DIAL_GUARD_SEC))) {
    throw new WorkflowError(
      `A call for this ${SUBJECT_NOUN[from.subject]} is already ringing or in progress. Refresh in a moment.`,
      409
    );
  }

  if (repNumber) await ringRep(deps, id, repNumber, opts.fromNumber, base);
  const saved = await deps.dials.get(id);
  if (!saved) throw new Error(`dial ${id} missing right after insert`);
  return saved;
}

async function ringRep(
  deps: Pick<DialDeps, 'twilio' | 'dials'>,
  id: string,
  repNumber: string,
  fromNumber: string,
  base: string
) {
  try {
    const call = await deps.twilio.createCall({
      to: repNumber,
      from: fromNumber,
      url: `${base}/twilio/voice/answer?d=${id}`,
      statusCallback: `${base}/twilio/voice/rep-status?d=${id}`,
      timeoutSec: REP_RING_SEC,
    });
    await deps.dials.setRepCallSid(id, call.sid);
  } catch (err) {
    // A 4xx is Twilio refusing the call: nothing rings, so the rep can try
    // again straight away. Anything else (a 5xx, a lost response) may have
    // started the call, so the dial stays guarded: a retry in that window
    // could ring the rep twice, and pressing 1 on both would dial the
    // prospect twice. The guard lifts after DIAL_GUARD_SEC (dialState).
    if (err instanceof TwilioApiError && err.status >= 400 && err.status < 500) {
      await deps.dials.setRepStatus(id, 'failed');
    }
    throw err;
  }
}

export type DialState =
  | { kind: 'ringing-rep' }
  | { kind: 'on-call' }
  | { kind: 'wrapping-up' } // the rep hung up; the prospect's leg report is on its way
  | { kind: 'ended'; summary: string; answered: boolean };

// Still ringing, on the call, or waiting for the prospect leg's report:
// logging now would save the call before its outcome and length are known.
export function isLive(state: DialState): boolean {
  return state.kind !== 'ended';
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

const PROSPECT_ENDINGS: Record<string, string> = {
  busy: 'Their line was busy.',
  'no-answer': 'They didn’t answer.',
  failed: 'The call to them failed. Check the number in HubSpot.',
  canceled: 'You hung up before they answered.',
};

const REP_ENDINGS: Record<string, string> = {
  'no-answer': 'Your phone didn’t pick up, so they were never dialled.',
  busy: 'Your phone was busy, so they were never dialled.',
  failed: 'Twilio couldn’t ring your phone, so they were never dialled.',
  canceled: 'The call was cancelled before your phone rang.',
  completed: 'You hung up before pressing 1, so they were never dialled.',
};

const BROWSER_ENDINGS: Record<string, string> = {
  canceled: 'The call didn’t start in the browser, so they were never dialled.',
  failed: 'The call didn’t start in the browser, so they were never dialled.',
  completed: 'The browser call ended before they were dialled.',
};

// Where a dial stands, from the columns the webhooks fill in. Pure, so the
// page and the tests agree on it.
export function dialState(dial: Dial, nowSec: number): DialState {
  const age = nowSec - dial.started_sec;
  // A dial Twilio never confirmed (no call sid: its answer was lost) counts
  // as live only for the guard window, unless the rep has since pressed 1,
  // which proves the call exists.
  const confirmed = dial.rep_call_sid !== null || dial.connected_at !== null;
  const live = dial.rep_status === null && age < (confirmed ? DIAL_MAX_SEC : DIAL_GUARD_SEC);
  if (live) return dial.connected_at ? { kind: 'on-call' } : { kind: 'ringing-rep' };
  if (
    dial.connected_at &&
    dial.prospect_status === null &&
    dial.rep_ended_sec !== null &&
    nowSec - dial.rep_ended_sec < PROSPECT_REPORT_GRACE_SEC
  ) {
    return { kind: 'wrapping-up' };
  }

  if (dial.prospect_status === 'completed') {
    const took =
      dial.prospect_duration_sec === null ? '' : ` Call length ${formatDuration(dial.prospect_duration_sec)}.`;
    return { kind: 'ended', summary: `They picked up (a person or voicemail).${took}`, answered: true };
  }
  if (dial.prospect_status) {
    return {
      kind: 'ended',
      summary: PROSPECT_ENDINGS[dial.prospect_status] ?? `Ended: ${dial.prospect_status}.`,
      answered: false,
    };
  }
  if (dial.connected_at) {
    // The rep's leg ended but the prospect's status hasn't arrived (yet).
    return { kind: 'ended', summary: 'The call ended.', answered: false };
  }
  if (dial.rep_status === null) {
    return { kind: 'ended', summary: 'Twilio never reported how this call ended.', answered: false };
  }
  const endings = dial.mode === 'browser' ? BROWSER_ENDINGS : REP_ENDINGS;
  return { kind: 'ended', summary: endings[dial.rep_status] ?? `Ended: ${dial.rep_status}.`, answered: false };
}

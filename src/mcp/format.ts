// What the Claude connector's tools return: the app's records cut down to
// what a conversation needs, with times in the rep's time zone and a link to
// each record's page (where the rep calls and sends). No I/O.

import type { CallCoaching, CallForReview, CallNotes } from '../actions/coaching';
import { formatAddress, zoneLabel } from '../lib/address';
import { clock } from '../lib/call-history';
import {
  adjustNotes,
  GATE_LABELS,
  objectionFor,
  STAGE_LABELS,
  type GatekeeperResult,
  type InsightFields,
  type Reviewer,
} from '../lib/call-insight';
import {
  BOOKING_STATUS_LABELS,
  heldRate,
  hourLabel,
  MIN_SAMPLE,
  pct,
  rateOf,
  type BookingReport,
  type BookingSplit,
  type CoachingReport,
  type Rate,
} from '../lib/coaching';
import { formatLocal, parseHubSpotTime } from '../lib/dates';
import { sqliteTime, type CallInsight, type InboundCall, type RecentCallLog, type RecentSend } from '../lib/db';
import { parseFitLabel } from '../lib/fit';
import { SPEAKER_LABELS } from '../lib/transcript';
import { CALL_REVIEW_RULES } from '../prompts/call-review';
import type { HubSpotObject } from '../lib/hubspot';
import { toE164 } from '../lib/phone';
import { historyTimeline, type CallContext } from '../workflows/call-context';
import type { CallRow } from '../workflows/call-queue';
import type { QueueRow } from '../workflows/email-queue';
import type { MeetingRow } from '../workflows/meeting-queue';
import { callerName, callerPlace, inboundOutcome, inboundSummary } from '../workflows/inbound';
import { companyName, contactName } from '../workflows/parties';

// How much of a contact's timeline a tool returns, newest first.
export const HISTORY_SHOWN = 25;

export function localTime(ms: number | null, timeZone: string): string | null {
  return ms === null ? null : formatLocal(ms, timeZone);
}

function hubSpotTime(value: string | null | undefined, timeZone: string): string | null {
  return localTime(parseHubSpotTime(value), timeZone);
}

// A time the app stored in D1: SQLite's CURRENT_TIMESTAMP ("2026-09-25
// 15:00:00", UTC) or an ISO string.
export function storedTime(value: string | null, timeZone: string): string | null {
  const ms = value && /^\d{4}-\d{2}-\d{2} \d/.test(value) ? sqliteTime(value) : parseHubSpotTime(value);
  return localTime(ms, timeZone);
}

export function pageUrl(origin: string, path: string): string {
  return `${origin}${path}`;
}

export function contactSummary(contact: HubSpotObject, origin: string) {
  const p = contact.properties;
  return {
    id: contact.id,
    name: contactName(contact),
    title: p.jobtitle ?? null,
    email: p.email ?? null,
    phone: toE164(p.phone) ?? p.phone ?? null,
    mobile: toE164(p.mobilephone) ?? p.mobilephone ?? null,
    leadStatus: p.hs_lead_status ?? null,
    lifecycleStage: p.lifecyclestage ?? null,
    address: formatAddress(p)?.join(', ') ?? null,
    url: pageUrl(origin, `/contacts/${contact.id}`),
  };
}

export function companySummary(company: HubSpotObject, origin: string) {
  const p = company.properties;
  return {
    id: company.id,
    name: companyName(company),
    domain: p.domain ?? null,
    phone: toE164(p.phone) ?? p.phone ?? null,
    industry: p.industry ?? null,
    employees: p.numberofemployees ?? null,
    fit: parseFitLabel(p.description),
    description: p.description ?? null,
    address: formatAddress(p)?.join(', ') ?? null,
    url: pageUrl(origin, `/companies/${company.id}`),
  };
}

// A task's page: the call page for a CALL, the draft page for an EMAIL.
export function taskUrl(origin: string, taskId: string, type: string | null | undefined): string {
  return pageUrl(origin, type === 'CALL' ? `/calls/${taskId}` : `/tasks/${taskId}/draft`);
}

export function taskSummary(task: HubSpotObject, timeZone: string, origin: string) {
  const p = task.properties;
  return {
    id: task.id,
    type: p.hs_task_type ?? null,
    subject: p.hs_task_subject ?? null,
    status: p.hs_task_status ?? null,
    due: hubSpotTime(p.hs_timestamp, timeZone),
    completed: hubSpotTime(p.hs_task_completion_date, timeZone),
    url: taskUrl(origin, task.id, p.hs_task_type),
  };
}

export function history(context: CallContext, timeZone: string) {
  const unread = (['notes', 'calls', 'emails'] as const).filter((kind) => context[kind].failed);
  return {
    items: historyTimeline(context)
      .slice(0, HISTORY_SHOWN)
      .map((item) => ({
        kind: item.kind,
        at: localTime(item.at, timeZone),
        title: item.title,
        detail: item.detail,
        text: item.text,
      })),
    // Parts HubSpot couldn't be read: the timeline may be missing some.
    unread,
  };
}

export function callRowSummary(row: CallRow, timeZone: string, origin: string) {
  return {
    taskId: row.taskId,
    subject: row.subject,
    due: localTime(row.dueAt, timeZone),
    setTime: row.setTime, // the contact asked to be called at `due`
    contactId: row.contactId,
    contact: row.contactName,
    company: row.companyName,
    phone: row.phone,
    fit: row.fit,
    emailOpens: row.engagement?.opens ?? 0,
    emailClicks: row.engagement?.clicks ?? 0,
    interview: row.interview
      ? { meetingId: row.interview.meetingId, start: localTime(row.interview.startAt, timeZone) }
      : null,
    url: pageUrl(origin, `/calls/${row.taskId}`),
  };
}

export function emailRowSummary(row: QueueRow, origin: string) {
  return {
    taskId: row.taskId,
    subject: row.subject,
    contact: row.contactName,
    company: row.companyName,
    fit: row.fit,
    followUp: row.warm,
    drafted: row.hasDraft,
    url: pageUrl(origin, `/tasks/${row.taskId}/${row.hasDraft ? 'send' : 'draft'}`),
  };
}

export function meetingRowSummary(row: MeetingRow, timeZone: string, origin: string) {
  return {
    meetingId: row.meetingId,
    title: row.title,
    start: localTime(row.startAt, timeZone),
    end: localTime(row.endAt, timeZone),
    outcome: row.outcome,
    format: row.phoneCall ? 'phone' : 'video',
    joinUrl: row.joinUrl,
    phone: row.phone,
    contactId: row.contactId,
    contact: row.contactName,
    company: row.companyName,
    url: pageUrl(origin, `/meetings/${row.meetingId}`),
  };
}

// The last email the app sent the contact, and whether they opened it.
export function lastEmailSummary(sent: RecentSend | null, timeZone: string) {
  if (!sent) return null;
  return {
    taskId: sent.email_task_id,
    to: sent.to_email,
    subject: sent.subject,
    status: sent.status,
    sent: storedTime(sent.sent_at, timeZone),
    opens: sent.track_opens === 0 ? null : sent.opens,
    clicks: sent.track_clicks === 0 ? null : sent.clicks,
  };
}

export function recentCallSummary(log: RecentCallLog, timeZone: string, origin: string) {
  return {
    taskId: log.call_task_id,
    contactId: log.contact_id,
    title: log.title,
    outcome: log.outcome,
    notes: log.notes,
    lengthSec: log.duration_sec,
    logged: storedTime(log.created_at, timeZone),
    summary: log.summary,
    url: pageUrl(origin, `/calls/${log.call_task_id}`),
  };
}

export function inboundCallSummary(call: InboundCall, timeZone: string, origin: string) {
  return {
    id: call.id,
    at: localTime(call.started_sec * 1000, timeZone),
    from: call.from_number,
    caller: callerName(call),
    place: callerPlace(call),
    contactId: call.contact_id,
    outcome: inboundOutcome(call),
    what: inboundSummary(call),
    summary: call.summary,
    url: pageUrl(origin, `/inbound/${call.id}`),
  };
}

// One read call, for coaching: what happened, and what to adjust.
export function callInsightSummary(call: CallInsight, timeZone: string, origin: string) {
  return {
    taskId: call.call_task_id,
    with: call.label,
    at: localTime(call.at_sec * 1000, timeZone),
    length: call.duration_sec !== null ? clock(call.duration_sec) : null,
    answeredBy: call.gate,
    frontDesk: call.gate === 'gatekeeper' ? { name: call.gatekeeper_name, result: call.gatekeeper_result } : null,
    phoneTree: call.phone_tree_sec !== null ? { sec: call.phone_tree_sec, digit: call.phone_tree_digit } : null,
    reached: call.reached === 1,
    talk: call.talk_sec !== null ? clock(call.talk_sec) : null,
    gotAsFarAs: STAGE_LABELS[call.stage],
    objection: call.objection_kind
      ? { kind: call.objection_kind, said: call.objection, gotPast: call.got_past_objection === 1 }
      : null,
    nextStep: call.next_step ? (call.next_step_text ?? true) : null,
    opening: call.opening,
    adjust: adjustNotes(call).map((n) => n.text),
    url: pageUrl(origin, `/calls/${call.call_task_id}`),
  };
}

// What the front desk did, in a few plain words.
const RESULT_WORDS: Record<GatekeeperResult, string> = {
  put_through: 'put through',
  sent_to_voicemail: 'sent to voicemail',
  not_available: 'not available',
  on_hold_no_pickup: 'on hold, never came on',
  took_message: 'took a message',
  refused: 'turned away',
};

// How a call ended up, in a few words.
function callResult(call: InsightFields): string {
  if (call.gate === 'gatekeeper' && !call.reached) {
    return call.gatekeeper_result ? RESULT_WORDS[call.gatekeeper_result] : 'stopped at the front desk';
  }
  if (call.reached) return call.next_step ? 'next step agreed' : 'reached them';
  return GATE_LABELS[call.gate].toLowerCase();
}

const whoAnswered = (call: InsightFields) => (call.gate === 'owner' ? 'them' : GATE_LABELS[call.gate].toLowerCase());

// The last call with them, before the next.
export function lastCallSummary(call: CallInsight, timeZone: string, origin: string) {
  return {
    when: localTime(call.at_sec * 1000, timeZone),
    whoAnswered: whoAnswered(call),
    frontDesk: call.gate === 'gatekeeper' ? call.gatekeeper_name : null,
    result: callResult(call),
    stage: STAGE_LABELS[call.stage].toLowerCase(),
    objection: call.objection_kind ? (call.objection ?? objectionFor(call.objection_kind)?.label ?? null) : null,
    nextStep: call.next_step ? (call.next_step_text ?? 'yes') : null,
    url: pageUrl(origin, `/calls/${call.call_task_id}`),
  };
}

// get_call_task's coaching before the call: the tips the page shows, and
// the facts behind them.
export function beforeCallSummary(coaching: CallCoaching, timeZone: string, origin: string) {
  const { brief } = coaching;
  const timing = brief?.timing;
  return {
    tips: coaching.before.map((n) => n.text),
    lastCall: brief?.lastCall ? lastCallSummary(brief.lastCall, timeZone, origin) : null,
    atTheirCompany: brief?.atTheirCompany ?? null,
    timing: timing
      ? {
          theirTimeNow: `${hourLabel(timing.hour)}${timing.zone ? ` (${zoneLabel(timing.zone)})` : ''}`,
          thisHour: timing.thisHour ? `${timing.thisHour.reached} of ${timing.thisHour.calls} reached` : null,
          bestHour: timing.best
            ? `${hourLabel(timing.best.hour)}, ${timing.best.reached} of ${timing.best.calls}`
            : null,
        }
      : null,
  };
}

// get_call_task's coaching once the call is logged: what happened (the
// tags, who decided each, and which nothing was sure of), and what to adjust.
// `nextDue` is the follow-up the rep set, ISO.
export function afterCallSummary(after: CallNotes, nextDue: string | null, timeZone: string) {
  const call = after.read;
  return {
    tags: {
      whoAnswered: whoAnswered(call),
      frontDesk: call.gate === 'gatekeeper' ? call.gatekeeper_name : null,
      frontDeskResult:
        call.gate === 'gatekeeper' && call.gatekeeper_result ? RESULT_WORDS[call.gatekeeper_result] : null,
      phoneTreeSec: call.phone_tree_sec,
      phoneTreeDigit: call.phone_tree_digit,
      reachedThem: call.reached === 1,
      stage: STAGE_LABELS[call.stage].toLowerCase(),
      talkSec: call.talk_sec,
      lengthSec: call.duration_sec,
      objection: call.objection_kind
        ? { kind: call.objection_kind, inTheirWords: call.objection, gotPast: call.got_past_objection === 1 }
        : null,
      nextStep: {
        agreed: call.next_step === 1,
        when: call.next_step ? storedTime(nextDue, timeZone) : null,
        what: call.next_step_text,
      },
      // Jev's, from the transcript: not read yet.
      talkedAboutTheirWorld: null,
      openedUp: null,
    },
    sources: after.sources,
    unsure: after.unsure,
    review:
      call.what_worked || call.adjust
        ? { whatWorked: call.what_worked, adjust: call.adjust, by: reviewedBy(after) }
        : null,
    notes: after.notes.map((n) => n.text),
  };
}

// Who reviewed the call, from who decided its tags: the rep over Claude.
function reviewedBy(after: CallNotes): Reviewer | null {
  const by = Object.values(after.sources).map((s) => s?.by);
  return by.includes('rep') ? 'rep' : by.includes('claude') ? 'claude' : null;
}

// One logged call for a review (get_call_review): the call, its transcript
// with times, the rules' tags (reviews laid over them), the reviews so far,
// and how to review it.
export function callReviewSummary(r: CallForReview, origin: string) {
  const tz = r.settings.timeZone;
  return {
    timeZone: tz,
    call: {
      taskId: r.log.call_task_id,
      with: r.notes.label,
      channel: r.log.channel,
      outcome: r.log.outcome,
      lengthSec: r.log.duration_sec ?? r.notes.read.duration_sec,
      repNotes: r.log.notes || null,
      url: pageUrl(origin, `/calls/${r.log.call_task_id}`),
    },
    transcript: r.turns.length
      ? r.turns.map((t) => `[${clock(Math.round(t.start))}] ${SPEAKER_LABELS[t.speaker]}: ${t.text}`)
      : null,
    autoSummary: r.summary.length ? r.summary : null,
    reading: afterCallSummary(r.notes, r.log.next_due, tz),
    reviews: r.reviews.map((v) => ({
      by: v.reviewer,
      corrections: v.corrections,
      whatWorked: v.what_worked,
      adjust: v.adjust,
      at: localTime(Date.parse(v.reviewed_at), tz),
    })),
    rules: CALL_REVIEW_RULES,
  };
}

// The interviews booked on calls and how each turned out, with each group's
// size. One they canceled is a reply (they told the rep); a no-show isn't.
// The rep's own cancels are left out of the groups.
export function bookingSummary(bookings: BookingReport, timeZone: string, origin: string) {
  const split = (s: BookingSplit) => ({
    group: s.label,
    ended: s.decided,
    held: s.held,
    noShow: s.noShow,
    theyCanceled: s.canceled,
    heldRate: pct(heldRate(s)),
  });
  return {
    booked: bookings.booked,
    held: bookings.held,
    noShow: bookings.noShow,
    theyCanceled: bookings.canceled,
    youCanceled: bookings.youCanceled,
    ahead: bookings.upcoming,
    toLog: bookings.toLog,
    // Every one, not only those among the recent: each is to log on its url.
    toLogInterviews: bookings.toLogRows.map((b) => ({
      meetingId: b.meeting_id,
      with: b.label,
      at: storedTime(b.start, timeZone),
      url: `${origin}/meetings/${b.meeting_id}`,
    })),
    movedAtLeastOnce: bookings.moved,
    byHowFarAheadBooked: bookings.byLeadTime.map(split),
    byCalendarInvite: bookings.byInvite.map(split),
    byTalkOnTheBookingCall: bookings.byCallLength.map(split),
    recent: bookings.recent.map(({ booking, status }) => ({
      meetingId: booking.meeting_id,
      with: booking.label,
      bookedAt: localTime(booking.booked_sec * 1000, timeZone),
      at: storedTime(booking.start, timeZone),
      status: BOOKING_STATUS_LABELS[status],
      moved: booking.moves,
      url: `${origin}/meetings/${booking.meeting_id}`,
    })),
  };
}

// The coaching report, with rates as percentages and every group's size, so
// a pattern from a handful of calls reads as one.
export function coachingSummary(report: CoachingReport, timeZone: string, origin: string) {
  const rate = (r: Rate) => ({ calls: r.calls, reached: r.reached, rate: pct(rateOf(r)) });
  return {
    timeZone,
    minCallsForAPattern: MIN_SAMPLE,
    calls: report.calls,
    reached: report.reached,
    answered: report.answered,
    reachedByHourTheirTime: report.byHour.map((h) => ({ hour: hourLabel(h.hour), ...rate(h) })),
    reachedByTimeZone: report.byZone.map((z) => ({ zone: z.label, ...rate(z) })),
    averageLengthByOutcome: report.lengthByOutcome.map((l) => ({
      outcome: l.outcome,
      calls: l.calls,
      average: clock(l.avgSec),
    })),
    howFarCallsGet: report.stages.map((s) => ({ stage: s.label, calls: s.count })),
    frontDesk: {
      calls: report.gatekeeper.calls,
      putThrough: report.gatekeeper.putThrough,
      results: report.gatekeeper.results.map((r) => ({ result: r.result, calls: r.count })),
      byName: report.gatekeeper.names,
      linesThatGotThrough: report.gatekeeper.linesThatWorked.map((q) => ({ said: q.text, call: q.label })),
    },
    objections: report.objections.map((o) => ({
      kind: o.kind,
      label: o.label,
      times: o.count,
      gotPast: o.gotPast,
      inTheirWords: o.examples.map((q) => q.text),
      openingsThatGotPast: o.openings.map((q) => ({ said: q.text, call: q.label })),
    })),
    followUpTiming: report.followUps.map((f) => ({
      gap: f.label,
      afterReachingThem: rate(f.afterConnect),
      beforeReachingThem: rate(f.beforeConnect),
    })),
    rushedConnectsWithNoNextStep: {
      count: report.fastNoNextStep.calls.length,
      ofConnects: report.fastNoNextStep.connects,
      calls: report.fastNoNextStep.calls.slice(0, 10).map((c) => callInsightSummary(c, timeZone, origin)),
    },
    longConnects: report.longConnects.slice(0, 5).map((c) => ({
      ...callInsightSummary(c, timeZone, origin),
      whatWorked: c.what_worked,
    })),
    talkStyle: report.style,
    recent: report.recent.map((c) => callInsightSummary(c, timeZone, origin)),
  };
}

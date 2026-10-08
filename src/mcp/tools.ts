// The Claude connector's tools: what the rep can do from a Claude chat. Each
// reads through the same workflows as the pages, and each write goes through
// src/actions, so it keeps the app's rules: checked the same way, safe to
// repeat, audited under the rep who approved the connector, and HubSpot's
// follow-up steps run after the answer. Sending an email and dialling stay
// on the pages: a tool answers with the page's link instead.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { bookInterview, callsOverview, dropCallTask, logCall, snoozeCallTask } from '../actions/calls';
import {
  callCoaching,
  callForReview,
  callsForReview,
  coachingOverview,
  heardOverview,
  saveCallReview,
} from '../actions/coaching';
import { dropEmailTask, markEmailSent, saveEmailDraft } from '../actions/emails';
import { latestMeetingDial, logMeeting, meetingsOverview } from '../actions/meetings';
import { openContactTask, saveCompanyCallLines, saveNumbers } from '../actions/records';
import { loadAppSettings } from '../lib/app-settings';
import {
  COMMITMENTS,
  GATEKEEPER_RESULTS,
  GATES,
  OBJECTION_KINDS,
  parseUnsure,
  REVIEWERS,
  STAGES,
  type ObjectionKind,
} from '../lib/call-insight';
import { fillScript, scriptVars } from '../lib/call-script';
import { partyTimeZone } from '../lib/address';
import { localDate, parseHubSpotTime } from '../lib/dates';
import {
  CALL_CHANNELS,
  d1CallLogStore,
  d1DialStore,
  d1InboundCallStore,
  d1MeetingLogStore,
  d1SentEmailStore,
  latestSendToContact,
  recentlyWorked,
  unfinishedWrites,
} from '../lib/db';
import { describeError } from '../lib/errors';
import { createHubSpot } from '../lib/hubspot';
import { parseTaskBody } from '../lib/richtext';
import { CALL_LINES_RULES } from '../prompts/call-lines';
import { DRAFT_SYSTEM_PROMPT } from '../prompts/draft-system';
import { INTERVIEW_REMINDERS, INTERVIEW_SECTIONS } from '../prompts/interview-questions';
import type { AppEnv } from '../types';
import { LENGTHS_MIN } from '../workflows/book-interview';
import { HISTORY_LINKS, loadCallContext } from '../workflows/call-context';
import { CALL_OUTCOMES, callLogDone, LAST_TRY, MESSAGE_OUTCOMES, WHATSAPP_FIELDS } from '../workflows/call-logged';
import { canCall } from '../workflows/call-queue';
import { dialState, isLive } from '../workflows/dial';
import { loadDraftContext } from '../workflows/draft-email';
import { isTemplatedFollowUp, loadEmailQueue } from '../workflows/email-queue';
import { LOGGABLE_OUTCOMES, meetingLogDone, meetingLogId } from '../workflows/meeting-logged';
import { bucketMeetings, contactMeetings, loadMeeting, meetingRow } from '../workflows/meeting-queue';
import { loadTask, WorkflowError } from '../workflows/parties';
import { loadCompanyRecord, loadContactRecord, searchCompanyList, searchContactList } from '../workflows/records';
import { loadTodayCounts } from '../workflows/today';
import {
  callRowSummary,
  afterCallSummary,
  callInsightSummary,
  callReviewSummary,
  heardSummary,
  beforeCallSummary,
  bookingSummary,
  coachingSummary,
  companySummary,
  contactSummary,
  emailRowSummary,
  history,
  inboundCallSummary,
  lastEmailSummary,
  localTime,
  meetingRowSummary,
  pageUrl,
  recentCallSummary,
  taskSummary,
} from './format';

// What Claude reads about the app before using its tools.
export const INSTRUCTIONS = `This connector is the rep's outreach app: HubSpot EMAIL and CALL tasks, interviews (HubSpot meetings) and the contacts and companies behind them. Every tool acts as the rep who connected it, through the same checks as the app's pages.

- Start with "today" for what's next, or "call_queue" / "email_queue" / "meetings" for a list. Lists are already ranked by the app: keep its order.
- Ids come from earlier results (taskId, contactId, meetingId). Never make one up.
- Emails are sent and calls are dialled from the app's pages, not from here: give the rep the result's "url" to open.
- To write an email: "get_email_task", then "drafting_rules", then "save_draft", then "save_call_lines" for the call that follows it. The rep sends it from the page.
- Dates are YYYY-MM-DD and times HH:MM, in the rep's time zone (every result says which). When the contact gave a time in their own zone ("call me at 2pm my time"), pass it as they said it with time_zone: their zone (theirTimeZone in results, from their address) or whichever they named. The app saves it in the rep's zone.
- Writes are safe to repeat: running one again finishes what an earlier attempt started and never doubles it.`;

// A HubSpot record id (or, once HubSpot is gone, the app's own).
const id = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/)
  .describe('an id from an earlier result');
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("YYYY-MM-DD, in the rep's time zone");
const time = z
  .string()
  .regex(/^\d{2}:\d{2}$/)
  .describe("HH:MM (24-hour), in the rep's time zone");
// The zone a time (and its date) was said in, when the contact said it in theirs.
const timeZone = z
  .string()
  .regex(/^[A-Za-z_]+\/[A-Za-z_/+-]+$/)
  .optional()
  .describe(
    "only when the contact said the time in their own zone: that IANA zone (e.g. America/New_York, theirTimeZone in results). The date and time are then theirs; the app saves them in the rep's zone"
  );

const READ = { readOnlyHint: true, openWorldHint: false } as const;
// Writes change HubSpot but never remove anything, and repeating one is a no-op.
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Runs a tool, answering a failure the way the pages would word it.
async function run(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (err) {
    const { title, message, log } = describeError(err);
    if (log) console.error(err);
    return { isError: true, content: [{ type: 'text', text: `${title}: ${message}` }] };
  }
}

export function registerTools(server: McpServer, c: Context<AppEnv>): void {
  const env = c.env;
  const origin = new URL(c.req.url).origin;
  const hubspot = () => createHubSpot(env.HUBSPOT_ACCESS_TOKEN);

  // ---- Reads ----

  server.registerTool(
    'today',
    {
      title: 'Today',
      description:
        "Today at a glance: emails sent and people called today, today's interviews, the real conversations so far (people who told the rep about their work, toward 100, and the newest), the next email and the next call (as the app ranks them), and any HubSpot writes that didn't finish.",
      annotations: READ,
    },
    () =>
      run(async () => {
        const settings = await loadAppSettings(env);
        const { timeZone } = settings;
        const [calls, emails, unfinished] = await Promise.all([
          callsOverview(c),
          recentlyWorked(env.DB, 'email').then((closed) =>
            loadEmailQueue(hubspot(), [...closed], Date.now(), timeZone)
          ),
          unfinishedWrites(env.DB, Math.floor(Date.now() / 1000)),
        ]);
        const counts = await loadTodayCounts(env.DB, calls.hs, calls.now, timeZone, calls.meetings);
        const next = emails.nextUp;
        return {
          date: localDate(calls.now, timeZone),
          timeZone,
          counts,
          nextEmail: next ? { ...emailRowSummary(next.item, origin), step: next.step } : null,
          emailsToSend: emails.rows.filter((r) => r.hasDraft && r.fit !== 'DROP').length,
          emailsToDraft: emails.rows.filter((r) => !r.hasDraft && r.fit !== 'DROP').length,
          nextCall: calls.plan.nextUp ? callRowSummary(calls.plan.nextUp, timeZone, origin) : null,
          callsDueToday: calls.plan.due.filter(canCall).length,
          callsAtSetTime: calls.plan.atTime.map((r) => callRowSummary(r, timeZone, origin)),
          interviewsToday: calls.meetings
            ? bucketMeetings(calls.meetings, calls.now, timeZone).today.map((r) =>
                meetingRowSummary(r, timeZone, origin)
              )
            : null,
          unfinished,
        };
      })
  );

  server.registerTool(
    'email_queue',
    {
      title: 'Email queue',
      description:
        'Open EMAIL tasks, ranked: follow-ups first, then by company fit. "drafted" ones are ready to send from their page; the rest need a draft. Fit DROP means the company is a poor fit.',
      annotations: READ,
    },
    () =>
      run(async () => {
        const { timeZone } = await loadAppSettings(env);
        const closed = await recentlyWorked(env.DB, 'email');
        const queue = await loadEmailQueue(hubspot(), [...closed], Date.now(), timeZone);
        return {
          timeZone,
          nextUp: queue.nextUp ? { taskId: queue.nextUp.item.taskId, step: queue.nextUp.step } : null,
          tasks: queue.rows.map((r) => emailRowSummary(r, origin)),
          truncated: queue.truncated,
        };
      })
  );

  server.registerTool(
    'call_queue',
    {
      title: 'Call queue',
      description:
        "Open CALL tasks: today's at a set time (the contact asked to be called then; each is the next call from 5 minutes before its time), the rest of today's in the order to call them (clicked the email, then fit, then most overdue), the ones due later, and the calls logged lately.",
      annotations: READ,
    },
    () =>
      run(async () => {
        const { settings, queue, plan, recent } = await callsOverview(c);
        const { timeZone } = settings;
        return {
          timeZone,
          nextUp: plan.nextUp?.taskId ?? null,
          atSetTime: plan.atTime.map((r) => callRowSummary(r, timeZone, origin)),
          today: plan.due.map((r) => callRowSummary(r, timeZone, origin)),
          later: plan.later.map((r) => callRowSummary(r, timeZone, origin)),
          recentlyLogged: recent.map((l) => recentCallSummary(l, timeZone, origin)),
          truncated: queue.truncated,
        };
      })
  );

  server.registerTool(
    'meetings',
    {
      title: 'Interviews',
      description:
        'Interviews from a week back to two weeks ahead: past ones still needing an outcome, today, upcoming, and recent.',
      annotations: READ,
    },
    () =>
      run(async () => {
        const { now, settings, rows, error } = await meetingsOverview(c);
        const { timeZone } = settings;
        if (error) return { error };
        const buckets = bucketMeetings(rows, now, timeZone);
        const list = (items: typeof rows) => items.map((r) => meetingRowSummary(r, timeZone, origin));
        return {
          timeZone,
          needsOutcome: list(buckets.needsOutcome),
          today: list(buckets.today),
          upcoming: list(buckets.upcoming),
          recent: list(buckets.recent),
        };
      })
  );

  server.registerTool(
    'search_contacts',
    {
      title: 'Search contacts',
      description:
        "Search HubSpot's contacts by name, email or company (up to 50). No query: the most recently updated.",
      inputSchema: { query: z.string().max(100).optional().describe('what to search for') },
      annotations: READ,
    },
    ({ query }) =>
      run(async () => {
        const rows = await searchContactList(hubspot(), query?.trim() || null);
        return rows.map(({ contact, company }) => ({
          ...contactSummary(contact, origin),
          company: company ? { id: company.id, name: company.properties.name ?? null } : null,
        }));
      })
  );

  server.registerTool(
    'search_companies',
    {
      title: 'Search companies',
      description: "Search HubSpot's companies by name or domain (up to 50). No query: the most recently updated.",
      inputSchema: { query: z.string().max(100).optional().describe('what to search for') },
      annotations: READ,
    },
    ({ query }) =>
      run(async () => {
        const companies = await searchCompanyList(hubspot(), query?.trim() || null);
        return companies.map((company) => companySummary(company, origin));
      })
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Contact',
      description:
        'One contact: details, company, open and recent tasks, interviews, the last email the app sent them, and their HubSpot history (notes, calls, emails), newest first.',
      inputSchema: { contact_id: id },
      annotations: READ,
    },
    ({ contact_id }) =>
      run(async () => {
        const [record, settings, lastEmail] = await Promise.all([
          loadContactRecord(hubspot(), contact_id),
          loadAppSettings(env),
          latestSendToContact(env.DB, contact_id),
        ]);
        const { timeZone } = settings;
        return {
          timeZone,
          contact: contactSummary(record.contact, origin),
          company: record.company ? companySummary(record.company, origin) : null,
          openTasks: record.tasks.open.map((t) => taskSummary(t, timeZone, origin)),
          completedTasks: record.tasks.completed.map((t) => taskSummary(t, timeZone, origin)),
          interviews: record.meetings?.map((r) => meetingRowSummary(r, timeZone, origin)) ?? null,
          lastEmail: lastEmailSummary(lastEmail, timeZone),
          history: history(record.context, timeZone),
        };
      })
  );

  server.registerTool(
    'get_company',
    {
      title: 'Company',
      description: 'One company: details, fit, its contacts, and its open and recent tasks.',
      inputSchema: { company_id: id },
      annotations: READ,
    },
    ({ company_id }) =>
      run(async () => {
        const [record, { timeZone }] = await Promise.all([
          loadCompanyRecord(hubspot(), company_id),
          loadAppSettings(env),
        ]);
        return {
          timeZone,
          company: companySummary(record.company, origin),
          contacts: record.contacts.map((contact) => contactSummary(contact, origin)),
          openTasks: record.tasks.open.map((t) => taskSummary(t, timeZone, origin)),
          completedTasks: record.tasks.completed.map((t) => taskSummary(t, timeZone, origin)),
        };
      })
  );

  server.registerTool(
    'get_email_task',
    {
      title: 'Email task',
      description:
        'One EMAIL task: who it is for, their company, notes on them, the draft on it (if any), whether it was sent, and the research context for writing it. Follow-ups drafted from the rep\'s templates ("templated") should be edited, not rewritten.',
      inputSchema: { task_id: id },
      annotations: READ,
    },
    ({ task_id }) =>
      run(async () => {
        const [ctx, sent, { timeZone }] = await Promise.all([
          loadDraftContext(hubspot(), task_id),
          d1SentEmailStore(env.DB).get(task_id),
          loadAppSettings(env),
        ]);
        const body = ctx.task.properties.hs_task_body;
        const draft = body ? parseTaskBody(body) : null;
        return {
          timeZone,
          task: taskSummary(ctx.task, timeZone, origin),
          contact: contactSummary(ctx.contact, origin),
          company: ctx.company ? companySummary(ctx.company, origin) : null,
          notes: ctx.notes.map((n) => n.text),
          draft: draft ?? (ctx.existingDraft ? { subject: null, body: ctx.existingDraft } : null),
          templated: isTemplatedFollowUp(ctx.task.properties.hs_task_subject),
          send: sent ? { status: sent.status, sent: sent.sent_at, to: sent.to_email } : null,
          researchContext: ctx.apiContext,
          sendUrl: pageUrl(origin, `/tasks/${task_id}/send`),
        };
      })
  );

  server.registerTool(
    'drafting_rules',
    {
      title: 'Drafting rules',
      description:
        "The rep's rules and voice for cold outreach emails (Mom Test style). Read them before drafting, then save the email with save_draft.",
      annotations: READ,
    },
    () =>
      run(async () => ({
        rules: `${DRAFT_SYSTEM_PROMPT.split('\n## Output')[0].trim()}\n\n## Output\n\nSave the email with save_draft: the subject line, and the body as plain text with blank lines between paragraphs. The signature is added when it's sent.\n\n${CALL_LINES_RULES}`,
      }))
  );

  server.registerTool(
    'get_call_task',
    {
      title: 'Call task',
      description:
        "One CALL task, for preparing a call: the contact's numbers, the rep's call script filled in for them, their company, the last email the app sent them, upcoming interviews, their HubSpot history, coaching, and whether this call was already logged or is live now. coaching.beforeTheCall: tips, the last call with them (who answered, the front desk by name, how it ended), the calls to their company (front desk, phone menu digit and length) and their time now against how that hour has gone. coaching.afterTheCall, once this call is logged: its tags (who answered, front desk result, phone menu, reached them, how far it got, talk time, objection, next step), who decided each (sources), which nothing was sure of (unsure), and what to adjust.",
      inputSchema: { task_id: id },
      annotations: READ,
    },
    ({ task_id }) =>
      run(async () => {
        const hs = hubspot();
        const now = Date.now();
        const [parties, dial, log, settings] = await Promise.all([
          loadTask(hs, task_id, 'CALL', [...HISTORY_LINKS, 'meetings']),
          d1DialStore(env.DB).latestForTask(task_id),
          d1CallLogStore(env.DB).get(task_id),
          loadAppSettings(env),
        ]);
        const { timeZone } = settings;
        const [context, meetings, lastEmail, coaching] = await Promise.all([
          loadCallContext(hs, parties),
          contactMeetings(hs, parties.contact.id, now, timeZone, parties.related?.meetings).catch((err: unknown) => {
            console.error('interviews for call task tool', err);
            return null;
          }),
          latestSendToContact(env.DB, parties.contact.id),
          callCoaching(c, parties, log ? task_id : null, settings, now),
        ]);
        return {
          timeZone,
          theirTimeZone: partyTimeZone(parties.contact, parties.company),
          task: taskSummary(parties.task, timeZone, origin),
          contact: contactSummary(parties.contact, origin),
          company: parties.company ? companySummary(parties.company, origin) : null,
          script: settings.callScript
            ? fillScript(settings.callScript, scriptVars(parties.contact, parties.company, settings.fromName))
            : null,
          lastEmail: lastEmailSummary(lastEmail, timeZone),
          interviews: meetings?.interviews.map((r) => meetingRowSummary(r, timeZone, origin)) ?? null,
          missedInterview: meetings?.missed ? meetingRowSummary(meetings.missed, timeZone, origin) : null,
          coaching: {
            beforeTheCall: beforeCallSummary(coaching, timeZone, origin),
            afterTheCall: coaching.after ? afterCallSummary(coaching.after, log?.next_due ?? null, timeZone) : null,
          },
          callLive: dial ? isLive(dialState(dial, Math.floor(now / 1000))) : false,
          logged: log
            ? {
                outcome: log.outcome,
                notes: log.notes,
                finished: callLogDone(log),
                nextTask: log.next_type ? { type: log.next_type, due: log.next_due, id: log.next_task_id } : null,
              }
            : null,
          history: history(context, timeZone),
        };
      })
  );

  server.registerTool(
    'call_coaching',
    {
      title: 'Call coaching',
      description:
        "Patterns across every call the rep logged (test calls left out), each read from its transcript or notes: the phone menu, who answered (them, the front desk, voicemail), how far calls get, momTest (on the calls and interviews that reached them: how many asked about a specific last time, pitched, got a story of a minute or more, caught the fluff, and what they committed: counts of what the rules and reviews have said), reached rate by hour of the contact's day and by time zone, average length by outcome, the front desk (by name, and the lines that got the rep put through), objections and the openings that got past them, which follow-up gaps led to another connect, rushed connects (under 1:30) that left with no next step, and what the long connects did. bookedInterviews: the interviews those calls booked, followed to how each turned out (held, no-show, canceled by them or by the rep, still ahead, or past with nothing logged: toLog, each in toLogInterviews with the url to log it on), by how far ahead it was booked, calendar invite or not, and how long they talked on the call that booked it; one they canceled is a reply (they told the rep), a no-show isn't, and the rep's own cancels are left out of the groups. Groups smaller than minCallsForAPattern are too small to call a pattern.",
      annotations: READ,
    },
    () =>
      run(async () => {
        const { settings, report, bookings, momTest, unread } = await coachingOverview(c);
        return {
          ...coachingSummary(report, settings.timeZone, origin, momTest),
          bookedInterviews: bookingSummary(bookings, settings.timeZone, origin),
          callsNotReadYet: unread > 0,
        };
      })
  );

  server.registerTool(
    'what_you_heard',
    {
      title: 'What you’ve heard',
      description:
        "What prospects have told the rep across every call and interview that reached them, read by rules from their part of each transcript and from the rep's notes: the software they use (named tools, or a load board, a TMS, spreadsheets, paper, phone and text), with how many calls named each and the newest quotes; what they said about their work by theme (quoting and rates, dispatch and loads, invoicing and getting paid, drivers and people, compliance, the software they use), with how many calls touched each, how many of those hurt, and the quotes; and call by call. Counts of calls, never rates. This is the record: the synthesis (what keeps coming up, what to ask next, which segment to narrow to) is yours to do with the rep from it.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      run(async () => {
        const { settings, report } = await heardOverview(c);
        return heardSummary(report, settings.timeZone, origin);
      })
  );

  server.registerTool(
    'calls_to_review',
    {
      title: 'Calls to review',
      description:
        'Logged calls and recorded interviews worth a review, newest first: someone picked up (them or the front desk), and neither the rep nor Claude has reviewed it yet. Each with its kind (call or interview), its tags as the rules read them and which they were unsure of. Review each with get_call_review, then review_call.',
      inputSchema: { limit: z.number().int().min(1).max(25).default(10) },
      annotations: READ,
    },
    ({ limit }) =>
      run(async () => {
        const { settings, calls } = await callsForReview(c, limit);
        return {
          timeZone: settings.timeZone,
          calls: calls.map((call) => ({
            ...callInsightSummary(call, settings.timeZone, origin),
            unsure: parseUnsure(call.unsure),
          })),
        };
      })
  );

  server.registerTool(
    'get_call_review',
    {
      title: 'Call to review',
      description:
        "One logged call or recorded interview (task_id: the CALL task id, or the interview's meeting id from calls_to_review), to review it for coaching: the call (who, outcome, length, the rep's notes), its transcript turn by turn with times, the tags as read so far (reading: rules, with any reviews laid over them; unsure lists what nothing was sure of), the reviews so far, and the rules for reviewing it. Then save the review with review_call.",
      inputSchema: { task_id: id },
      annotations: READ,
    },
    ({ task_id }) => run(async () => callReviewSummary(await callForReview(c, task_id), origin))
  );

  server.registerTool(
    'get_meeting',
    {
      title: 'Interview',
      description:
        "One interview, for prep or logging: when, how to join (or the number, for a phone interview), the rep's interview questions, the contact's HubSpot history, and whether it was already logged. Pass its start_at to log_meeting.",
      inputSchema: { meeting_id: id },
      annotations: READ,
    },
    ({ meeting_id }) =>
      run(async () => {
        const hs = hubspot();
        const [parties, settings, dial] = await Promise.all([
          loadMeeting(hs, meeting_id, [...HISTORY_LINKS]),
          loadAppSettings(env),
          latestMeetingDial(env, meeting_id),
        ]);
        const { timeZone } = settings;
        const startAt = parseHubSpotTime(parties.meeting.properties.hs_meeting_start_time);
        const logs = d1MeetingLogStore(env.DB);
        const [context, lastEmail, log] = await Promise.all([
          loadCallContext(hs, parties),
          latestSendToContact(env.DB, parties.contact.id),
          logs.unfinished(meeting_id).then((row) => row ?? logs.get(meetingLogId(meeting_id, startAt))),
        ]);
        return {
          timeZone,
          theirTimeZone: partyTimeZone(parties.contact, parties.company),
          meeting: {
            ...meetingRowSummary(meetingRow(parties.meeting, parties), timeZone, origin),
            start_at: parties.meeting.properties.hs_meeting_start_time ?? null,
          },
          contact: contactSummary(parties.contact, origin),
          company: parties.company ? companySummary(parties.company, origin) : null,
          questions: { reminders: INTERVIEW_REMINDERS, sections: INTERVIEW_SECTIONS },
          lastEmail: lastEmailSummary(lastEmail, timeZone),
          callLive: dial ? isLive(dialState(dial, Math.floor(Date.now() / 1000))) : false,
          logged: log
            ? {
                outcome: log.outcome,
                notes: log.notes,
                finished: meetingLogDone(log),
                nextTask: log.next_type ? { type: log.next_type, due: log.next_due, id: log.next_task_id } : null,
              }
            : null,
          history: history(context, timeZone),
        };
      })
  );

  server.registerTool(
    'recent_inbound_calls',
    {
      title: 'Inbound calls',
      description:
        'The last 50 calls to the Twilio number: who called, whether it was answered or left a voicemail, and the summary of its transcript.',
      annotations: READ,
    },
    () =>
      run(async () => {
        const [calls, { timeZone }] = await Promise.all([d1InboundCallStore(env.DB).recent(50), loadAppSettings(env)]);
        return { timeZone, calls: calls.map((call) => inboundCallSummary(call, timeZone, origin)) };
      })
  );

  server.registerTool(
    'unfinished',
    {
      title: 'Unfinished writes',
      description:
        "HubSpot writes still saving, or that stopped short (with HubSpot's error). Running the same action again finishes one.",
      annotations: READ,
    },
    () => run(() => unfinishedWrites(env.DB, Math.floor(Date.now() / 1000)))
  );

  // ---- Writes ----

  server.registerTool(
    'save_draft',
    {
      title: 'Save draft',
      description:
        "Save an email draft (subject + plain-text body) on an EMAIL task. Replacing a draft already there needs overwrite: true, and only once the rep agreed. Nothing is sent: the rep reviews and sends it from the task's page.",
      inputSchema: {
        task_id: id,
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(10_000).describe('plain text, blank lines between paragraphs, no signature'),
        overwrite: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    ({ task_id, subject, body, overwrite }) =>
      run(async () => {
        const { replaced } = await saveEmailDraft(c, task_id, { subject, body, overwrite }).catch((err: unknown) => {
          // The page's wording points at its checkbox; here it's the overwrite argument.
          if (err instanceof WorkflowError && err.status === 409) {
            throw new WorkflowError(
              'This task already has a draft. Show it to the rep (get_email_task), and save again with overwrite: true only if they want it replaced.',
              409
            );
          }
          throw err;
        });
        return {
          saved: true,
          replaced,
          reviewAndSend: pageUrl(origin, `/tasks/${task_id}/send`),
        };
      })
  );

  server.registerTool(
    'mark_email_sent',
    {
      title: 'Mark email sent',
      description:
        "For an email the rep sent by hand (from Gmail or HubSpot), not from the app: completes the EMAIL task and creates tomorrow's CALL task. Only when the rep says it went out.",
      inputSchema: { task_id: id },
      annotations: WRITE,
    },
    ({ task_id }) =>
      run(async () => {
        await markEmailSent(c, task_id);
        return { marked: true, followUp: 'completing the task and creating tomorrow’s call task in HubSpot' };
      })
  );

  server.registerTool(
    'drop_email_task',
    {
      title: 'Drop email task',
      description: "The rep won't send this one: marks the EMAIL task deferred, off the queue, with no follow-up.",
      inputSchema: { task_id: id },
      annotations: WRITE,
    },
    ({ task_id }) =>
      run(async () => {
        await dropEmailTask(c, task_id);
        return { dropped: true };
      })
  );

  server.registerTool(
    'log_call',
    {
      title: 'Log call',
      description: `Log a call the rep made on a CALL task: the outcome and notes on the contact, the task completed, Lead Status moved on, and the follow-up task created. Follow-up "${LAST_TRY}" is the last-try email. Refused while a call for the task is live. To book an interview, use book_interview. The rep may have reached them on their own WhatsApp instead (channel): a WhatsApp call takes a call outcome; a WhatsApp message takes "${MESSAGE_OUTCOMES.map((o) => o.value).join('" or "')}", with the message's text as notes, and is logged as a WhatsApp message on the contact.`,
      inputSchema: {
        task_id: id,
        channel: z.enum(CALL_CHANNELS).default('phone'),
        outcome: z.enum([...CALL_OUTCOMES, ...MESSAGE_OUTCOMES].map((o) => o.value) as [string, ...string[]]),
        notes: z.string().max(10_000).default(''),
        whatsapp_field: z
          .enum(WHATSAPP_FIELDS)
          .optional()
          .describe("WhatsApp only: the contact's number they were reached on (default mobilephone)"),
        next_type: z.enum(['CALL', 'EMAIL', LAST_TRY]).optional().describe('the follow-up task, if any'),
        next_date: date.optional().describe("the follow-up's day, YYYY-MM-DD"),
        next_time: time
          .optional()
          .describe(
            'only when the contact asked to be called at a time: a set-time call, with a HubSpot reminder, that becomes the next call then'
          ),
        time_zone: timeZone,
        real_conversation: z
          .boolean()
          .optional()
          .describe(
            "only when the rep says so: they talked about their work and the rep learned something. Counts toward the rep's 100 real conversations (by person)"
          ),
        learned: z
          .string()
          .max(280)
          .optional()
          .describe('with real_conversation: what the rep learned, one line, their words'),
      },
      annotations: WRITE,
    },
    ({
      task_id,
      channel,
      outcome,
      notes,
      whatsapp_field,
      next_type,
      next_date,
      next_time,
      time_zone,
      real_conversation,
      learned,
    }) =>
      run(async () => {
        const logged = await logCall(
          c,
          task_id,
          {
            channel,
            whatsapp_field: whatsapp_field ?? '',
            outcome,
            notes,
            next_type: next_type ?? '',
            next_date: next_date ?? '',
            next_time: next_time ?? '',
            next_time_tz: time_zone ?? '',
            conversation: real_conversation ? '1' : '',
            learned: learned ?? '',
          },
          null
        );
        return logged.saving
          ? { logged: true, followUp: 'saving to HubSpot now; "unfinished" says if a step stops short' }
          : { logged: true, ...logged.result };
      })
  );

  server.registerTool(
    'snooze_call',
    {
      title: 'Move call',
      description:
        'Move a CALL task to a later day, keeping its time of day. Logs nothing. Give a time only when the contact asked to be called then: it makes a set-time call, which can be later today, gets a HubSpot reminder and becomes the next call at that time.',
      inputSchema: {
        task_id: id,
        date,
        time: time.optional().describe('only for a time the contact asked for'),
        time_zone: timeZone,
      },
      annotations: WRITE,
    },
    ({ task_id, date, time, time_zone }) =>
      run(async () => {
        const { dueAt } = await snoozeCallTask(c, task_id, date, time ?? '', time_zone ?? '');
        const { timeZone } = await loadAppSettings(env);
        return { moved: true, due: localTime(dueAt, timeZone) };
      })
  );

  server.registerTool(
    'drop_call_task',
    {
      title: 'Drop call task',
      description:
        "The rep won't make this call: marks the CALL task deferred, off the queue. Logs no call and creates no follow-up. Only when the rep says so.",
      inputSchema: { task_id: id },
      annotations: WRITE,
    },
    ({ task_id }) =>
      run(async () => {
        await dropCallTask(c, task_id);
        return { dropped: true };
      })
  );

  server.registerTool(
    'book_interview',
    {
      title: 'Book interview',
      description:
        "Book an interview set up another way (an email reply, a text) from the contact's CALL task, as a HubSpot meeting, without logging a call. Phone by default (the rep calls them). A video interview needs its join link (join_url). No calendar invite is sent from here: for an invite with a Meet link, the rep books it from the call's page.",
      inputSchema: {
        task_id: id,
        date,
        time,
        time_zone: timeZone,
        minutes: z
          .number()
          .int()
          .refine((m) => (LENGTHS_MIN as readonly number[]).includes(m), `one of ${LENGTHS_MIN.join(', ')}`)
          .default(30),
        format: z.enum(['phone', 'video']).default('phone'),
        join_url: z.string().url().optional().describe('video only: the https Meet or Zoom link'),
      },
      annotations: WRITE,
    },
    ({ task_id, date, time, time_zone, minutes, format, join_url }) =>
      run(async () => {
        // No invite from here, so nothing would make a Meet link: without the
        // rep's own link a video interview would have no way to join.
        if (format === 'video' && !join_url) {
          throw new WorkflowError(
            "A video interview needs its join link (join_url). Ask the rep for it, or have them book it from the call's page with a calendar invite, which adds a Meet link."
          );
        }
        const result = await bookInterview(c, task_id, {
          book_date: date,
          book_time: time,
          book_time_tz: time_zone,
          book_minutes: String(minutes),
          book_format: format,
          book_join_url: join_url,
          book_invite: undefined,
        });
        return { ...result, url: pageUrl(origin, `/meetings/${result.meetingId}`) };
      })
  );

  server.registerTool(
    'log_meeting',
    {
      title: 'Log interview',
      description:
        "Log how an interview went: the outcome and notes on the meeting (or its new time, for RESCHEDULED), Lead Status, and a follow-up task if asked. CANCELED takes canceled_by: 'them' (they told the rep ahead: a reply, counted apart from a no-show; an EMAIL follow-up comes drafted, offering another time) or 'rep'. If the app sent the contact a calendar invite, rescheduling or canceling updates it (Google emails them). start_at comes from get_meeting.",
      inputSchema: {
        meeting_id: id,
        start_at: z.string().min(1).describe("the meeting's start_at from get_meeting"),
        outcome: z.enum(LOGGABLE_OUTCOMES.map((o) => o.value) as [string, ...string[]]),
        notes: z.string().max(10_000).default(''),
        canceled_by: z.enum(['them', 'rep']).optional().describe("CANCELED only: who called it off (default 'them')"),
        new_date: date.optional().describe('RESCHEDULED only'),
        new_time: time.optional().describe('RESCHEDULED only'),
        time_zone: timeZone,
        next_type: z.enum(['CALL', 'EMAIL']).optional().describe('the follow-up task, if any'),
        next_date: date.optional().describe("the follow-up's day, YYYY-MM-DD"),
        real_conversation: z
          .boolean()
          .optional()
          .describe(
            "only when the rep says so: they talked about their work and the rep learned something. Counts toward the rep's 100 real conversations (by person). COMPLETED only"
          ),
        learned: z
          .string()
          .max(280)
          .optional()
          .describe('with real_conversation: what the rep learned, one line, their words'),
      },
      annotations: WRITE,
    },
    ({
      meeting_id,
      start_at,
      outcome,
      canceled_by,
      notes,
      new_date,
      new_time,
      time_zone,
      next_type,
      next_date,
      real_conversation,
      learned,
    }) =>
      run(async () => {
        const result = await logMeeting(
          c,
          meeting_id,
          {
            outcome,
            canceled_by,
            notes,
            new_date,
            new_time,
            new_time_tz: time_zone,
            next_type: next_type ?? '',
            next_date: next_date ?? '',
            conversation: real_conversation ? '1' : '',
            learned: learned ?? '',
          },
          start_at
        );
        const { timeZone } = await loadAppSettings(env);
        return { logged: true, ...result, newStartAt: localTime(result.newStartAt, timeZone) };
      })
  );

  server.registerTool(
    'open_task_for_contact',
    {
      title: 'Open task for contact',
      description:
        "The contact's open EMAIL or CALL task, or a new one due now if they have none. Use it to email or call someone who has no task yet.",
      inputSchema: {
        contact_id: id,
        type: z.enum(['EMAIL', 'CALL']),
        company_id: id.optional().describe("the company to link a new task to (default: the contact's first)"),
      },
      annotations: WRITE,
    },
    ({ contact_id, type, company_id }) =>
      run(async () => {
        const { taskId, created } = await openContactTask(c, contact_id, type, company_id ?? null);
        return {
          taskId,
          created,
          url: pageUrl(origin, type === 'CALL' ? `/calls/${taskId}` : `/tasks/${taskId}/draft`),
        };
      })
  );
  const number = z
    .string()
    .min(1)
    .max(40)
    .describe('the full number, e.g. 801 555 0143 (with +country code outside the US)');
  const ext = z
    .string()
    .max(16)
    .optional()
    .describe('the extension, digits only; Twilio keys it in when the line answers');
  server.registerTool(
    'save_contact_numbers',
    {
      title: 'Save contact numbers',
      description:
        "Set the contact's office phone and/or personal mobile in HubSpot, each with an optional extension. A number left out stays as it is. The company's main line can't be changed here.",
      inputSchema: {
        contact_id: id,
        phone: number.optional(),
        phone_ext: ext,
        mobile: number.optional(),
        mobile_ext: ext,
      },
      annotations: WRITE,
    },
    ({ contact_id, phone, phone_ext, mobile, mobile_ext }) =>
      run(async () => {
        if (!phone && !mobile) throw new WorkflowError('Give a phone or a mobile number to save.');
        const changes = await saveNumbers(
          c,
          contact_id,
          {
            ...(phone ? { phone: { number: phone, ext: phone_ext ?? '' } } : {}),
            ...(mobile ? { mobilephone: { number: mobile, ext: mobile_ext ?? '' } } : {}),
          },
          { workflow: 'task-action', taskId: contact_id }
        );
        return { saved: changes, unchanged: Object.keys(changes).length === 0 };
      })
  );

  server.registerTool(
    'save_call_lines',
    {
      title: 'Save call script lines',
      description: `Write the company's World and/or Pedestal line in its HubSpot description, which fill the call script's {their_world} and {pedestal}. A line left out keeps what's there, and the rest of the description stays as written. Company results show the current ones (theirWorld, pedestal; null when missing).\n\n${CALL_LINES_RULES}`,
      inputSchema: {
        company_id: id,
        their_world: z.string().max(200).optional(),
        pedestal: z.string().max(300).optional(),
      },
      annotations: WRITE,
    },
    ({ company_id, their_world, pedestal }) =>
      run(async () => {
        const { lines, changed } = await saveCompanyCallLines(c, company_id, {
          ...(their_world !== undefined ? { theirWorld: their_world } : {}),
          ...(pedestal !== undefined ? { pedestal } : {}),
        });
        return { saved: lines, unchanged: !changed };
      })
  );

  server.registerTool(
    'review_call',
    {
      title: 'Review a call',
      description:
        "Save a review of one logged call or recorded interview (task_id as in calls_to_review) for coaching, after reading it with get_call_review and following its rules: corrections for only the tags that were wrong or unsure (the rest keep the rules' reading), the Mom Test on it (asked about the last time, pitched, their longest story, fluff caught, what they committed), what worked, and what to adjust next time. Saved in the app only (not HubSpot); reviewing again replaces this reviewer's earlier review. reviewer 'rep' when the rep says what happened; the rep's review wins over Claude's. leave_out: true for a test call, to leave it out of coaching (false puts it back).",
      inputSchema: {
        task_id: id,
        reviewer: z.enum(REVIEWERS).default('claude'),
        corrections: z
          .object({
            whoAnswered: z.enum(GATES).optional(),
            frontDeskResult: z.enum(GATEKEEPER_RESULTS).nullable().optional(),
            reachedThem: z.boolean().optional(),
            stage: z.enum(STAGES).optional(),
            objection: z
              .object({
                kind: z.enum(OBJECTION_KINDS as [ObjectionKind, ...ObjectionKind[]]).nullable(),
                said: z.string().max(300).nullable().optional().describe('their words'),
              })
              .optional(),
            nextStep: z
              .object({
                agreed: z.boolean(),
                what: z.string().max(200).nullable().optional().describe('in a few words'),
              })
              .optional(),
            askedAboutLastTime: z.boolean().optional().describe('asked about a specific past instance'),
            pitched: z.boolean().optional().describe('described the idea or the product'),
            longestStorySec: z
              .number()
              .int()
              .min(0)
              .max(3600)
              .nullable()
              .optional()
              .describe('their longest uninterrupted stretch, from the stamps'),
            fluffCaught: z.boolean().optional().describe('brought "usually" / "I would" back to a past instance'),
            commitment: z.enum(COMMITMENTS).nullable().optional().describe('what they gave up: time, intro, money'),
          })
          .default({}),
        what_worked: z.string().max(1_000).optional(),
        adjust: z.string().max(1_000).optional(),
        leave_out: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    ({ task_id, reviewer, corrections, what_worked, adjust, leave_out }) =>
      run(async () => {
        const notes = await saveCallReview(c, task_id, {
          reviewer,
          corrections,
          what_worked: what_worked ?? null,
          adjust: adjust ?? null,
          leave_out,
        });
        const log = await d1CallLogStore(env.DB).get(task_id);
        // An interview's follow-up is on its latest log.
        const nextDue = log
          ? log.next_due
          : await (async () => {
              const dial = await d1DialStore(env.DB).latestForTask(task_id);
              return (await d1MeetingLogStore(env.DB).latest(task_id, dial?.started_sec ?? null))?.next_due ?? null;
            })();
        const { timeZone } = await loadAppSettings(env);
        return {
          saved: true,
          leftOut: leave_out ?? null,
          reading: afterCallSummary(notes, nextDue, timeZone),
          url: pageUrl(origin, log ? `/calls/${task_id}` : `/meetings/${task_id}`),
        };
      })
  );
}

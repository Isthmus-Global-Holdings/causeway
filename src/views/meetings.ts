import { html, raw } from 'hono/html';
import type { CallNotes } from '../actions/coaching';
import { formatLocal, localDate, saidAhead } from '../lib/dates';
import type { Dial, MeetingLog, RecentSend } from '../lib/db';
import type { MeetingOutcome } from '../lib/hubspot';
import { formatPhone, toE164 } from '../lib/phone';
import { htmlToText } from '../lib/richtext';
import { contactHoursNote } from '../lib/whatsapp';
import { whatsappInterviewNote } from '../prompts/whatsapp-messages';
import { INTERVIEW_REMINDERS, INTERVIEW_SECTIONS } from '../prompts/interview-questions';
import type { CallContext } from '../workflows/call-context';
import { isLive, type DialState } from '../workflows/dial';
import type { RecordingState } from '../workflows/transcribe';
import {
  browserCallPanel,
  browserCallScripts,
  dialStatus,
  historyCard,
  lastEmailCard,
  LIVE_STATUS_SCRIPT,
  liveDialStatus,
  numbersCard,
  POLL_SCRIPT,
  setupReady,
  setupWarning,
  transcriptCard,
  type CallsSetup,
  type DialView,
  type WhatsAppDraft,
} from './calls';
import { CANCELED_BY, LOGGABLE_OUTCOMES, meetingLogDone } from '../workflows/meeting-logged';
import {
  isOpen,
  meetingRow,
  type MeetingBuckets,
  type MeetingParties,
  type MeetingRow,
} from '../workflows/meeting-queue';
import { companyName, contactName } from '../workflows/parties';
import type { TodayCounts } from '../workflows/today';
import { coachingCard } from './coaching';
import { whereTheyAre } from './facts';
import { flash as flashBox, layout, recordUrl, timeInput, todayStrip, type Html } from './layout';

export const OUTCOME_LABELS: Record<MeetingOutcome, string> = {
  SCHEDULED: 'Scheduled',
  COMPLETED: 'Completed',
  RESCHEDULED: 'Rescheduled',
  NO_SHOW: 'No show',
  CANCELED: 'Canceled',
};

export interface MeetingsFlash {
  meetingId: string;
  outcome: MeetingOutcome;
  startAt: number | null; // the new time, when rescheduled
  nextTaskId: string | null;
  nextTaskCreated: boolean;
  inviteUpdated: boolean; // their calendar invite was moved or canceled
}

function when(row: MeetingRow, timeZone: string): Html {
  return row.startAt === null ? html`<span class="muted">no time</span>` : html`${formatLocal(row.startAt, timeZone)}`;
}

function meetingTableRow(row: MeetingRow, timeZone: string, showOutcome: boolean): Html {
  return html`<tr>
    <td data-label="When">${when(row, timeZone)}</td>
    <td>
      <div class="tight">
        <span><strong>${row.companyName ?? row.contactName ?? html`<span class="muted">no contact</span>`}</strong>${
          row.companyName && row.contactName ? html` · ${row.contactName}` : ''
        }${showOutcome ? html` <span class="fit">${OUTCOME_LABELS[row.outcome]}</span>` : ''}</span>
        <span class="muted">${row.title}${row.phone ? ` · ${formatPhone(row.phone)}` : ''}</span>
      </div>
    </td>
    <td class="row-actions">
      <div class="actions">
        ${row.joinUrl && !showOutcome ? html`<a class="button" href="${row.joinUrl}" target="_blank" rel="noopener">Join</a>` : ''}
        ${row.phoneCall && !row.joinUrl && !showOutcome ? html`<span class="fit">Phone call</span>` : ''}
        <a class="button${showOutcome ? '' : ' primary'}" href="/meetings/${row.meetingId}">Open</a>
      </div>
    </td>
  </tr>`;
}

function meetingTable(rows: MeetingRow[], timeZone: string, showOutcome = false): Html {
  return html`<table class="stacked">
    <thead><tr><th>When</th><th>Company · contact</th><th></th></tr></thead>
    <tbody>${rows.map((r) => meetingTableRow(r, timeZone, showOutcome))}</tbody>
  </table>`;
}

function loggedFlash(f: MeetingsFlash, timeZone: string): Html {
  const next = f.nextTaskId
    ? f.nextTaskCreated
      ? html` Follow-up task ${f.nextTaskId} created.`
      : html` Follow-up task ${f.nextTaskId} already existed, so no new one was created.`
    : '';
  if (f.outcome === 'SCHEDULED' && f.startAt !== null) {
    const invite = f.inviteUpdated ? ' Their calendar invite was moved, and they were told.' : '';
    return flashBox('ok', html`Interview moved to ${formatLocal(f.startAt, timeZone)}.${invite}${next}`);
  }
  const invite = f.inviteUpdated ? ' Their calendar invite was canceled, and they were told.' : '';
  return flashBox('ok', html`Interview marked ${OUTCOME_LABELS[f.outcome].toLowerCase()} in HubSpot.${invite}${next}`);
}

export function meetingsPage(
  buckets: MeetingBuckets,
  flash: MeetingsFlash | null,
  error: string | null,
  timeZone: string,
  today: TodayCounts,
  actor: string
): Html {
  const open = buckets.needsOutcome.length + buckets.today.length + buckets.upcoming.length;
  return layout(
    'Interviews',
    actor,
    html`
      ${flash ? loggedFlash(flash, timeZone) : ''}
      ${error ? flashBox('err', error) : ''}
      ${todayStrip(today)}
      <div class="row">
        <h1>Interviews</h1>
        <p class="muted">Meetings in HubSpot, from a week ago to two weeks ahead · ${open} open</p>
      </div>

      ${
        buckets.needsOutcome.length
          ? html`<section>
              <div class="row">
                <h2>How did it go? (${buckets.needsOutcome.length})</h2>
                <p class="muted">Over, but still marked scheduled. Open one to log the outcome and your notes.</p>
              </div>
              ${meetingTable(buckets.needsOutcome, timeZone)}
            </section>`
          : ''
      }

      <section>
        <h2>Today</h2>
        ${buckets.today.length ? meetingTable(buckets.today, timeZone) : html`<p class="muted">No more interviews today.</p>`}
      </section>

      ${
        buckets.upcoming.length
          ? html`<section>
              <h2>Upcoming (${buckets.upcoming.length})</h2>
              ${meetingTable(buckets.upcoming, timeZone)}
            </section>`
          : ''
      }

      ${
        buckets.recent.length
          ? html`<section>
              <h2>Recent</h2>
              ${meetingTable(buckets.recent, timeZone, true)}
            </section>`
          : ''
      }

      <p class="muted">Book an interview from a call: on the call's page, log the call with "Booked an interview", or use "Book an interview" if you set it up another way.</p>
    `,
    'meetings'
  );
}

export interface MeetingPageState {
  parties: MeetingParties;
  context: CallContext; // the contact's notes, calls and emails in HubSpot
  lastEmail: RecentSend | null;
  log: MeetingLog | null; // an earlier attempt at logging this interview, if one stopped partway
  booked: boolean; // just booked from a call
  dial: Dial | null; // the latest call made from this page
  dialState: DialState | null;
  recordingState: RecordingState | null;
  coaching: CallNotes | null; // what coaching read from that call, once it ended
  setup: CallsSetup;
  portalId: string;
  now: number;
  timeZone: string;
}

function questionsCard(): Html {
  return html`<div class="card">
    <h2>Questions</h2>
    <ul class="summary">${INTERVIEW_REMINDERS.map((r) => html`<li class="muted">${r}</li>`)}</ul>
    ${INTERVIEW_SECTIONS.map(
      (s) => html`<div class="tight">
        <h3>${s.heading}</h3>
        <ul class="summary">${s.questions.map((q) => html`<li>${q}</li>`)}</ul>
      </div>`
    )}
  </div>`;
}

function lastEmailBox(email: RecentSend | null, timeZone: string): Html {
  return html`<div class="card">
    <h2>Last email from this app</h2>
    ${lastEmailCard(email, timeZone)}
  </div>`;
}

// Shows the new-time fields only when "Moved to another time" is picked, and
// who canceled only when "Canceled" is. Picking "No show", or "Canceled" by
// them, sets up the follow-up: an email today, drafted from the missed- or
// canceled-interview template.
const RESCHEDULE_SCRIPT = `(() => {
  const outcome = document.getElementById('outcome');
  const moved = document.getElementById('new-time');
  const canceled = document.getElementById('canceled-by');
  const by = document.getElementById('canceled_by');
  const next = document.getElementById('next_type');
  const nextDate = document.getElementById('next_date');
  const hint = document.getElementById('no-show-hint');
  const cancelHint = document.getElementById('canceled-hint');
  if (!outcome || !moved) return;
  const theyCanceled = () => outcome.value === 'CANCELED' && (!by || by.value === 'them');
  const sync = () => {
    const on = outcome.value === 'RESCHEDULED';
    moved.hidden = !on;
    for (const input of moved.querySelectorAll('input')) input.required = on;
    if (canceled) canceled.hidden = outcome.value !== 'CANCELED';
    if (hint) hint.hidden = outcome.value !== 'NO_SHOW';
    if (cancelHint) cancelHint.hidden = !theyCanceled();
  };
  const emailToday = () => {
    if (!next || !nextDate) return;
    next.value = 'EMAIL';
    nextDate.value = nextDate.min;
  };
  outcome.addEventListener('change', () => {
    sync();
    if (outcome.value === 'NO_SHOW' || theyCanceled()) emailToday();
  });
  if (by) by.addEventListener('change', () => {
    sync();
    if (theyCanceled()) emailToday();
  });
  sync();
})();`;

function logForm(state: MeetingPageState, startAt: number | null): Html {
  const id = state.parties.meeting.id;
  const today = localDate(state.now, state.timeZone);
  const defaultNext = localDate(state.now + 86_400_000, state.timeZone);
  return html`<form class="card" id="log-form" method="post" action="/meetings/${id}/log">
    <h2>How did it go?</h2>
    <input type="hidden" name="start" value="${startAt === null ? '' : String(startAt)}" />
    <div class="field">
      <label for="outcome">Outcome</label>
      <select id="outcome" name="outcome">
        ${LOGGABLE_OUTCOMES.map((o) => html`<option value="${o.value}">${o.label}</option>`)}
      </select>
    </div>
    <div class="field" id="canceled-by" hidden>
      <label for="canceled_by">Who canceled?</label>
      <select id="canceled_by" name="canceled_by">
        ${CANCELED_BY.map((c) => html`<option value="${c.value}">${c.label}</option>`)}
      </select>
      <p class="muted">When they cancel, they told you rather than not turning up: a reply, so the line is open. Coaching counts it apart from a no-show.</p>
    </div>
    <div class="grid-2" id="new-time">
      <div class="field">
        <label for="new_date">New date</label>
        <input type="date" id="new_date" name="new_date" min="${today}" />
      </div>
      <div class="field">
        <label for="new_time">New time</label>
        ${timeInput({ name: 'new_time', id: 'new_time' })}
      </div>
    </div>
    <div class="field">
      <label for="notes">Interview notes</label>
      <textarea id="notes" name="notes" class="mono" placeholder="What they told you, in their words. What they do today, what it costs them, who else to talk to."></textarea>
    </div>
    <div class="grid-2">
      <div class="field">
        <label for="next_type">Follow-up task</label>
        <select id="next_type" name="next_type">
          <option value="" selected>None</option>
          <option value="EMAIL">Email (thank them, send what you promised)</option>
          <option value="CALL">Call</option>
        </select>
        <p class="muted" id="no-show-hint" hidden>After a no-show, the email comes drafted: sorry we missed each other, another time, or 3 questions by email. Sending it sets up tomorrow's call.</p>
        <p class="muted" id="canceled-hint" hidden>When they canceled, the email comes drafted: thanks for letting me know, another time, or 3 questions by email. Sending it sets up tomorrow's call.</p>
      </div>
      <div class="field">
        <label for="next_date">On</label>
        <input type="date" id="next_date" name="next_date" value="${defaultNext}" min="${today}" />
      </div>
    </div>
    <ol class="consequences">
      <li>The meeting in HubSpot gets this outcome, and your notes go in its internal notes. Moved: it moves to the new time instead.</li>
      <li>If you sent them a calendar invite from here, moving or canceling updates it, and Google emails them.</li>
      <li>The follow-up task, if any, is created for that day at 9:00. After a no-show, or when they canceled, an email follow-up comes with its draft written.</li>
      <li>If it happened or was moved, their Lead Status moves to Connected, unless you've already set it further along.</li>
    </ol>
    ${
      state.log
        ? flashBox(
            'warn',
            'An earlier attempt stopped partway. Logging again finishes it with what you entered the first time.'
          )
        : ''
    }
    <button type="submit" class="primary wide">Log interview</button>
  </form>`;
}

// The interview page's WhatsApp button: a note to check the time still works.
function interviewWhatsApp(state: MeetingPageState, row: MeetingRow): WhatsAppDraft | null {
  if (row.startAt === null) return null;
  return {
    text: whatsappInterviewNote({
      firstName: state.parties.contact.properties.firstname,
      repName: state.setup.fromName,
      when: saidAhead(row.startAt, state.now, state.timeZone),
    }),
    note: contactHoursNote(state.now, state.timeZone),
  };
}

// Calling the contact from the interview page, the same way as from a call
// task. For a phone interview it's how the interview starts, so it goes first.
function callCard(view: DialView, canDial: boolean, phoneCall: boolean): Html {
  return html`<div class="card">
    <h2>${phoneCall ? 'Call them: it’s a phone interview' : 'Call them'}</h2>
    ${setupWarning(view.setup)}
    ${numbersCard(view, canDial)}
  </div>`;
}

export function meetingPage(state: MeetingPageState, actor: string): Html {
  const { meeting, contact, company } = state.parties;
  const p = meeting.properties;
  const row = meetingRow(meeting, { contact, company });
  const company_ = companyName(company);
  const contact_ = contactName(contact);
  const open = isOpen(row.outcome) || (state.log !== null && !meetingLogDone(state.log));
  const phones = [contact.properties.phone, contact.properties.mobilephone, company?.properties.phone]
    .map((n) => toE164(n))
    .filter((n): n is string => Boolean(n));
  const notes = p.hs_internal_meeting_notes ? htmlToText(p.hs_internal_meeting_notes) : '';
  const page = `/meetings/${meeting.id}`;
  const view: DialView = {
    ...state,
    page,
    parties: { contact, company },
    whatsapp: isOpen(row.outcome) ? interviewWhatsApp(state, row) : null,
  };
  const live = state.dialState !== null && isLive(state.dialState);
  const canDial = setupReady(state.setup) && !live && isOpen(row.outcome);
  const browserCalls = canDial && state.setup.callWith === 'browser';
  const recording =
    !live && state.dial && state.recordingState && state.recordingState.kind !== 'none'
      ? transcriptCard(
          page,
          state.dial,
          state.recordingState,
          'You can log the interview now: the transcript goes into its notes if it’s ready by then, and stays here either way.'
        )
      : '';

  return layout(
    `Interview · ${company_ ?? contact_}`,
    actor,
    html`
      <p><a href="/meetings">← Interviews</a></p>
      ${state.booked ? flashBox('ok', 'Interview booked: it’s a meeting on the contact in HubSpot now.') : ''}
      ${live ? liveDialStatus(page, state) : dialStatus(state)}
      <div class="tight">
        <h1>${company_ ?? contact_}</h1>
        <p class="muted">
          <a href="/contacts/${contact.id}">${contact_}</a>${contact.properties.jobtitle ? ` · ${contact.properties.jobtitle}` : ''} ·
          ${row.title} ·
          <a href="${recordUrl(state.portalId, '0-1', contact.id)}" target="_blank" rel="noopener">contact in HubSpot</a>
        </p>
      </div>
      ${whereTheyAre(contact, company)}
      <div class="card">
        <div class="row">
          <div class="tight">
            <span><strong>${row.startAt === null ? 'No time set' : formatLocal(row.startAt, state.timeZone)}</strong>${
              row.startAt !== null && row.endAt !== null
                ? html` <span class="muted">(${Math.round((row.endAt - row.startAt) / 60_000)} min)</span>`
                : ''
            } <span class="fit">${OUTCOME_LABELS[row.outcome]}</span></span>
            <span class="muted">${phones.length ? phones.map(formatPhone).join(' · ') : 'No phone number in HubSpot'}${
              contact.properties.email ? ` · ${contact.properties.email}` : ''
            }</span>
          </div>
          <div class="actions">
            ${row.joinUrl ? html`<a class="button primary" href="${row.joinUrl}" target="_blank" rel="noopener">Join</a>` : ''}
            ${row.phoneCall && !row.joinUrl ? html`<span class="fit">Phone call · you call them</span>` : ''}
          </div>
        </div>
        ${p.hs_meeting_body ? html`<p class="muted pre">${htmlToText(p.hs_meeting_body)}</p>` : ''}
      </div>

      <div class="with-aside">
        <div class="stack">
          ${open && row.phoneCall ? callCard(view, canDial, true) : ''}
          ${browserCalls ? browserCallPanel : ''}
          ${recording}
          ${!live && state.coaching ? coachingCard({ before: [], brief: null, after: state.coaching }) : ''}
          ${questionsCard()}
          ${historyCard(state)}
          ${lastEmailBox(state.lastEmail, state.timeZone)}
          ${open && !row.phoneCall ? callCard(view, canDial, false) : ''}
        </div>
        ${
          live
            ? html`<div class="card"><p class="muted">The log form appears when the call ends. This page updates on its own.</p></div>`
            : open
              ? logForm(state, row.startAt)
              : html`<div class="card">
                <h2>Logged</h2>
                <p>This interview is marked ${OUTCOME_LABELS[row.outcome].toLowerCase()} in HubSpot.</p>
                ${notes ? html`<p class="scroll pre">${notes}</p>` : ''}
              </div>`
        }
      </div>
      ${open && !live ? html`<script>${raw(RESCHEDULE_SCRIPT)}</script>` : ''}
      ${!live && state.recordingState?.kind === 'pending' ? html`<script>${raw(POLL_SCRIPT)}</script>` : ''}
      ${browserCalls ? browserCallScripts() : ''}
      ${live ? html`<script>${raw(LIVE_STATUS_SCRIPT)}</script>` : ''}
    `,
    'meetings'
  );
}

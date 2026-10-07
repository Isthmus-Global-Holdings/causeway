import { html } from 'hono/html';
import type { CallCoaching, CoachingOverview } from '../actions/coaching';
import { clock } from '../lib/call-history';
import {
  adjustNotes,
  FAST_CALL_SEC,
  GATE_LABELS,
  GATEKEEPER_RESULT_LABELS,
  LONG_CONNECT_SEC,
  objectionFor,
  parseUnsure,
  STAGE_LABELS,
  type CoachNote,
  type InsightFields,
  type Tag,
} from '../lib/call-insight';
import {
  bestHour,
  BOOKING_STATUS_LABELS,
  heldRate,
  hourLabel,
  MIN_SAMPLE,
  pct,
  rateOf,
  type BookingReport,
  type BookingSplit,
  type Quote,
  type Rate,
  type Style,
} from '../lib/coaching';
import { formatLocal } from '../lib/dates';
import type { CallInsight } from '../lib/db';
import { CALL_OUTCOMES } from '../workflows/call-logged';
import { layout, type Html } from './layout';

function noteList(notes: CoachNote[]): Html {
  return html`<ul class="coach">
    ${notes.map((n) => html`<li class="${n.kind}">${n.text}</li>`)}
  </ul>`;
}

const TAG_WORDS: Record<Tag, string> = {
  whoAnswered: 'who answered',
  frontDeskResult: 'what the front desk did',
  reachedThem: 'whether you reached them',
  stage: 'how far it got',
  objection: 'the objection',
  nextStep: 'the next step',
};

// What coaching read from one call, in a line: who answered, the phone
// menu, how far it got, the objection and the next step, and what it
// wasn't sure of.
export function callTags(call: InsightFields, unsure: Tag[]): Html {
  const who =
    call.gate === 'gatekeeper'
      ? `Front desk${call.gatekeeper_name ? ` (${call.gatekeeper_name})` : ''}${call.gatekeeper_result ? `: ${GATEKEEPER_RESULT_LABELS[call.gatekeeper_result]}` : ''}`
      : GATE_LABELS[call.gate];
  const parts = [
    who,
    call.phone_tree_sec !== null
      ? `Phone menu ${clock(call.phone_tree_sec)}${call.phone_tree_digit ? ` (press ${call.phone_tree_digit})` : ''}`
      : '',
    call.reached && call.talk_sec !== null ? `Talked ${clock(call.talk_sec)}` : '',
    call.objection_kind ? `Objection: ${objectionFor(call.objection_kind)?.label ?? call.objection_kind}` : '',
    call.next_step ? `Next step: ${call.next_step_text ?? 'agreed'}` : '',
  ].filter(Boolean);
  return html`<p>
    <span class="tag">${STAGE_LABELS[call.stage]}</span> ${parts.join(' · ')}
    ${unsure.length ? html`<span class="muted">· Not sure of ${unsure.map((t) => TAG_WORDS[t]).join(', ')}</span>` : ''}
  </p>`;
}

// On the call page: quiet notes, never in the way. What to adjust after the
// call just logged, then what's worked on calls like this one.
export function coachingCard(coaching: CallCoaching): Html | '' {
  const { after } = coaching;
  if (!after && !coaching.before.length) return '';
  return html`<div class="card" id="coaching">
    <div class="row"><h2>Coaching</h2><a class="muted" href="/coaching">Patterns across your calls</a></div>
    ${after ? html`<div class="tight"><h3>After the call with ${after.label}</h3>${callTags(after.read, after.unsure)}${noteList(after.notes)}</div>` : ''}
    ${coaching.before.length ? html`<div class="tight"><h3>Before this call</h3>${noteList(coaching.before)}</div>` : ''}
  </div>`;
}

const outcomeLabel = (outcome: string) => CALL_OUTCOMES.find((o) => o.value === outcome)?.label ?? outcome;

function rateCells(rate: Rate): Html {
  const thin = rate.calls < MIN_SAMPLE;
  return html`<td data-label="Calls">${rate.calls}</td>
    <td data-label="Reached">${rate.reached}</td>
    <td data-label="Rate" class="${thin ? 'muted' : ''}">${pct(rateOf(rate))}${thin ? ' (few calls)' : ''}</td>`;
}

function quoteList(quotes: Quote[]): Html | '' {
  if (!quotes.length) return '';
  return html`<ul class="coach">
    ${quotes.map((q) => html`<li>“${q.text}” <span class="muted">· <a href="/calls/${q.callTaskId}">${q.label}</a></span></li>`)}
  </ul>`;
}

function callLink(call: CallInsight, timeZone: string): Html {
  return html`<a href="/calls/${call.call_task_id}">${call.label}</a>
    <span class="muted">· ${formatLocal(call.at_sec * 1000, timeZone)}${call.duration_sec !== null ? ` · ${clock(call.duration_sec)}` : ''}</span>`;
}

function styleRow(label: string, style: Style): Html {
  return html`<tr>
    <td>${label}</td>
    <td data-label="With a transcript">${style.calls}</td>
    <td data-label="They talked">${pct(style.talkShare)}</td>
    <td data-label="Your questions">${style.questions === null ? '–' : style.questions.toFixed(1)}</td>
    <td data-label="“You” over “we”">${pct(style.youFocus)}</td>
  </tr>`;
}

function splitRow(split: BookingSplit): Html {
  const thin = split.decided < MIN_SAMPLE;
  return html`<tr>
    <td>${split.label}</td>
    <td data-label="Ended">${split.decided}</td>
    <td data-label="Held">${split.held}</td>
    <td data-label="No-show">${split.noShow}</td>
    <td data-label="They canceled">${split.canceled}</td>
    <td data-label="Held rate" class="${thin ? 'muted' : ''}">${pct(heldRate(split))}${thin ? ' (few)' : ''}</td>
  </tr>`;
}

// The interviews the calls booked, followed to how each turned out.
function bookingsCard(bookings: BookingReport, timeZone: string): Html {
  if (!bookings.booked) {
    return html`<section class="card">
      <h2>Interviews you booked, and how they turned out</h2>
      <p class="muted">No interview booked from a call yet. Each one you book is followed here to how it went, once you log it on Interviews.</p>
    </section>`;
  }
  const ended = bookings.held + bookings.noShow + bookings.canceled;
  const splits = [...bookings.byLeadTime, ...bookings.byInvite, ...bookings.byCallLength];
  return html`<section class="card">
    <h2>Interviews you booked, and how they turned out</h2>
    <p>
      ${bookings.booked} booked from your calls: ${bookings.held} held, ${bookings.noShow} no-show${bookings.noShow === 1 ? '' : 's'},
      ${bookings.canceled} canceled by them${bookings.youCanceled ? `, ${bookings.youCanceled} by you` : ''}${bookings.upcoming ? `, ${bookings.upcoming} still ahead` : ''}${bookings.toLog ? `, ${bookings.toLog} to log` : ''}.
      ${ended ? html`Of the ${ended} that ended, ${pct(bookings.held / ended)} were held.` : ''}
      ${bookings.moved ? html`<span class="muted">${bookings.moved} moved at least once.</span>` : ''}
    </p>
    <p class="muted">Their cancel is a reply: they told you instead of leaving you waiting, so the line is open. Offer another time. A no-show said nothing. The ones you canceled aren’t counted in the held rate.</p>
    ${
      bookings.toLogRows.length
        ? html`<ul class="coach">
            ${bookings.toLogRows.map(
              (b) => html`<li class="flag">
                <a href="/meetings/${b.meeting_id}">${b.label}</a>
                <span class="muted">· ${formatLocal(Date.parse(b.start), timeZone)} · its time has passed: log how it went</span>
              </li>`
            )}
          </ul>`
        : ''
    }
    ${
      splits.length
        ? html`<table class="stacked">
            <thead><tr><th>Bookings</th><th>Ended</th><th>Held</th><th>No-show</th><th>They canceled</th><th>Held rate</th></tr></thead>
            <tbody>${splits.map(splitRow)}</tbody>
          </table>`
        : ''
    }
    <h3>Latest bookings</h3>
    <ol class="calls">
      ${bookings.recent.map(
        ({ booking, status }) => html`<li>
          <span class="tag">${BOOKING_STATUS_LABELS[status]}</span>
          <a href="/meetings/${booking.meeting_id}">${booking.label}</a>
          <span class="muted">· for ${formatLocal(Date.parse(booking.start), timeZone)}${booking.moves ? ` · moved ${booking.moves === 1 ? 'once' : `${booking.moves} times`}` : ''} · <a href="/calls/${booking.call_task_id}">the call</a></span>
        </li>`
      )}
    </ol>
  </section>`;
}

export function coachingPage({ settings, report, bookings, unread }: CoachingOverview, actor: string): Html {
  const tz = settings.timeZone;
  const { gatekeeper, fastNoNextStep } = report;
  const best = bestHour(report.byHour);
  const reading = unread
    ? html`<p class="muted">Some logged calls haven’t been read for coaching yet. They’re being read in the background: refresh in a minute to include them.</p>`
    : '';

  if (!report.calls) {
    return layout(
      'Coaching',
      actor,
      html`<h1>Coaching</h1>
        ${reading}
        <p class="muted">Nothing to learn from yet. Each call you log is read here: who answered, how far it got, the objection, and whether a next step was agreed.</p>`,
      'coaching'
    );
  }

  return layout(
    'Coaching',
    actor,
    html`
      <div class="tight">
        <h1>Coaching</h1>
        <p class="muted">
          From ${report.calls} logged call${report.calls === 1 ? '' : 's'}: someone picked up ${pct(report.answered / report.calls)},
          you reached the person ${pct(report.reached / report.calls)}${best ? html`, most often at ${hourLabel(best.hour)} their time` : ''}.
          The same notes show on each call page, before and after the call.
        </p>
      </div>
      ${reading}

      ${bookingsCard(bookings, tz)}

      <section class="card">
        <h2>The front desk</h2>
        ${
          gatekeeper.calls
            ? html`<p>
                  A front desk answered ${gatekeeper.calls} call${gatekeeper.calls === 1 ? '' : 's'} and put you through on
                  ${gatekeeper.putThrough} (${pct(gatekeeper.putThrough / gatekeeper.calls)}).
                  ${gatekeeper.results.length ? html`<span class="muted">${gatekeeper.results.map((r, i) => `${i ? ', ' : ''}${r.label}: ${r.count}`)}.</span>` : ''}
                </p>
                ${
                  gatekeeper.names.length
                    ? html`<p class="muted">By name: ${gatekeeper.names.map((n, i) => `${i ? '; ' : ''}${n.name} (${n.label}): ${n.calls} call${n.calls === 1 ? '' : 's'}, put through ${n.putThrough}`)}.</p>`
                    : ''
                }
                <h3>What you said when they put you through</h3>
                ${
                  gatekeeper.linesThatWorked.length
                    ? quoteList(gatekeeper.linesThatWorked)
                    : html`<p class="muted">Nothing recorded has got through yet. Try asking for them by first name as if they expect you, and when they’re out, ask when to catch them or for their direct line.</p>`
                }`
            : html`<p class="muted">No calls stopped at a front desk yet.</p>`
        }
      </section>

      <section class="card">
        <h2>Rushed connects with no next step</h2>
        <p>
          ${fastNoNextStep.calls.length} of ${fastNoNextStep.connects} connect${fastNoNextStep.connects === 1 ? '' : 's'} ended under
          ${clock(FAST_CALL_SEC)} without a callback time or another next step. These are the ones that evaporate: when they’re rushed,
          leave with a time.
        </p>
        ${
          fastNoNextStep.calls.length
            ? html`<ul class="coach">
                ${fastNoNextStep.calls.slice(0, 10).map((c) => html`<li class="flag">${callLink(c, tz)}${c.objection ? html` · “${c.objection}”` : ''}</li>`)}
              </ul>`
            : ''
        }
      </section>

      <section class="card">
        <h2>Long connects: what they did differently</h2>
        ${
          report.longConnects.length
            ? html`<ul class="coach">
                ${report.longConnects.slice(0, 5).map(
                  (c) => html`<li class="bright">
                    ${callLink(c, tz)}
                    ${c.what_worked ? html`<br />${c.what_worked}` : ''}
                    ${c.opening ? html`<br /><span class="muted">Opening:</span> “${c.opening}”` : ''}
                    ${c.next_step_text ? html`<br /><span class="muted">Agreed:</span> ${c.next_step_text}` : ''}
                  </li>`
                )}
              </ul>`
            : html`<p class="muted">No connect has run past ${clock(LONG_CONNECT_SEC)} yet.</p>`
        }
        ${
          report.style.long.calls && report.style.short.calls
            ? html`<table class="stacked">
                <thead><tr><th>Recorded connects</th><th>With a transcript</th><th>They talked</th><th>Your questions</th><th>“You” over “we”</th></tr></thead>
                <tbody>${styleRow(`Long (${clock(LONG_CONNECT_SEC)}+)`, report.style.long)}${styleRow('Short (under 2:00)', report.style.short)}</tbody>
              </table>
              <p class="muted">The pitch lands when the call is about their world: the more they talk and the more you say “you” rather than “we”, the longer it runs.</p>`
            : ''
        }
      </section>

      <section class="card">
        <h2>Objections, and the openings that got past them</h2>
        ${
          report.objections.length
            ? html`<table class="stacked">
                <thead><tr><th>Objection</th><th>Times</th><th>Got past</th><th>In their words</th><th>Openings that got past it</th></tr></thead>
                <tbody>
                  ${report.objections.map(
                    (o) => html`<tr>
                      <td>${o.label}</td>
                      <td data-label="Times">${o.count}</td>
                      <td data-label="Got past">${o.gotPast}</td>
                      <td data-label="In their words">${quoteList(o.examples) || html`<span class="muted">–</span>`}</td>
                      <td data-label="Openings">${quoteList(o.openings) || html`<span class="muted">None recorded yet</span>`}</td>
                    </tr>`
                  )}
                </tbody>
              </table>`
            : html`<p class="muted">No objections read from your calls yet.</p>`
        }
      </section>

      <div class="grid-2">
        <section class="card">
          <h2>Reached, by hour of their day</h2>
          <table class="stacked">
            <thead><tr><th>Hour</th><th>Calls</th><th>Reached</th><th>Rate</th></tr></thead>
            <tbody>${report.byHour.map((h) => html`<tr><td>${hourLabel(h.hour)}</td>${rateCells(h)}</tr>`)}</tbody>
          </table>
        </section>
        <section class="card">
          <h2>Reached, by their time zone</h2>
          <table class="stacked">
            <thead><tr><th>Zone</th><th>Calls</th><th>Reached</th><th>Rate</th></tr></thead>
            <tbody>${report.byZone.map((z) => html`<tr><td>${z.label}</td>${rateCells(z)}</tr>`)}</tbody>
          </table>
          <p class="muted">From the contact’s state (or their company’s). Unknown ones are counted in your time zone.</p>
        </section>
      </div>

      <section class="card">
        <h2>Which follow-up timing led to another connect</h2>
        ${
          report.followUps.length
            ? html`<table class="stacked">
                <thead><tr><th>Gap since the last call</th><th>After reaching them: reached again</th><th>Not reached yet: reached</th></tr></thead>
                <tbody>
                  ${report.followUps.map(
                    (f) => html`<tr>
                      <td>${f.label}</td>
                      <td data-label="After reaching them">${f.afterConnect.calls ? `${f.afterConnect.reached} of ${f.afterConnect.calls} (${pct(rateOf(f.afterConnect))})` : '–'}</td>
                      <td data-label="Not reached yet">${f.beforeConnect.calls ? `${f.beforeConnect.reached} of ${f.beforeConnect.calls} (${pct(rateOf(f.beforeConnect))})` : '–'}</td>
                    </tr>`
                  )}
                </tbody>
              </table>`
            : html`<p class="muted">No one has been called twice yet.</p>`
        }
      </section>

      <div class="grid-2">
        <section class="card">
          <h2>Average length, by outcome</h2>
          <table class="stacked">
            <thead><tr><th>Outcome</th><th>Calls</th><th>Average</th></tr></thead>
            <tbody>
              ${report.lengthByOutcome.map(
                (l) =>
                  html`<tr><td>${outcomeLabel(l.outcome)}</td><td data-label="Calls">${l.calls}</td><td data-label="Average">${clock(l.avgSec)}</td></tr>`
              )}
            </tbody>
          </table>
        </section>
        <section class="card">
          <h2>How far calls get</h2>
          <table class="stacked">
            <thead><tr><th>Got as far as</th><th>Calls</th></tr></thead>
            <tbody>${report.stages.map((s) => html`<tr><td>${s.label}</td><td data-label="Calls">${s.count}</td></tr>`)}</tbody>
          </table>
        </section>
      </div>

      <section class="card">
        <h2>Your last calls</h2>
        <ol class="calls">
          ${report.recent.map((c) => {
            const notes = adjustNotes(c);
            return html`<li class="tight">
              <div>${callLink(c, tz)}</div>
              ${callTags(c, parseUnsure(c.unsure))}
              ${notes.length ? noteList(notes) : ''}
            </li>`;
          })}
        </ol>
      </section>
    `,
    'coaching'
  );
}

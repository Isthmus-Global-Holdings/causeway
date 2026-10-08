import { html } from 'hono/html';
import type { CallCoaching, CoachingOverview, Strip } from '../actions/coaching';
import { clock } from '../lib/call-history';
import {
  adjustNotes,
  COMMITMENT_LABELS,
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
  HOUR_SAMPLE,
  hourLabel,
  insightPath,
  MIN_SAMPLE,
  pct,
  rateOf,
  STRIPS,
  type BookingReport,
  type BookingSplit,
  type CoachingReport,
  type Funnel,
  type MomTestReport,
  type Quote,
  type Rate,
  type Style,
} from '../lib/coaching';
import { STORY_SEC, timelineText, type Timeline } from '../lib/call-timeline';
import { firstLine, MAX_LEARNED, type ConversationReport } from '../lib/conversations';
import { formatLocal } from '../lib/dates';
import type { CallInsight, ConversationCandidate } from '../lib/db';
import { CALL_OUTCOMES } from '../workflows/call-logged';
import { coachingTabs, layout, type Html } from './layout';
import { timelineStrip } from './timeline';

const outcomeLabel = (outcome: string) => CALL_OUTCOMES.find((o) => o.value === outcome)?.label ?? outcome;

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
  askedAboutLastTime: 'whether you asked about the last time',
  pitched: 'whether you pitched',
  longestStorySec: 'their longest story',
  fluffCaught: 'whether you caught the fluff',
  commitment: 'what they committed',
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
    // The Mom Test, as far as anything has said.
    call.asked_last_time === 1 ? 'Asked about the last time' : '',
    call.pitched === 1 ? 'Pitched' : '',
    call.longest_story_sec !== null && call.longest_story_sec >= STORY_SEC
      ? `Story ${clock(call.longest_story_sec)}`
      : '',
    call.fluff_caught === 1 ? 'Caught the fluff' : '',
    call.commitment ? `They gave ${COMMITMENT_LABELS[call.commitment]}` : '',
  ].filter(Boolean);
  return html`<p>
    <span class="tag">${STAGE_LABELS[call.stage]}</span> ${parts.join(' · ')}
    ${unsure.length ? html`<span class="muted">· Not sure of ${unsure.map((t) => TAG_WORDS[t]).join(', ')}</span>` : ''}
  </p>`;
}

// On the call page: quiet notes, never in the way. What to adjust after the
// call just logged (the call drawn to scale, its tags, the notes), then
// what's worked on calls like this one.
export function coachingCard(coaching: CallCoaching): Html | '' {
  const { after } = coaching;
  if (!after && !coaching.before.length) return '';
  return html`<div class="card" id="coaching">
    <div class="row"><h2>Coaching</h2><a class="muted" href="/coaching">Patterns across your calls</a></div>
    ${
      after
        ? html`<div class="tight">
            <h3>After the call with ${after.label}</h3>
            ${after.timeline ? timelineStrip(after.timeline, { outcome: outcomeLabel(after.outcome) }) : ''}
            ${callTags(after.read, after.unsure)}${noteList(after.notes)}
          </div>`
        : ''
    }
    ${coaching.before.length ? html`<div class="tight"><h3>Before this call</h3>${noteList(coaching.before)}</div>` : ''}
  </div>`;
}

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

export interface Bar {
  label: Html | string;
  value: number;
  of: number; // the bar's full width
  shown?: string; // beside the bar, if not the value
  tone?: 'quiet' | 'warn';
  half?: boolean; // a mark at half way
}

// A bar chart: each row's bar as wide as its share, its count beside it. The
// count is the text: the bar is only a picture of it.
export function bars(name: string, rows: Bar[]): Html {
  return html`<dl class="bars" aria-label="${name}">
    ${rows.map((r) => {
      const width = r.of ? Math.round((Math.min(r.value, r.of) / r.of) * 100) : 0;
      return html`<dt>${r.label}</dt>
        <dd class="track" aria-hidden="true">
          <span class="fill ${r.tone ?? ''}" style="--w: ${width}%"></span>${r.half ? html`<span class="half"></span>` : ''}
        </dd>
        <dd class="n">${r.shown ?? String(r.value)}</dd>`;
    })}
  </dl>`;
}

// Every call, step by step to an interview held, and the step that loses the most.
function funnelCard({ steps, leak, upcoming }: Funnel): Html {
  return html`<section class="card">
    <h2>How far your calls get</h2>
    ${bars(
      'How far your calls get',
      steps.map((s) => ({
        label: s.label,
        value: s.count,
        of: steps[0].count,
        tone: leak?.to.key === s.key ? 'warn' : undefined,
      }))
    )}
    ${
      leak
        ? html`<p><strong>Most calls stop between “${leak.from.label}” and “${leak.to.label}”</strong> (${leak.from.count} → ${leak.to.count}). ${leak.advice}</p>`
        : ''
    }
    <p class="muted">
      Counts, not rates, so they hold at any number of calls.${upcoming ? ` ${upcoming} booked interview${upcoming === 1 ? ' hasn’t' : 's haven’t'} been held or missed yet.` : ''}
    </p>
  </section>`;
}

// On each call that reached them and has a transcript: their share of the
// words, against half.
function talkCard({ talk, theyLed }: Pick<CoachingReport, 'talk' | 'theyLed'>, timeZone: string): Html {
  if (!talk.length) {
    return html`<section class="card">
      <h2>Who did the talking</h2>
      <p class="muted">No recorded call has reached them yet. Each one that does shows here: how much of it they talked.</p>
    </section>`;
  }
  return html`<section class="card">
    <h2>Who did the talking</h2>
    <p>
      They talked more than you on ${theyLed.calls} of the ${theyLed.of} recorded call${theyLed.of === 1 ? '' : 's'} and interviews that reached them.
      On an interview they should do most of it: their world, what they did the last time, not your idea.
    </p>
    ${bars(
      'Their share of the words',
      talk.map((c) => {
        const share = c.prospect_talk_share ?? 0;
        return {
          label: html`<a href="${insightPath(c)}" title="${formatLocal(c.at_sec * 1000, timeZone)}">${c.label}</a>${c.subject === 'meeting' ? html` <span class="tag">Interview</span>` : ''}`,
          value: Math.round(share * 100),
          of: 100,
          shown: pct(share),
          tone: share > 0.5 ? undefined : 'warn',
          half: true,
        };
      })
    )}
    <p class="muted">
      Their share of the words, from the transcript; the line is half.${talk.length < theyLed.of ? ` The latest ${talk.length} are shown.` : ''}
    </p>
  </section>`;
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

// The latest calls drawn to scale, newest first, on one scale (the longest
// call is the full width), each linking its page. The strip is a picture;
// the words are there for whoever can't see it.
function stripsCard(strips: Strip[], timeZone: string): Html {
  const drawn = strips.filter((s): s is Strip & { timeline: Timeline } => s.timeline !== null);
  if (!drawn.length) {
    return html`<section class="card">
      <h2>Your last calls, to scale</h2>
      <p class="muted">
        Each call is drawn here once it’s read: the phone menu, the front desk, a hold and them; who spoke when; where the
        objection and the next step came. Nothing drawn yet.
      </p>
    </section>`;
  }
  const scale = Math.max(...drawn.map((s) => s.timeline.totalSec));
  return html`<section class="card">
    <h2>Your last ${drawn.length === 1 ? 'call' : `${drawn.length} calls`}, to scale</h2>
    <p class="muted">
      Light grey is the phone menu, darker grey the front desk, the dashed stretch a hold, the tinted one them. Your turns tick
      above the middle, theirs below (taller: a story of a minute or more). Dots: your opening, their objection (amber), a next
      step or a question about the last time (teal), a pitch (amber).
    </p>
    <dl class="strips">
      ${drawn.map(
        ({ call, timeline }) =>
          html`<dt><a href="/calls/${call.call_task_id}" title="${formatLocal(call.at_sec * 1000, timeZone)}">${call.label}</a></dt>
            <dd>
              ${timelineStrip(timeline, { scaleSec: scale, text: false })}<span class="sr-only">${timelineText(timeline, outcomeLabel(call.outcome))}</span>
            </dd>
            <dd class="n">${clock(Math.round(timeline.totalSec))}</dd>`
      )}
    </dl>
  </section>`;
}

// What the rules and the reviews have said, or not yet.
const said = (value: number | null): string => (value === null ? '–' : value ? 'yes' : 'no');

// The Mom Test on every call and interview that reached them, newest first:
// counts, then the table. A dash is nothing said yet, not a no.
function momTestCard(m: MomTestReport, timeZone: string): Html {
  const n = m.rows.length;
  if (!n) {
    return html`<section class="card">
      <h2>The Mom Test, call by call</h2>
      <p class="muted">
        Once a call reaches them it shows here: whether you asked about a specific last time, whether you pitched, whether they
        told a story of a minute or more, whether you caught the fluff, and what they gave up at the end.
      </p>
    </section>`;
  }
  const interviews = m.rows.filter((r) => r.kind === 'interview').length;
  const c = m.commitments;
  return html`<section class="card">
    <h2>The Mom Test, call by call</h2>
    <p>
      On the ${n} call${n === 1 ? '' : 's'} that reached them${interviews ? ` (${interviews} of them interview${interviews === 1 ? '' : 's'})` : ''}:
      you asked about the last time on ${m.asked}, pitched on ${m.pitched}, they told a story of a minute or more on
      ${m.stories}, you caught the fluff on ${m.fluffCaught}. They gave their time on ${c.time}, an intro on ${c.intro}, money on
      ${c.money}.
      ${m.longest ? html`Longest story: <a href="${insightPath(m.longest.call)}">${m.longest.call.label}</a>, ${clock(m.longest.call.longest_story_sec ?? 0)}.` : ''}
    </p>
    <table class="stacked">
      <thead>
        <tr><th>Call</th><th>Asked about the last time</th><th>Pitched</th><th>Their longest story</th><th>Caught the fluff</th><th>They gave</th></tr>
      </thead>
      <tbody>
        ${m.rows.slice(0, STRIPS).map(
          ({ call, kind }) => html`<tr>
            <td>
              <a href="${insightPath(call)}">${call.label}</a>${kind === 'interview' ? html` <span class="tag">Interview</span>` : ''}
              <span class="muted">· ${formatLocal(call.at_sec * 1000, timeZone)}</span>
            </td>
            <td data-label="Asked about the last time">${said(call.asked_last_time)}</td>
            <td data-label="Pitched">${said(call.pitched)}</td>
            <td data-label="Their longest story">${call.longest_story_sec === null ? '–' : clock(call.longest_story_sec)}</td>
            <td data-label="Caught the fluff">${said(call.fluff_caught)}</td>
            <td data-label="They gave">${call.commitment ? COMMITMENT_LABELS[call.commitment] : '–'}</td>
          </tr>`
        )}
      </tbody>
    </table>
    <p class="muted">
      A dash is nothing said yet, not a no: the rules hear some of it on a transcript; a review (ask Claude to review your
      calls) settles the rest.
    </p>
  </section>`;
}

// The real conversations so far, toward 100: who, when, what was learned,
// and the pace (how many calls it takes to reach one). Under them, the calls
// coaching read as reaching the person, not counted yet: count one with a
// line, or leave it. The rep decides; nothing here counts on its own.
function conversationsCard(report: ConversationReport, candidates: ConversationCandidate[], timeZone: string): Html {
  const link = (kind: string, refId: string) => (kind === 'interview' ? `/meetings/${refId}` : `/calls/${refId}`);
  const pace =
    report.people && report.callsPerConversation !== null
      ? html`About 1 in ${report.callsPerConversation} call${report.callsPerConversation === 1 ? '' : 's'} you’ve logged got you one.
          ${report.toGo ? html`At that rate, the other ${report.toGo} take about ${(report.callsToGo ?? 0).toLocaleString('en-US')} more calls. Keep dialling.` : 'You made it.'}`
      : html`Count a call or interview when they talked about their work and you learned something: the box on the log form, or Count below.`;
  return html`<section class="card" id="conversations">
    <h2>Real conversations: ${report.people} / ${report.goal}</h2>
    <p class="muted">People who told you about their work, counted once each. ${pace}</p>
    ${
      report.entries.length
        ? html`<ul class="coach">
            ${report.entries.map(
              (e) => html`<li class="bright">
                <a href="${link(e.kind, e.refId)}">${e.who}</a>
                <span class="muted">· ${e.kind === 'interview' ? 'interview' : 'call'} · ${formatLocal(Date.parse(e.at), timeZone)}</span>
                ${e.line ? html`<br />${e.own ? html`“${e.line}”` : html`<span class="muted">From your notes: ${e.line}</span>`}` : ''}
                <form class="inline" method="post" action="/coaching/conversations">
                  <input type="hidden" name="kind" value="${e.kind}" />
                  <input type="hidden" name="ref" value="${e.refId}" />
                  <input type="hidden" name="on" value="0" />
                  <button type="submit" class="quiet">Uncount</button>
                </form>
              </li>`
            )}
          </ul>`
        : ''
    }
    ${
      candidates.length
        ? html`<h3>Reached them, not counted yet</h3>
            <p class="muted">Calls where coaching heard the person, newest first. Count the ones where you learned something.</p>
            <ul class="coach">
              ${candidates.map(
                (k) => html`<li>
                  <a href="${link(k.kind, k.ref_id)}">${k.who}</a>
                  <span class="muted">· ${formatLocal(k.at_sec * 1000, timeZone)}${k.duration_sec ? html` · ${clock(k.duration_sec)}` : ''}</span>
                  <form class="row" method="post" action="/coaching/conversations">
                    <input type="hidden" name="kind" value="${k.kind}" />
                    <input type="hidden" name="ref" value="${k.ref_id}" />
                    <input type="text" name="learned" maxlength="${MAX_LEARNED}" value="${firstLine(k.notes, MAX_LEARNED) ?? ''}"
                      aria-label="What you learned from ${k.who}" placeholder="What you learned" />
                    <button type="submit">Count</button>
                  </form>
                </li>`
              )}
            </ul>`
        : ''
    }
  </section>`;
}

export function coachingPage(
  { settings, conversations, candidates, report, bookings, funnel, momTest, talk, strips, unread }: CoachingOverview,
  actor: string
): Html {
  const tz = settings.timeZone;
  const counted = conversationsCard(conversations, candidates, tz);
  const { gatekeeper, fastNoNextStep } = report;
  const best = bestHour(report.byHour);
  const reading = unread
    ? html`<p class="muted">Some logged calls haven’t been read for coaching yet. They’re being read in the background: refresh in a minute to include them.</p>`
    : '';

  if (!report.calls) {
    // No cold call read yet: what there is (interviews booked straight in
    // HubSpot and recorded from here, say) still shows.
    return layout(
      'Coaching',
      actor,
      html`<h1>Coaching</h1>
        ${coachingTabs('patterns')}
        ${reading}
        ${counted}
        <p class="muted">No calls read yet. Each call you log is read here: who answered, how far it got, the objection, and whether a next step was agreed.</p>
        ${bookings.booked ? bookingsCard(bookings, tz) : ''}
        ${momTest.rows.length ? momTestCard(momTest, tz) : ''}
        ${talk.talk.length ? talkCard(talk, tz) : ''}`,
      'coaching'
    );
  }

  return layout(
    'Coaching',
    actor,
    html`
      <div class="tight">
        <h1>Coaching</h1>
        ${coachingTabs('patterns')}
        <p class="muted">
          From ${report.calls} logged call${report.calls === 1 ? '' : 's'}: someone picked up ${pct(report.answered / report.calls)},
          you reached the person ${pct(report.reached / report.calls)}${best ? html`, most often at ${hourLabel(best.hour)} their time` : ''}.
          The same notes show on each call page, before and after the call.
        </p>
      </div>
      ${reading}
      ${counted}

      <section class="half">
        <h2>Earning the conversation</h2>
        <p class="muted">Getting past the menu and the front desk to the person, and leaving with a next step.</p>

        ${funnelCard(funnel)}

        ${bookingsCard(bookings, tz)}

        <section class="card">
          <h2>The front desk</h2>
          ${
            gatekeeper.calls
              ? html`<p>
                    A front desk answered ${gatekeeper.calls} call${gatekeeper.calls === 1 ? '' : 's'} and put you through on
                    ${gatekeeper.putThrough} (${pct(gatekeeper.putThrough / gatekeeper.calls)}).
                  </p>
                  ${
                    gatekeeper.results.length
                      ? bars(
                          'What the front desk did',
                          gatekeeper.results.map((r) => ({
                            label: r.label,
                            value: r.count,
                            of: gatekeeper.calls,
                            tone: r.result === 'put_through' ? undefined : 'quiet',
                          }))
                        )
                      : ''
                  }
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

        ${stripsCard(strips, tz)}
      </section>

      <section class="half">
        <h2>The conversation</h2>
        <p class="muted">
          Once you reach them, the Mom Test: did they talk about their work and what they did the last time, or did you pitch?
          Did you leave with a commitment?
        </p>

        ${momTestCard(momTest, tz)}

        ${talkCard(talk, tz)}

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
          <h2>What to adjust, call by call</h2>
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
      </section>

      <details class="card">
        <summary>When there are enough calls: by hour of their day, and follow-up timing</summary>
        <p class="muted">
          A rate needs about ${HOUR_SAMPLE} calls in each group before a difference between groups means anything. These wait
          here until then.
        </p>
        <section>
          <h3>Reached, by hour of their day</h3>
          <table class="stacked">
            <thead><tr><th>Hour</th><th>Calls</th><th>Reached</th><th>Rate</th></tr></thead>
            <tbody>${report.byHour.map((h) => html`<tr><td>${hourLabel(h.hour)}</td>${rateCells(h)}</tr>`)}</tbody>
          </table>
          ${
            report.byHour.filter((h) => h.calls >= HOUR_SAMPLE).length < 2
              ? html`<p class="muted">Too few calls to pick an hour by yet: it takes about ${HOUR_SAMPLE} calls in each of two hours or more before one beats another. Until then, spread your calls across the day.</p>`
              : ''
          }
        </section>
        <section>
          <h3>Which follow-up timing led to another connect</h3>
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
      </details>
    `,
    'coaching'
  );
}

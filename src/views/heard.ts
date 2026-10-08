// What you've heard: the software they use and what they said about their
// work, in their words, by theme, across every call and interview that
// reached them (lib/heard.ts). Counts of calls and the newest quotes, each
// linking its call; the synthesis is the rep's, with Claude.

import { html } from 'hono/html';
import type { HeardOverview } from '../actions/coaching';
import { formatLocal } from '../lib/dates';
import type { HeardCall, Said, ThemeRow, ToolRow } from '../lib/heard';
import { bars } from './coaching';
import { coachingTabs, layout, type Html } from './layout';

const pagePath = (q: Pick<Said, 'id' | 'kind'>) => (q.kind === 'interview' ? `/meetings/${q.id}` : `/calls/${q.id}`);

function quoteList(quotes: Said[], timeZone: string): Html {
  return html`<ul class="coach">
    ${quotes.map(
      (q) => html`<li class="${q.pain ? 'flag' : ''}">
        “${q.text}”
        <span class="muted">
          · <a href="${pagePath(q)}">${q.label}</a>${q.kind === 'interview' ? ' (interview)' : ''} ·
          ${formatLocal(q.atSec * 1000, timeZone)}${q.from === 'notes' ? ' · your notes' : ''}
        </span>
      </li>`
    )}
  </ul>`;
}

function toolsCard(tools: ToolRow[], of: number, timeZone: string): Html {
  if (!tools.length) {
    return html`<section class="card">
      <h2>The software they use</h2>
      <p class="muted">
        Nobody has named a tool yet. When they do (McLeod, a TMS, QuickBooks, spreadsheets, paper, their phone), it shows here
        with how many calls named it and what they said.
      </p>
    </section>`;
  }
  return html`<section class="card">
    <h2>The software they use</h2>
    <p class="muted">How many of the ${of} calls and interviews that reached them named each.</p>
    ${bars(
      'The software they use',
      tools.map((t) => ({ label: t.name, value: t.calls, of }))
    )}
    ${tools.map(
      (t) => html`<div class="tight">
        <h3>${t.name} <span class="muted">· ${t.calls} call${t.calls === 1 ? '' : 's'}</span></h3>
        ${quoteList(t.quotes, timeZone)}
      </div>`
    )}
  </section>`;
}

function themesCard(themes: ThemeRow[], timeZone: string): Html {
  if (!themes.length) {
    return html`<section class="card">
      <h2>What they said about their work</h2>
      <p class="muted">
        Once they talk about quoting, dispatch, invoicing, their drivers or their software, their words land here by theme,
        the ones that hurt first.
      </p>
    </section>`;
  }
  return html`<section class="card">
    <h2>What they said about their work</h2>
    <p class="muted">By theme, most touched first. A flagged line is something that hurts, by their words; counts are calls.</p>
    ${themes.map(
      (t) => html`<div class="tight">
        <h3>
          ${t.label}
          <span class="muted">· ${t.calls} call${t.calls === 1 ? '' : 's'}${t.pains ? `, ${t.pains} with something that hurts` : ''}</span>
        </h3>
        ${quoteList(t.quotes, timeZone)}
      </div>`
    )}
  </section>`;
}

function callsCard(calls: HeardCall[], timeZone: string): Html | '' {
  if (!calls.length) return '';
  return html`<section class="card">
    <h2>Call by call</h2>
    <ol class="calls">
      ${calls.map(
        (c) => html`<li class="tight">
          <div>
            <a href="${pagePath(c)}">${c.label}</a>${c.kind === 'interview' ? html` <span class="tag">Interview</span>` : ''}
            <span class="muted">· ${formatLocal(c.atSec * 1000, timeZone)}${c.tools.length ? ` · ${c.tools.join(', ')}` : ''}</span>
          </div>
          ${c.said.length ? quoteList(c.said, timeZone) : ''}
        </li>`
      )}
    </ol>
  </section>`;
}

export function heardPage({ settings, report }: HeardOverview, actor: string): Html {
  const tz = settings.timeZone;
  return layout(
    'What you’ve heard',
    actor,
    html`
      <div class="tight">
        <h1>Coaching</h1>
        ${coachingTabs('heard')}
        <p class="muted">
          ${
            report.of
              ? html`What they’ve told you, from their part of each recording and your notes: heard something on
                ${report.heardFrom} of the ${report.of} call${report.of === 1 ? '' : 's'} and interviews that reached them.
                The point of the calls is here, not in the counts: read the quotes, and ask Claude for the synthesis
                (<code>what_you_heard</code> hands it the same).`
              : html`Nothing heard yet. Once a call or an interview reaches them, their words about their work and the
                software they use land here.`
          }
        </p>
      </div>
      ${toolsCard(report.tools, report.of, tz)}
      ${themesCard(report.themes, tz)}
      ${callsCard(report.calls, tz)}
    `,
    'coaching'
  );
}

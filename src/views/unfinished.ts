// The notice at the top of every page about HubSpot writes that run after the
// page answered: what's still saving, and what stopped short, with a way to
// finish it. Fetched by the page (UNFINISHED_SCRIPT in layout.ts), so no page
// waits for it.

import { html, raw } from 'hono/html';
import type { UnfinishedWrite } from '../lib/db';
import { flash, type Html } from './layout';

export function unfinishedNotice(items: UnfinishedWrite[]): Html {
  if (items.length === 0) return html`<div id="unfinished"></div>`;
  const saving = items.filter((i) => i.saving);
  const stopped = items.filter((i) => !i.saving);
  return html`<div id="unfinished" ${saving.length ? raw('data-saving') : ''}>
    ${saving.length ? html`<p class="muted saving">Saving to HubSpot: ${saving.map((i) => i.label).join(', ')}…</p>` : ''}
    ${stopped.map((i) =>
      flash(
        'warn',
        html`<strong>${i.label}</strong> didn't finish in HubSpot${i.error ? html`: ${i.error}` : '.'} ${finishIt(i)}`
      )
    )}
  </div>`;
}

// Each part that landed is recorded, so finishing only does what's left. A
// call's form keeps what the rep entered the first time; an email's follow-up
// needs nothing more.
function finishIt(item: UnfinishedWrite): Html {
  const id = encodeURIComponent(item.taskId);
  if (item.kind === 'call') return html`<a href="/calls/${id}">Open the call to finish it</a>.`;
  const action = item.sentByApp ? `/tasks/${id}/send` : `/tasks/${id}/sent`;
  return html`<form method="post" action="${action}" class="inline"><button type="submit">Finish it</button></form>`;
}

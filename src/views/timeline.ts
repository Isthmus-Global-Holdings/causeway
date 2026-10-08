// A call's timeline as a strip (lib/call-timeline.ts), server-rendered CSS:
// the phases underneath, your turns ticking above the middle and theirs
// below, the moments as dots on top. Every position is a custom property
// (styles.ts, `.strip`), so it works in light and dark mode and on a phone.
// The strip is only a picture: the text alternative after it says the same.

import { html } from 'hono/html';
import { timelineText, type Timeline } from '../lib/call-timeline';
import type { Html } from './layout';

const share = (sec: number, of: number) => (of > 0 ? Math.min(100, Math.max(0, (sec / of) * 100)) : 0);
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;

export interface StripOptions {
  scaleSec?: number; // the row's full width, when strips share a scale; the call's own length otherwise
  outcome?: string | null; // names a call drawn without a transcript, in the text
  text?: boolean; // the text alternative after the strip (default: yes)
}

export function timelineStrip(t: Timeline, opts: StripOptions = {}): Html {
  const scale = Math.max(opts.scaleSec ?? t.totalSec, t.totalSec);
  const total = t.totalSec;
  return html`<div class="strip" aria-hidden="true" style="--w: ${pct(share(total, scale))}">
      ${t.phases.map(
        (p) =>
          html`<span class="phase ${p.kind}" style="--l: ${pct(share(p.from, total))}; --w: ${pct(share(p.to - p.from, total))}"></span>`
      )}
      ${t.turns.map(
        (k) =>
          html`<span class="tick ${k.who}${k.story ? ' story' : ''}" style="--l: ${pct(share(k.from, total))}; --w: ${pct(share(k.to - k.from, total))}"></span>`
      )}
      ${t.marks.map((m) => html`<span class="mark ${m.kind}" style="--l: ${pct(share(m.at, total))}"></span>`)}
    </div>
    ${opts.text === false ? '' : html`<p class="strip-text muted">${timelineText(t, opts.outcome ?? null)}</p>`}`;
}

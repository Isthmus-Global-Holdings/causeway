// The parts of a long page, told apart at a glance: each card's heading has
// an icon, a card that's background can be folded away (and stays folded on
// every page until it's opened again), and the call page has a bar of links
// to its cards that stays at the top while the page scrolls.

import { html, raw } from 'hono/html';
import type { Html } from './layout';

// Line icons drawn in the text's colour (24×24, 2px strokes, after Lucide).
const ICONS = {
  script:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M7 8h10"/><path d="M7 12h6"/>',
  phone:
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  history: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  coaching:
    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  recording:
    '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  log: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): Html {
  return html`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${raw(ICONS[name])}</svg>`;
}

// A card's heading: its icon and title, and on the right whatever the card
// wants beside it (a count, a link).
export function cardHead(name: IconName, title: string, aside: Html | string = ''): Html {
  return html`<div class="card-head"><h2>${icon(name)}${title}</h2>${aside}</div>`;
}

// A card that folds: open unless the rep folded it, remembered by `id` in
// this browser (FOLD_SCRIPT, in every page's layout).
export function foldCard(id: string, name: IconName, title: string, body: Html, aside: Html | string = ''): Html {
  return html`<details class="card fold" id="${id}" data-fold open>
    <summary class="card-head"><h2>${icon(name)}${title}</h2>${aside}</summary>
    ${body}
  </details>`;
}

// Folded cards stay folded. Storage can be missing (a private window): the
// cards then just start open.
export const FOLD_SCRIPT = `(() => {
  const key = (el) => 'fold:' + el.id;
  for (const el of document.querySelectorAll('details[data-fold][id]')) {
    try { if (localStorage.getItem(key(el)) === 'closed') el.open = false; } catch {}
    el.addEventListener('toggle', () => {
      try { el.open ? localStorage.removeItem(key(el)) : localStorage.setItem(key(el), 'closed'); } catch {}
    });
  }
})();`;

// A form marked data-submit-once goes once: its button greys out and says
// what's happening (data-busy) as it's sent, so a second click can't post it
// again while the first is saving. Back to the page from the browser's Back
// button, it's ready again. Disabled a tick after the submit, so the button
// is still in what the form sends.
export const SUBMIT_ONCE_SCRIPT = `(() => {
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.matches('form[data-submit-once]') || e.defaultPrevented) return;
    if (form.dataset.sent) { e.preventDefault(); return; }
    form.dataset.sent = '1';
    setTimeout(() => {
      for (const b of form.querySelectorAll('button[type=submit]')) {
        b.disabled = true;
        if (b.dataset.busy) { b.dataset.idle = b.textContent; b.textContent = b.dataset.busy; }
      }
    });
  });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    for (const form of document.querySelectorAll('form[data-submit-once][data-sent]')) {
      delete form.dataset.sent;
      for (const b of form.querySelectorAll('button[type=submit]')) {
        b.disabled = false;
        if (b.dataset.idle) b.textContent = b.dataset.idle;
      }
    }
  });
})();`;

export interface JumpLink {
  id: string;
  icon: IconName;
  label: string;
}

// The call page's bar of its cards. Following a link opens a folded card;
// the link to the card in view is marked as you scroll.
export function jumpBar(links: JumpLink[]): Html {
  return html`<nav class="jump" aria-label="On this page">
      ${links.map((l) => html`<a href="#${l.id}">${icon(l.icon)}<span>${l.label}</span></a>`)}
    </nav>
    <script>${raw(JUMP_SCRIPT)}</script>`;
}

const JUMP_SCRIPT = `(() => {
  const bar = document.currentScript.previousElementSibling;
  const links = [...bar.querySelectorAll('a')];
  const target = (a) => document.getElementById(a.hash.slice(1));
  for (const a of links) {
    // Scrolled to without the #card in the address: the reload when a call
    // ends starts at the top again.
    a.addEventListener('click', (e) => {
      const el = target(a);
      if (!el) return;
      e.preventDefault();
      if (el.tagName === 'DETAILS') el.open = true;
      el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  }
  if (!('IntersectionObserver' in window)) return;
  const shown = new Set();
  const mark = () => {
    const first = links.find((a) => shown.has(target(a)));
    for (const a of links) a.toggleAttribute('aria-current', a === first);
  };
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? shown.add(e.target) : shown.delete(e.target);
    mark();
  }, { rootMargin: '-15% 0px -55% 0px' });
  // The cards come after the bar: watch them once they're all there.
  addEventListener('DOMContentLoaded', () => {
    for (const a of links) {
      const el = target(a);
      if (el) seen.observe(el);
    }
  });
})();`;

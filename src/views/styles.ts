// The app's one stylesheet, inlined into every page by layout(). The design
// system artifact documents these tokens and classes: change both together.
// Every colour, space and radius is a token here: views use the classes and
// never hard-code a colour. Dark mode follows the OS. Below 720px wide the page becomes one
// column, tables turn into stacked rows, and the call dock becomes a bottom sheet.
export const STYLES = `
:root {
  --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #fff; --paper: #fff;
  --accent: #0f766e; --accent-fg: #fff; --warn-bg: #fef3c7; --warn-fg: #78350f;
  --ok-bg: #dcfce7; --ok-fg: #14532d; --err-bg: #fee2e2; --err-fg: #7f1d1d;
  --sans: system-ui, sans-serif; --mono: ui-monospace, monospace;
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem; --space-5: 1.25rem; --space-6: 1.5rem;
  --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px;
  --content-max: 60rem; --preview-height: 24rem;
  --shadow: 0 8px 24px rgb(0 0 0 / 0.18);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --card: #292524;
    --accent: #2dd4bf; --accent-fg: #042f2e; --warn-bg: #451a03; --warn-fg: #fde68a;
    --ok-bg: #052e16; --ok-fg: #bbf7d0; --err-bg: #450a0a; --err-fg: #fecaca;
  }
}
* { box-sizing: border-box; }
/* Going from page to page crossfades instead of flashing blank (Chrome, Safari;
   others load as before). The header stays put, so only the page under it changes. */
@view-transition { navigation: auto; }
.site { view-transition-name: site; }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 120ms; }
@media (prefers-reduced-motion: reduce) { @view-transition { navigation: none; } }
[hidden] { display: none !important; } /* over .card's display: flex, for the browser call panel */
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); }
h1, h2, h3, p { margin: 0; }
h1 { font-size: 1.35rem; }
h2 { font-size: 1.05rem; }
h3 { font-size: 0.95rem; }
a { color: var(--accent); }
code { font-family: var(--mono); font-size: 0.9em; }
pre { white-space: pre-wrap; margin: 0; font: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.muted { color: var(--muted); font-size: 0.9em; }

/* Header */
.site { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: var(--space-2) var(--space-4);
        padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--line); }
.site nav { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--space-2) var(--space-5); }
.site nav a { color: var(--muted); text-decoration: none; }
.site nav a.app { color: var(--fg); font-weight: 600; }
.site nav a[aria-current] { color: var(--fg); font-weight: 600; text-decoration: underline; text-underline-offset: 6px; }
.site .actor { overflow-wrap: anywhere; }

/* Page structure */
main { max-width: var(--content-max); margin: 0 auto; padding: var(--space-6) var(--space-4); display: flex; flex-direction: column; gap: var(--space-4); }
section { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-4); }
.stack { display: flex; flex-direction: column; gap: var(--space-4); }
.tight { display: flex; flex-direction: column; gap: var(--space-1); }
.row { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); align-items: start; }
.phone-edit { display: grid; grid-template-columns: minmax(0, 1fr) 6rem; gap: var(--space-2); align-items: end; }
.with-aside { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; gap: var(--space-4); align-items: start; }
.with-aside > :last-child { position: sticky; top: var(--space-4); }
.setting { display: grid; grid-template-columns: 17.5rem minmax(0, 1fr); gap: var(--space-6); padding-top: var(--space-6); border-top: 1px solid var(--line); }
.steps strong { color: var(--fg); }
.bar { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--line); }

/* Surfaces */
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.card.split { flex-direction: row; justify-content: space-between; align-items: center; gap: var(--space-6); }
/* Where they are, under a call's heading: the city at a glance, and a map */
.where { display: flex; align-items: center; gap: var(--space-4); }
.where iframe { width: 16rem; height: 8rem; border: 1px solid var(--line); border-radius: var(--radius-lg); flex: none; }
.where .place { font-size: 1.5rem; line-height: 1.2; font-weight: 600; color: var(--fg); }
.next-up { padding: var(--space-6); }
.next-up .next-company { font-size: 1.35rem; font-weight: 700; line-height: 1.25; margin-top: var(--space-1); }
.row > p.muted { max-width: 36rem; }
dl.today { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin: 0; }
dl.today .stat { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: var(--space-3) var(--space-4); }
dl.today dt { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
dl.today dd { margin: 0; }
dl.today dd:not(.muted) { font-size: 1.75rem; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.divided { padding-top: var(--space-4); border-top: 1px solid var(--line); }
.flash { border-radius: var(--radius-lg); padding: var(--space-3) var(--space-4); }
.flash.ok { background: var(--ok-bg); color: var(--ok-fg); }
.flash.err { background: var(--err-bg); color: var(--err-fg); }
.flash.warn { background: var(--warn-bg); color: var(--warn-fg); }
.flash a { color: inherit; text-decoration: underline; font-weight: 600; }
form.inline { display: inline; }
#unfinished { display: grid; gap: var(--space-2); }
#unfinished:empty { display: none; }
#unfinished .saving { margin: 0; }
.fit { font-size: 0.75rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: var(--radius-sm); border: 1px solid var(--line); white-space: nowrap; }
.fit.clicked { border-color: var(--accent); color: var(--accent); }
.fit.opened { color: var(--accent); }
.tag { font-size: 0.75rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: var(--radius-sm); border: 1px solid var(--line); white-space: nowrap; }
.tag.in { border-color: var(--accent); color: var(--accent); }
nav.tabs { display: flex; gap: var(--space-6); border-bottom: 1px solid var(--line); }
nav.tabs a { padding: var(--space-2) 0; color: var(--muted); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
nav.tabs a[aria-current] { color: var(--fg); font-weight: 600; border-bottom-color: var(--fg); }
mark { background: var(--line); color: var(--fg); font-weight: 600; padding: 0 0.1em; border-radius: var(--radius-sm); }
.matches { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: var(--space-1) var(--space-3); padding: var(--space-2) var(--space-3);
           background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-md); }
.waiting { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; padding-top: var(--space-3); border-top: 1px solid var(--line); }
ol.calls { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
a.interview { font-size: 0.75rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: var(--radius-sm); border: 1px solid var(--accent); color: var(--accent); text-decoration: none; white-space: nowrap; }
.scroll { max-height: 12rem; overflow: auto; }
.pre { white-space: pre-wrap; }
details > summary { cursor: pointer; }
audio.recording { width: 100%; }
ul.summary { margin: 0; padding-left: var(--space-5); }
.transcript { max-height: 24rem; overflow: auto; display: flex; flex-direction: column; gap: var(--space-2); }
.transcript .turn strong { display: block; font-size: 0.8rem; color: var(--muted); }
.transcript .turn.prospect { padding-left: var(--space-4); border-left: 2px solid var(--accent); }
pre.script { max-height: 28rem; overflow: auto; font-size: 1rem; line-height: 1.6; }
ol.history { list-style: none; margin: 0; padding: 0; max-height: 32rem; overflow: auto; display: flex; flex-direction: column; gap: var(--space-3); }
ol.history li { padding-left: var(--space-3); border-left: 2px solid var(--line); display: flex; flex-direction: column; gap: var(--space-1); }
ol.history li.call { border-left-color: var(--accent); }
details.clipped > summary { list-style: none; display: flex; flex-direction: column; gap: var(--space-1); }
details.clipped > summary::-webkit-details-marker { display: none; }
details.clipped > summary span { color: var(--accent); }
details.clipped > summary .less, details.clipped[open] > summary pre, details.clipped[open] > summary .more { display: none; }
details.clipped[open] > summary .less { display: inline; }
ul.records { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
ul.records li.row { align-items: center; flex-wrap: nowrap; }
/* Coaching: quiet notes, a flag's border warns, a bright spot's is the accent */
ul.coach { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
ul.coach li { padding-left: var(--space-3); border-left: 2px solid var(--line); }
ul.coach li.flag { border-left-color: var(--warn-fg); }
ul.coach li.bright { border-left-color: var(--accent); }
/* Coaching's charts: a bar as wide as its share (--w, set by the view), its count beside it */
dl.bars { display: grid; grid-template-columns: minmax(7rem, 15rem) minmax(0, 1fr) 3.5rem; gap: var(--space-2) var(--space-3); align-items: center; margin: 0; }
dl.bars dt { overflow-wrap: anywhere; }
dl.bars dd { margin: 0; }
dl.bars .track { position: relative; height: 0.8rem; background: var(--line); border-radius: var(--radius-sm); }
dl.bars .fill { display: block; width: var(--w); height: 100%; background: var(--accent); border-radius: var(--radius-sm); }
dl.bars .fill.quiet { background: var(--muted); }
dl.bars .fill.warn { background: var(--warn-fg); }
dl.bars .half { position: absolute; left: 50%; top: -3px; bottom: -3px; border-left: 2px solid var(--fg); }
dl.bars .n { text-align: right; font-variant-numeric: tabular-nums; }
/* Coaching's timelines: one call to scale (--w: its share of the row's scale). The phases run
   underneath, your turns tick above the middle, theirs below (taller for a story), the moments are
   dots on top. Every position is a custom property set by the view; the text alternative follows. */
dl.strips { display: grid; grid-template-columns: minmax(7rem, 15rem) minmax(0, 1fr) 3.5rem; gap: var(--space-2) var(--space-3); align-items: center; margin: 0; }
dl.strips dt { overflow-wrap: anywhere; }
dl.strips dd { margin: 0; }
dl.strips .n { text-align: right; font-variant-numeric: tabular-nums; }
.strip { position: relative; height: 1.5rem; width: var(--w, 100%); border-radius: var(--radius-sm); background: var(--line); }
.strip .phase { position: absolute; top: 0.6rem; bottom: 0; left: var(--l); width: var(--w); }
.strip .phase.menu { background: var(--line); }
.strip .phase.desk { background: var(--muted); opacity: 0.45; }
.strip .phase.hold { background: var(--warn-bg); border-top: 1px dashed var(--warn-fg); }
.strip .phase.them, .strip .phase.call { background: var(--accent); opacity: 0.3; }
.strip .phase.voicemail { background: var(--muted); opacity: 0.25; }
.strip .tick { position: absolute; left: var(--l); width: max(var(--w), 2px); }
.strip .tick.rep { top: 0.6rem; height: 0.4rem; background: var(--fg); }
.strip .tick.prospect { bottom: 0; height: 0.5rem; background: var(--accent); }
.strip .tick.prospect.story { height: 0.9rem; }
.strip .mark { position: absolute; top: 0; left: var(--l); width: 0.5rem; height: 0.5rem; margin-left: -0.25rem; border-radius: 50%; background: var(--fg); }
.strip .mark.objection { background: var(--warn-fg); }
.strip .mark.next_step, .strip .mark.last_time { background: var(--accent); }
.strip .mark.pitch { background: var(--warn-fg); }
.strip-text { margin: 0; font-size: 0.9em; }
ol.consequences { margin: 0; padding-left: var(--space-5); display: flex; flex-direction: column; gap: var(--space-1); }

/* Tables */
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: var(--space-2); border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
td.fit-cell { width: 6rem; }
td.row-actions { width: 1%; }
.nowrap { white-space: nowrap; }
td.row-actions .actions { justify-content: flex-end; flex-wrap: nowrap; }
tr.drop td { opacity: 0.5; }

/* Controls */
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.actions form { margin: 0; }
form.search { display: flex; gap: var(--space-2); align-items: center; }
form.move { display: flex; align-items: center; gap: var(--space-1); }
form.move input[type=date] { width: auto; padding: 0.3rem var(--space-2); }
form.move input[data-time] { width: 6rem; padding: 0.3rem var(--space-2); }
button, .button { font: inherit; cursor: pointer; padding: 0.35rem var(--space-3); border-radius: var(--radius-md); white-space: nowrap;
                  border: 1px solid var(--line); background: var(--card); color: var(--fg); text-decoration: none; display: inline-block; }
button.primary, .button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
button.quiet { border-color: transparent; background: none; color: var(--muted); }
button.quiet:hover { color: var(--fg); text-decoration: underline; }
button.wide { width: 100%; padding: 0.6rem var(--space-3); }
.keypad { display: grid; grid-template-columns: repeat(3, 4rem); gap: var(--space-2); }
.keypad button { padding: var(--space-3) 0; font-size: 1.2rem; font-family: var(--mono); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
form { margin: 0; }
label { display: block; font-weight: 600; }
.field { display: flex; flex-direction: column; gap: var(--space-1); }
label.check { display: flex; gap: var(--space-2); align-items: center; }
label.check.plain { font-weight: 400; }
.check-help { padding-left: 1.6rem; }
input[type=text], input[type=search], input[type=date], input[type=time], input[type=url], textarea, select { width: 100%; font: inherit; padding: var(--space-2); border-radius: var(--radius-md);
                                     border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
textarea { min-height: 18rem; resize: vertical; }
textarea.mono { min-height: 7rem; font-family: var(--mono); font-size: 0.85rem; }
textarea.context { min-height: 10rem; font-family: var(--mono); font-size: 0.85rem; }

/* Call dock: a browser call's controls, over the page so they never scroll away */
.call-dock { position: fixed; right: var(--space-4); bottom: var(--space-4); z-index: 10; width: 20rem;
             max-height: calc(100vh - 2 * var(--space-4)); overflow: auto; box-shadow: var(--shadow); }
.call-dock .call-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-2); }
.call-dock .call-head:has(> [data-label]:empty) { display: none; } /* no call yet: starting, or an error */
.call-dock [data-timer] { font-variant-numeric: tabular-nums; }
.call-dock .keypad { grid-template-columns: repeat(3, minmax(0, 1fr)); }
body.in-call { padding-bottom: var(--dock-height, 18rem); } /* the dock's height, kept current by the call script */

/* Email preview: paper stays white in both themes, as a mail app shows it */
iframe.email-preview { width: 100%; min-height: var(--preview-height); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--paper); }
iframe.email-preview.signature-preview { min-height: 7rem; height: 7rem; }
dl.headers { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-4); margin: 0; }
dl.headers dt { color: var(--muted); }
dl.headers dd { margin: 0; overflow-wrap: anywhere; }

/* Phones */
@media (max-width: 720px) {
  main { padding: var(--space-4); }
  .grid-2, .with-aside, .setting { grid-template-columns: minmax(0, 1fr); }
  .with-aside > :last-child { position: static; }
  .with-aside > .first-on-phone { order: -1; } /* a contact's Call and Email, above their history */
  .next-up { padding: var(--space-4); }
  .setting { gap: var(--space-3); }
  .card.split { flex-direction: column; align-items: stretch; gap: var(--space-3); }
  .where { flex-direction: column; align-items: stretch; }
  .where iframe { width: 100%; height: 10rem; }
  .bar { justify-content: stretch; }
  .bar .button, .bar button { width: 100%; text-align: center; }
  button, .button { padding: 0.6rem 0.9rem; }
  input[type=text], input[type=search], input[type=date], input[type=time], input[type=url], textarea, select { font-size: 16px; }
  .matches { grid-template-columns: minmax(0, 1fr); }
  dl.bars { grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 3rem; }
  dl.strips { grid-template-columns: minmax(0, 1fr) 3rem; }
  dl.strips dt { grid-column: 1 / -1; }
  .waiting { grid-template-columns: minmax(0, 1fr); }
  table.stacked thead { display: none; }
  table.stacked, table.stacked tbody, table.stacked tr, table.stacked td { display: block; }
  table.stacked tr { padding: var(--space-3) 0; border-bottom: 1px solid var(--line); }
  table.stacked td { border: 0; padding: var(--space-1) 0; }
  table.stacked td[data-label]::before { content: attr(data-label) ": "; color: var(--muted); font-size: 0.9em; }
  table.stacked td.row-actions { padding-top: var(--space-2); }
  table.stacked td.row-actions { width: auto; }
  table.stacked td.row-actions .actions { justify-content: flex-start; flex-wrap: wrap; }
  td.fit-cell { width: auto; }
  dl.today { gap: var(--space-2); }
  dl.today .stat { padding: var(--space-2) var(--space-3); }
  dl.today dt { font-size: 0.7rem; }
  .call-dock { left: 0; right: 0; bottom: 0; width: auto; max-height: 75vh; border-width: 1px 0 0;
               border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom)); }
  .call-dock .actions button { flex: 1; }
  .call-dock .actions [data-hangup] { flex-basis: 100%; padding: var(--space-4); font-size: 1.1rem; }
  .call-dock .keypad button { padding: var(--space-4) 0; font-size: 1.5rem; }
}
`;

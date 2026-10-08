import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstNameOf, theirPart } from '../src/lib/call-insight.ts';
import { heardOnCall, heardReport, THEME_LABELS, type HeardSource } from '../src/lib/heard.ts';
import type { Turn } from '../src/lib/transcript.ts';
import { heardPage } from '../src/views/heard.ts';
import { lunchThenBooked, onHold, putThrough, type CallFixture } from './call-fixtures.ts';

const T0 = Date.parse('2026-09-29T16:00:00Z') / 1000;

// A recorded call: their turns once they came on, and the rep's notes.
const recorded = (call: CallFixture, id: string, atSec: number): HeardSource => ({
  id,
  kind: 'call',
  label: call.label,
  atSec,
  turns: theirPart(call.turns, firstNameOf(call.label)).filter((t) => t.speaker === 'prospect'),
  notes: call.notes,
});

const interviewTurns: Turn[] = [
  {
    speaker: 'prospect',
    start: 0,
    text: 'we use mcleod for dispatch and quickbooks for the invoicing and honestly chasing brokers for payment is a nightmare it takes hours every week',
  },
  { speaker: 'rep', start: 20, text: 'walk me through the last load you quoted' },
  { speaker: 'prospect', start: 24, text: 'the last load we quoted i did it on a spreadsheet and got the rate wrong' },
  { speaker: 'prospect', start: 40, text: 'yeah loads' },
];

const interview: HeardSource = {
  id: 'm1',
  kind: 'interview',
  label: 'Grant Ives at Sagebrush Logistics',
  atSec: T0 + 86_400,
  turns: interviewTurns,
  notes: 'He said drivers quit after a month. I will send the summary Friday.',
};

test('one call: the tools they named, and what they said about their work, the pains flagged', () => {
  const heard = heardOnCall(interview);
  assert.deepEqual(
    heard.tools.map((t) => t.name),
    ['McLeod', 'QuickBooks', 'Excel or spreadsheets']
  );
  assert.equal(heard.tools[0].said.from, 'them');
  assert.ok(heard.tools[0].said.pain, '“a nightmare”, “hours every week”');
  assert.deepEqual(heard.themes, ['quoting', 'dispatch', 'invoicing', 'people', 'software']);
  assert.deepEqual(
    heard.said.map((q) => [q.from, q.pain]),
    [
      ['them', true],
      ['them', true],
      ['notes', true],
    ],
    '“yeah loads” isn’t a quote; the rep’s own plan isn’t either'
  );
  assert.match(heard.said[2].text, /drivers quit after a month/);
});

test('the rep’s notes count when they report what they said; a front desk call hears nothing', () => {
  const lyle = heardOnCall(recorded(putThrough, 'lyle', T0));
  assert.deepEqual(lyle.tools, []);
  assert.ok(lyle.themes.includes('people') && lyle.themes.includes('software'));
  assert.ok(lyle.said.some((q) => q.from === 'notes' && /don't stick around/.test(q.text) && q.pain));
  assert.ok(lyle.said.some((q) => q.from === 'them' && /problems do not involve software/.test(q.text)));

  const grant = heardOnCall(recorded(lunchThenBooked, 'grant', T0));
  assert.ok(grant.said.some((q) => q.from === 'notes' && /use some software/.test(q.text) && !q.pain));

  const desk = heardOnCall(recorded(onHold, 'hank', T0));
  assert.deepEqual([desk.tools, desk.said, desk.themes], [[], [], []], 'never reached: nothing of theirs to hear');
});

test('across calls: tools most named first, themes most touched first with Other last, call by call', () => {
  const sources = [interview, recorded(putThrough, 'lyle', T0 + 3600), recorded(lunchThenBooked, 'grant', T0)];
  const r = heardReport(sources);
  assert.deepEqual([r.heardFrom, r.of], [3, 3]);
  assert.deepEqual(
    r.tools.map((t) => [t.name, t.calls]),
    [
      ['Excel or spreadsheets', 1],
      ['McLeod', 1],
      ['QuickBooks', 1],
    ],
    'ties by name'
  );
  const software = r.themes.find((t) => t.theme === 'software')!;
  assert.equal(software.label, THEME_LABELS.software);
  assert.equal(software.calls, 3);
  assert.equal(software.pains, 2, 'Lyle’s and Grant’s interview hurt; Grant’s lunch call didn’t');
  assert.ok(software.quotes[0].pain, 'the pains first within a call');
  assert.equal(r.themes[0].theme, 'software');
  assert.notEqual(r.themes[r.themes.length - 1].theme, 'other', 'nothing fell outside a theme');
  assert.deepEqual(
    r.calls.map((c) => [c.id, c.kind, c.tools.length]),
    [
      ['m1', 'interview', 3],
      ['lyle', 'call', 0],
      ['grant', 'call', 0],
    ]
  );
  assert.deepEqual(heardReport([]), { heardFrom: 0, of: 0, tools: [], themes: [], calls: [] });
});

test('the page: tools as bars with their quotes, the themes, call by call; and before anything is heard', async () => {
  const report = heardReport([interview, recorded(putThrough, 'lyle', T0)]);
  const page = String(
    await heardPage({ settings: { timeZone: 'America/Denver' } as never, report }, 'rep@example.com')
  );
  assert.match(page, /aria-current="page">What you’ve heard</);
  assert.match(page, /heard something on\s+2 of the 2 calls and interviews/);
  assert.match(page, /<dl class="bars" aria-label="The software they use">/);
  assert.match(page, /<h3>McLeod <span class="muted">· 1 call<\/span><\/h3>/);
  assert.match(page, /<li class="flag">\s*“we use mcleod for dispatch/);
  assert.match(page, /<h3>\s*Invoicing and getting paid/);
  assert.match(page, /stick around\.”[\s\S]*?your notes/);
  assert.match(
    page,
    /<a href="\/meetings\/m1">Grant Ives at Sagebrush Logistics<\/a> <span class="tag">Interview<\/span>/
  );
  assert.match(page, /<a href="\/calls\/lyle">Lyle Moss/);

  const empty = String(
    await heardPage({ settings: { timeZone: 'America/Denver' } as never, report: heardReport([]) }, 'rep')
  );
  assert.match(empty, /Nothing heard yet/);
  assert.match(empty, /Nobody has named a tool yet/);
  assert.doesNotMatch(empty, /Call by call/);
});

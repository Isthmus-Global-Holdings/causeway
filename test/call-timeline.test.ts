import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstNameOf, ruleInsight, type CallFacts } from '../src/lib/call-insight.ts';
import { callTimeline, parseTimeline, STORY_SEC, timelineJson, timelineText } from '../src/lib/call-timeline.ts';
import type { Turn } from '../src/lib/transcript.ts';
import { timelineStrip } from '../src/views/timeline.ts';
import { lunchThenBooked, onHold, putThrough, type CallFixture } from './call-fixtures.ts';

function facts(over: Partial<CallFacts>): CallFacts {
  return {
    label: 'Paul Weir at Weir Freight',
    firstName: 'Sam',
    outcome: 'connected',
    channel: 'phone',
    durationSec: 60,
    notes: '',
    transcript: null,
    setTime: false,
    booked: false,
    ...over,
  };
}

const recorded = (call: CallFixture, over: Partial<CallFacts> = {}) =>
  facts({
    label: call.label,
    firstName: firstNameOf(call.label),
    outcome: call.outcome,
    durationSec: call.durationSec,
    notes: call.notes,
    transcript: { turns: call.turns, summary: [] },
    ...over,
  });

// The call drawn: its facts read by the rules, then the timeline from both.
const drawn = (f: CallFacts) => callTimeline(f, ruleInsight(f));

const kinds = (t: { phases: { kind: string; from: number; to: number }[] }) =>
  t.phases.map((p) => [p.kind, p.from, p.to] as const);

test('on hold and never put through: the menu, the front desk by name, then the hold to the end', () => {
  const t = drawn(recorded(onHold))!;
  assert.equal(t.totalSec, 261);
  assert.deepEqual(kinds(t), [
    ['menu', 0, 43.3],
    ['desk', 43.3, 48.4],
    ['hold', 48.4, 261],
  ]);
  assert.equal(t.phases[1].label, 'Hugo');
  assert.deepEqual(t.marks, [], 'no opening to them, no objection, no next step');
  assert.equal(t.longestStorySec, null, 'they never came on');
  assert.equal(t.turns.length, onHold.turns.length, 'every turn ticks');
  assert.equal(
    timelineText(t),
    'Phone menu 0:43 · Front desk (Hugo) 0:43–0:48 · On hold from 0:48, they never came on · 4:21 in all'
  );
});

test('put through: the menu, the front desk, the hold, then them, with the opening, the objection and the next step marked', () => {
  const t = drawn(recorded(putThrough))!;
  // Rex came back ("we'll try this again") before the transfer took.
  assert.deepEqual(kinds(t), [
    ['menu', 0, 14.2],
    ['desk', 14.2, 19.1],
    ['hold', 19.1, 38.5],
    ['desk', 38.5, 55.5],
    ['them', 55.5, 543],
  ]);
  assert.equal(t.phases[1].label, 'Rex');
  assert.equal(t.phases[3].label, 'Rex');
  assert.deepEqual(
    t.marks.map((m) => [m.kind, m.at]),
    [
      ['opening', 55.5],
      ['objection', 149.4],
      ['next_step', 527.3],
    ]
  );
  assert.match(t.marks[0].text!, /^yeah so basically lyle/);
  assert.ok(t.marks[0].text!.length <= 80, 'clipped');
  assert.match(t.marks[1].text!, /problems do not involve software/);
  assert.equal(t.marks[2].text, 'Gave their direct number');
  // Stored before turn ends were kept: the six-minute silence after
  // "...meets our needs" is lost audio, not a story.
  assert.ok(t.longestStorySec !== null && t.longestStorySec < STORY_SEC, `longest story ${t.longestStorySec}`);
  assert.equal(t.turns.filter((k) => k.story).length, 0);
  const lyle = t.turns.find((k) => k.from === 158.1)!;
  assert.ok(lyle.to - lyle.from <= 11 * 0.6 + 0.01, 'capped by its eleven words');
  assert.match(
    timelineText(t),
    /^Phone menu 0:14 · Front desk \(Rex\) 0:14–0:19 · On hold from 0:19 to 0:39 · Front desk \(Rex\) 0:39–0:56 · Them from 0:56 · Objection at 2:29 · Next step at 8:47 · 9:03 in all$/
  );
});

test('a hold the front desk comes back from ends there: not available, a message, a refusal', () => {
  const turns: Turn[] = [
    { speaker: 'prospect', start: 0, end: 2, text: 'marlow trucking this is nina' },
    { speaker: 'rep', start: 3, end: 6, text: 'hi nina this is anel is hank available' },
    { speaker: 'prospect', start: 7, end: 9, text: 'let me check one moment' },
    { speaker: 'prospect', start: 40, end: 45, text: 'he is not available right now can i take a message' },
    { speaker: 'rep', start: 46, end: 50, text: 'no thanks i will try him later' },
  ];
  const t = drawn(
    facts({ label: 'Hank Marlow', firstName: 'Hank', durationSec: 52, transcript: { turns, summary: [] } })
  )!;
  assert.deepEqual(kinds(t), [
    ['desk', 0, 7],
    ['hold', 7, 40],
    ['desk', 40, 52],
  ]);
  assert.equal(
    timelineText(t),
    'Front desk (Nina) 0:00–0:07 · On hold from 0:07 to 0:40 · Front desk (Nina) 0:40–0:52 · 0:52 in all'
  );
});

test('they answered themselves: one phase, with the time they agreed to marked', () => {
  const t = drawn(recorded(lunchThenBooked))!;
  assert.deepEqual(kinds(t), [['them', 0, 81]]);
  assert.deepEqual(
    t.marks.map((m) => [m.kind, m.at]),
    [
      ['opening', 2.5],
      ['objection', 48.2],
      ['next_step', 66.5],
    ]
  );
  assert.ok(t.longestStorySec! >= 10 && t.longestStorySec! <= 20, 'the lunch turn, until the rep spoke');
  assert.equal(t.turns.filter((k) => k.story).length, 0);
});

test('a prospect turn of a minute or more is a story', () => {
  const turns: Turn[] = [
    { speaker: 'rep', start: 0, end: 4, text: 'hey grant this is anel how are you' },
    {
      speaker: 'prospect',
      start: 5,
      end: 80,
      text: 'well let me tell you about last tuesday when the dispatcher quit',
    },
    { speaker: 'rep', start: 81, end: 83, text: 'wow and then what did you do' },
    { speaker: 'prospect', start: 84, end: 88, text: 'we called everyone' },
  ];
  const t = drawn(
    facts({ label: 'Grant Ives', firstName: 'Grant', durationSec: 90, transcript: { turns, summary: [] } })
  )!;
  assert.deepEqual(kinds(t), [['them', 0, 90]]);
  assert.equal(t.longestStorySec, 75);
  assert.deepEqual(
    t.turns.map((k) => [k.who, k.from, k.to, k.story ?? false]),
    [
      ['rep', 0, 4, false],
      ['prospect', 5, 80, true],
      ['rep', 81, 83, false],
      ['prospect', 84, 88, false],
    ]
  );
  assert.match(timelineText(t), /Their longest story 1:15/);
});

test('without a transcript, a call with a length is one segment; without a length, nothing', () => {
  const voicemail = drawn(facts({ outcome: 'left_voicemail', durationSec: 40 }))!;
  assert.deepEqual(kinds(voicemail), [['voicemail', 0, 40]]);
  assert.equal(timelineText(voicemail), 'Voicemail from 0:00 · 0:40 in all');
  const connected = drawn(
    facts({ outcome: 'connected', durationSec: 95, notes: 'Talked with Sam, call back Friday' })
  )!;
  assert.deepEqual(kinds(connected), [['call', 0, 95]]);
  assert.deepEqual(connected.turns, []);
  assert.equal(timelineText(connected, 'Connected'), 'Connected · 1:35 in all');
  assert.equal(drawn(facts({ durationSec: null })), null);
  assert.equal(timelineJson(null), null);
});

test('the stored JSON reads back whole; a damaged one reads as none', () => {
  const t = drawn(recorded(onHold))!;
  assert.deepEqual(parseTimeline(timelineJson(t)), t);
  assert.equal(parseTimeline('{bad'), null);
  assert.equal(parseTimeline('{"totalSec":"x"}'), null);
  assert.equal(parseTimeline(null), null);
  assert.equal(parseTimeline(''), null);
});

test('the strip is a picture with its text after it, every position a custom property', () => {
  const t = drawn(recorded(putThrough))!;
  const strip = String(timelineStrip(t));
  assert.match(strip, /^<div class="strip" aria-hidden="true" style="--w: 100%">/);
  assert.match(strip, /<span class="phase hold" style="--l: 3\.5%; --w: 3\.6%"><\/span>/);
  assert.match(strip, /<span class="phase them" style="--l: 10\.2%; --w: 89\.8%"><\/span>/);
  assert.match(strip, /<span class="tick rep" style="--l: /);
  assert.match(strip, /<span class="tick prospect" style="--l: /);
  assert.match(strip, /<span class="mark objection" style="--l: 27\.5%"><\/span>/);
  assert.match(strip, /<p class="strip-text muted">Phone menu 0:14 · Front desk \(Rex\)/);
  // On a shared scale, a shorter call is a shorter strip; its parts still fit it.
  const shared = String(timelineStrip(drawn(recorded(lunchThenBooked))!, { scaleSec: 543, text: false }));
  assert.match(shared, /^<div class="strip" aria-hidden="true" style="--w: 14\.9%">/);
  assert.match(shared, /<span class="phase them" style="--l: 0%; --w: 100%"><\/span>/);
  assert.doesNotMatch(shared, /strip-text/);
});

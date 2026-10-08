import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LAST_TURN_SEC,
  MAX_SEC_PER_WORD,
  summaryLines,
  transcriptHtml,
  transcriptText,
  turnEnd,
  turnSpan,
  turnsFromNova,
  type NovaResult,
  type Turn,
} from '../src/lib/transcript.ts';

// As Nova-3 gives them with `punctuate`: the bare word, and the word as written.
const words = (list: [string, number][]) =>
  list.map(([written, start]) => ({
    word: written.toLowerCase().replace(/[^\p{L}']/gu, ''),
    punctuated_word: written,
    start,
    end: start + 0.4,
  }));

// Channel 0 is the rep (the leg that dialled), channel 1 the prospect.
const call: NovaResult = {
  results: {
    channels: [
      {
        alternatives: [
          {
            words: words([
              ['Hi,', 0.5],
              ['is', 0.9],
              ['this', 1.2],
              ['Ana?', 1.5],
              ['Great.', 4.0],
            ]),
          },
        ],
      },
      {
        alternatives: [
          {
            words: words([
              ['Yes,', 2.2],
              ['speaking.', 2.6],
              ['Send', 5.0],
              ['me', 5.3],
              ['a', 5.5],
              ['quote.', 5.7],
            ]),
          },
        ],
      },
    ],
  },
};

test('interleaves the two channels into who-said-what, in order', () => {
  // Each turn ends with its last word.
  assert.deepEqual(turnsFromNova(call), [
    { speaker: 'rep', start: 0.5, end: 1.5 + 0.4, text: 'Hi, is this Ana?' },
    { speaker: 'prospect', start: 2.2, end: 2.6 + 0.4, text: 'Yes, speaking.' },
    { speaker: 'rep', start: 4.0, end: 4.0 + 0.4, text: 'Great.' },
    { speaker: 'prospect', start: 5.0, end: 5.7 + 0.4, text: 'Send me a quote.' },
  ]);
  assert.equal(
    transcriptText(turnsFromNova(call)),
    'You: Hi, is this Ana?\nProspect: Yes, speaking.\nYou: Great.\nProspect: Send me a quote.'
  );
});

test('a long pause starts a new turn; one channel is labelled as the whole call', () => {
  const mono: NovaResult = {
    results: {
      channels: [
        {
          alternatives: [
            {
              words: words([
                ['Hello', 0],
                ['there', 0.5],
                ['Later', 10],
              ]),
            },
          ],
        },
      ],
    },
  };
  assert.deepEqual(turnsFromNova(mono), [
    { speaker: 'call', start: 0, end: 0.5 + 0.4, text: 'Hello there' },
    { speaker: 'call', start: 10, end: 10 + 0.4, text: 'Later' },
  ]);
  assert.deepEqual(turnsFromNova({}), [], 'no speech');
});

test('without punctuated words (punctuate off), the bare words are used', () => {
  const bare: NovaResult = {
    results: {
      channels: [
        {
          alternatives: [
            {
              words: [
                { word: 'hello', start: 0, end: 0.4 },
                { word: 'there', start: 0.5, end: 0.9 },
              ],
            },
          ],
        },
      ],
    },
  };
  assert.deepEqual(turnsFromNova(bare), [{ speaker: 'call', start: 0, end: 0.9, text: 'hello there' }]);
});

test('a turn’s end: Nova’s when kept, else the next turn’s start, capped by its words', () => {
  const kept: Turn[] = [
    { speaker: 'rep', start: 0, end: 2, text: 'hi there' },
    { speaker: 'prospect', start: 30, end: 31, text: 'yes' },
  ];
  assert.deepEqual(turnSpan(kept, 0, 60), { from: 0, to: 2 }, 'the kept end wins over the 30 s gap');
  assert.deepEqual(turnSpan(kept, 1, 60), { from: 30, to: 31 });

  // Stored before `end` was kept: twelve words, then a six-minute hold.
  const old: Turn[] = [
    { speaker: 'rep', start: 10, text: 'hi hugo this is anel is hank available this morning by chance' },
    { speaker: 'prospect', start: 370, text: 'hank speaking' },
  ];
  assert.equal(turnEnd(old, 0, 400), 10 + 12 * MAX_SEC_PER_WORD, 'not a six-minute turn');
  assert.equal(turnEnd(old, 1, 400), 370 + 2 * MAX_SEC_PER_WORD, 'the last turn, within the call');
  assert.equal(turnEnd(old, 1, 370.5), 370.5, 'never past the end of the call');
  assert.equal(turnEnd(old, 1, null), 370 + 2 * MAX_SEC_PER_WORD, 'no length known: a few seconds');
  assert.equal(turnEnd([{ speaker: 'rep', start: 5, text: 'ok' }], 0, null), 5 + MAX_SEC_PER_WORD, 'one short word');
  const tenWords = [{ speaker: 'rep' as const, start: 5, text: 'one two three four five six seven eight nine ten' }];
  assert.equal(turnEnd(tenWords, 0, null), 5 + LAST_TURN_SEC, 'the last turn, no length known: a few seconds');
  const close: Turn[] = [
    { speaker: 'rep', start: 0, text: 'well how are you doing today' },
    { speaker: 'prospect', start: 1, text: 'fine' },
  ];
  assert.equal(turnEnd(close, 0, 60), 1, 'the next turn cuts it short');
});

test('the HubSpot transcript escapes what was said and stops before the size limit', () => {
  const html = transcriptHtml([{ speaker: 'prospect', start: 0, text: 'Use <b>&</b>' }]);
  assert.equal(html, '<p><strong>Prospect:</strong> Use &lt;b&gt;&amp;&lt;/b&gt;</p>');

  const long = Array.from({ length: 2000 }, (_, i) => ({ speaker: 'rep' as const, start: i, text: 'x'.repeat(40) }));
  const cut = transcriptHtml(long);
  assert.ok(cut.length < 51_000);
  assert.match(cut, /Transcript cut short here/);
});

test('summaryLines keeps up to five bullet lines, without their markers', () => {
  assert.deepEqual(summaryLines('- Runs 12 trucks\n* Quotes by hand\n\n1. Call back Monday\nfour\nfive\nsix'), [
    'Runs 12 trucks',
    'Quotes by hand',
    'Call back Monday',
    'four',
    'five',
  ]);
});

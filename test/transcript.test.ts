import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summaryLines, transcriptHtml, transcriptText, turnsFromNova, type NovaResult } from '../src/lib/transcript.ts';

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
  assert.deepEqual(turnsFromNova(call), [
    { speaker: 'rep', start: 0.5, text: 'Hi, is this Ana?' },
    { speaker: 'prospect', start: 2.2, text: 'Yes, speaking.' },
    { speaker: 'rep', start: 4.0, text: 'Great.' },
    { speaker: 'prospect', start: 5.0, text: 'Send me a quote.' },
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
    { speaker: 'call', start: 0, text: 'Hello there' },
    { speaker: 'call', start: 10, text: 'Later' },
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
  assert.deepEqual(turnsFromNova(bare), [{ speaker: 'call', start: 0, text: 'hello there' }]);
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

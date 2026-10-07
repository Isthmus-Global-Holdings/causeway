import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeEmail, privateNotes, signatureToHtml, voiceWarnings } from '../src/lib/compose.ts';
import { parseDraftResponse } from '../src/lib/draft-format.ts';

test('minimal markup: line breaks only, no styles, text escaped, signature after a blank line', () => {
  const email = composeEmail(
    ' Hello ',
    'Hi <Ana>,\n\nLine one\nLine two\n\nThanks,\nAnel',
    '<b>Anel Canto</b><br>Isthmus'
  );
  assert.equal(email.subject, 'Hello');
  assert.equal(
    email.html,
    '<div dir="ltr">Hi &lt;Ana&gt;,<br><br>Line one<br>Line two<br><br>Thanks,<br>Anel<br><br><b>Anel Canto</b><br>Isthmus</div>'
  );
  assert.ok(!/style=/.test(email.html));
  assert.equal(email.text, 'Hi <Ana>,\n\nLine one\nLine two\n\nThanks,\nAnel\n\nAnel Canto\nIsthmus');
});

test('no signature means nothing after the body', () => {
  assert.equal(composeEmail('s', 'b', null).html, '<div dir="ltr">b</div>');
});

test('voice warnings catch em-dashes, semicolons and "small"', () => {
  assert.deepEqual(voiceWarnings('Quick question', 'We run a small shop — really; yes'), [
    'Contains an em-dash (—).',
    'Contains a semicolon.',
    'Uses the word "small".',
  ]);
  assert.deepEqual(voiceWarnings('Quick question', 'Hi Ana, it looks like you run three terminals.'), []);
});

test('private notes left in the body are found', () => {
  assert.deepEqual(
    privateNotes('Thanks,\nAnel\n\n[Note: role at GTMS unconfirmed, verify Shawn is the right person before sending.]'),
    ['[Note: role at GTMS unconfirmed, verify Shawn is the right person before sending.]']
  );
  assert.deepEqual(privateNotes('Thanks,\nAnel\n\n(Note to self: Mobix is a 3PL, not a carrier.)'), [
    '(Note to self: Mobix is a 3PL, not a carrier.)',
  ]);
  assert.deepEqual(privateNotes('Hi Ana,\n\nNote: check the title first\n\nThanks'), ['Note: check the title first']);
  // Ordinary prose that mentions a note isn't one.
  assert.deepEqual(privateNotes('Hi Ana,\n\nI made a note of it (noted, thanks). Worth noting: none.'), []);
});

test('Claude reply parsing takes the last subject/body blocks', () => {
  const reply =
    'Plan: I will write <subject>draft</subject> later.\n' +
    '<research>\nFMCSA: 42 power units.\n</research>\n<subject> Quick question about\nquoting </subject>\n<body>\nHi Ana,\n\nThanks,\nAnel\n</body>';
  assert.deepEqual(parseDraftResponse(reply), {
    subject: 'Quick question about quoting',
    body: 'Hi Ana,\n\nThanks,\nAnel',
    research: 'FMCSA: 42 power units.',
  });
  assert.throws(() => parseDraftResponse('no tags here'), /without a <subject> and <body>/);
});

test('a plain-text signature keeps its line breaks and gets clickable links', () => {
  const sig = 'Anel Canto\nLehi, UT\n808-555-0142 · https://linkedin.com/in/anelcanto';
  assert.equal(
    signatureToHtml(sig),
    'Anel Canto<br>Lehi, UT<br>808-555-0142 · <a href="https://linkedin.com/in/anelcanto">https://linkedin.com/in/anelcanto</a>'
  );
  const email = composeEmail('s', 'Hi', sig);
  assert.ok(
    email.html.includes('Anel<br><br>Anel Canto<br>Lehi, UT<br>') ||
      email.html.includes('Hi<br><br>Anel Canto<br>Lehi, UT<br>')
  );
  assert.ok(email.text.endsWith('Anel Canto\nLehi, UT\n808-555-0142 · https://linkedin.com/in/anelcanto'));
});

test('an HTML signature is used as-is, and trailing punctuation stays out of links', () => {
  assert.equal(signatureToHtml('<b>Anel</b><br>Lehi'), '<b>Anel</b><br>Lehi');
  assert.equal(signatureToHtml('See https://x.com/a.'), 'See <a href="https://x.com/a">https://x.com/a</a>.');
  assert.equal(signatureToHtml('  '), '');
});

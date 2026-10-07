import assert from 'node:assert/strict';
import { test } from 'node:test';
import { htmlToText, parseTaskBody, textToHtml, toTaskBodyHtml } from '../src/lib/richtext.ts';

test('newlines become <br>, so HubSpot rich text keeps the line breaks', () => {
  assert.equal(textToHtml('Hi Ana,\n\nQuick note.\r\nThanks'), 'Hi Ana,<br><br>Quick note.<br>Thanks');
});

test('text is HTML-escaped before it goes into the task body', () => {
  assert.equal(textToHtml('<b>R&D</b> "team"'), '&lt;b&gt;R&amp;D&lt;/b&gt; &quot;team&quot;');
});

test('task body puts the subject first, separated by a blank line', () => {
  assert.equal(
    toTaskBodyHtml('  Quick idea ', '\nLine one\nLine two\n'),
    'Subject: Quick idea<br><br>Line one<br>Line two'
  );
});

test('a saved task body parses back into subject and body', () => {
  const subject = 'Ideas for <Acme> & co';
  const body = 'Hi Ana,\n\nFirst paragraph.\nSecond line.';
  assert.deepEqual(parseTaskBody(toTaskBodyHtml(subject, body)), { subject, body });
});

test('HubSpot-edited bodies wrapped in <p> still parse', () => {
  assert.deepEqual(parseTaskBody('<p>Subject: Hello<br><br>Body&nbsp;text<br>more</p>'), {
    subject: 'Hello',
    body: 'Body text\nmore',
  });
});

test('plain-text drafts saved with \\n (no tags) keep their line breaks and parse', () => {
  const stored = 'Subject: quick question about quoting\n\nHi Luke,\n\nFirst line.\nSecond line.';
  assert.deepEqual(parseTaskBody(stored), {
    subject: 'quick question about quoting',
    body: 'Hi Luke,\n\nFirst line.\nSecond line.',
  });
});

test('bodies not written by the app return null from parseTaskBody', () => {
  assert.equal(parseTaskBody('<p>Call them about pricing</p>'), null);
});

test('htmlToText turns block tags into line breaks and decodes entities', () => {
  assert.equal(htmlToText('<p>One</p><p>Two &amp; three</p><div>Four&#39;s</div>'), "One\nTwo & three\nFour's");
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillScript, normalizeScript, scriptParts, type ScriptVars } from '../src/lib/call-script.ts';

const VARS: ScriptVars = {
  firstName: 'Ana',
  lastName: 'Díaz',
  name: 'Ana Díaz',
  title: 'COO',
  company: 'Acme',
  fitReason: 'runs the quote-to-invoice workflow',
  myName: 'Anel Canto',
};

test('fills every placeholder', () => {
  assert.equal(
    fillScript('{first_name} {last_name} / {name}, {title} at {company}. — {my_name}', VARS),
    'Ana Díaz / Ana Díaz, COO at Acme. — Anel Canto'
  );
});

test('fills the fit reason', () => {
  assert.equal(
    fillScript('I picked you because {company} {fit_reason}.', VARS),
    'I picked you because Acme runs the quote-to-invoice workflow.'
  );
  assert.equal(fillScript('Because {fit_reason}.', { ...VARS, fitReason: null }), 'Because {fit_reason}.');
});

test('placeholders match without regard to case', () => {
  assert.equal(fillScript('Hi {First_Name} at {COMPANY}', VARS), 'Hi Ana at Acme');
});

test('a missing value or unknown placeholder stays as written', () => {
  assert.equal(fillScript('{title} at {company}', { ...VARS, title: null, company: '  ' }), '{title} at {company}');
  assert.equal(fillScript('Ask about {fleet_size}', VARS), 'Ask about {fleet_size}');
  assert.equal(
    fillScript('Braces { first_name } and {} are left alone', VARS),
    'Braces { first_name } and {} are left alone'
  );
});

test('normalizes line endings and trailing space', () => {
  assert.equal(normalizeScript('One\r\nTwo\rThree\n\n  '), 'One\nTwo\nThree');
});

const SCRIPT = `Before you dial: smile.

━━━━━━━━  1 · OPENER  ━━━━━━━━

"Hey {first_name}, this is Anel."

   ⏸  wait for a yes.

━━━━━━━━  2 · QUESTIONS  ━━━━━━━━

→ Follow what they get animated about.

THE LAST TIME
  •  Walk me through the last load you quoted.
  1.  "Is there anyone else I should talk to?"
━━━━━━━━━━━━━━━━
FOLLOW-UP VOICEMAIL (~10 sec)

## If they push back
"What's this really for?" → "Learning."`;

test('cuts the script into its parts at each heading, the text before the first one untitled', () => {
  const parts = scriptParts(SCRIPT);
  assert.deepEqual(
    parts.map((p) => [p.number, p.title]),
    [
      [null, null],
      ['1', 'OPENER'],
      ['2', 'QUESTIONS'],
      [null, 'If they push back'],
    ]
  );
  assert.deepEqual(parts[0].lines, [{ kind: 'text', text: 'Before you dial: smile.' }]);
});

test('each line keeps its words and indentation, styled by what it is', () => {
  const [, opener, questions, pushBack] = scriptParts(SCRIPT);
  assert.deepEqual(opener.lines, [
    { kind: 'say', text: '"Hey {first_name}, this is Anel."' },
    { kind: 'blank', text: '' },
    { kind: 'cue', text: '   ⏸  wait for a yes.' },
  ]);
  assert.deepEqual(
    questions.lines.map((l) => l.kind),
    ['cue', 'blank', 'subhead', 'text', 'say', 'blank', 'subhead'],
    'a rule with no words is a blank line'
  );
  assert.equal(questions.lines[4].text, '  1.  "Is there anyone else I should talk to?"');
  assert.deepEqual(pushBack.lines, [{ kind: 'say', text: '"What\'s this really for?" → "Learning."' }]);
});

test('a script with no headings is one untitled part', () => {
  assert.deepEqual(scriptParts('Hi {first_name}.\n\nHow do you quote?'), [
    {
      number: null,
      title: null,
      lines: [
        { kind: 'text', text: 'Hi {first_name}.' },
        { kind: 'blank', text: '' },
        { kind: 'text', text: 'How do you quote?' },
      ],
    },
  ]);
  assert.deepEqual(
    scriptParts('━━━ OPENER ━━━\nHi.').map((p) => p.title),
    ['OPENER'],
    'no empty part before the first heading'
  );
});

test('a bold label stays in its part; only words with rules on both sides start one', () => {
  const parts = scriptParts(
    '━━━ OPENER ━━━\n**Ask:** what do you use today?\n__Note__ keep it short\n**Ask** about **this**\n**Close**\n━━━ VOICEMAIL (~18 sec) ━━━'
  );
  assert.deepEqual(
    parts.map((p) => p.title),
    ['OPENER', 'Close', 'VOICEMAIL (~18 sec)']
  );
  assert.deepEqual(parts[0].lines, [
    { kind: 'text', text: '**Ask:** what do you use today?' },
    { kind: 'text', text: '__Note__ keep it short' },
    { kind: 'text', text: '**Ask** about **this**' },
  ]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillScript, normalizeScript, scriptParts, scriptVars, type ScriptVars } from '../src/lib/call-script.ts';

const VARS: ScriptVars = {
  firstName: 'Ana',
  lastName: 'Díaz',
  name: 'Ana Díaz',
  title: 'COO',
  company: 'Acme',
  theirWorld: 'how trucking companies handle quoting and dispatch',
  pedestal: 'you haul livestock and hay, so no two loads quote the same',
  myName: 'Anel Canto',
};

test('fills every placeholder', () => {
  assert.equal(
    fillScript('{first_name} {last_name} / {name}, {title} at {company}. — {my_name}', VARS),
    'Ana Díaz / Ana Díaz, COO at Acme. — Anel Canto'
  );
});

test('fills their world and the pedestal', () => {
  assert.equal(
    fillScript("I'm researching {their_world}, and I'm calling you because {pedestal}.", VARS),
    "I'm researching how trucking companies handle quoting and dispatch, and I'm calling you because you haul livestock and hay, so no two loads quote the same."
  );
  assert.equal(fillScript('Because {pedestal}.', { ...VARS, pedestal: null }), 'Because {pedestal}.');
  assert.equal(fillScript('Picked for {fit_reason}.', VARS), 'Picked for {fit_reason}.', 'the old fill-in is gone');
});

test("takes the values from the contact and the company's research lines", () => {
  const vars = scriptVars(
    { id: '1', properties: { firstname: 'Ana', lastname: null, jobtitle: 'COO' } },
    {
      id: '2',
      properties: {
        name: 'Acme',
        description:
          'Fit: GOOD - owner quotes.\nWorld: how trucking companies handle quoting.\nPedestal: you quote every load yourself.',
      },
    },
    'Anel Canto'
  );
  assert.deepEqual(vars, {
    firstName: 'Ana',
    lastName: null,
    name: 'Ana',
    title: 'COO',
    company: 'Acme',
    theirWorld: 'how trucking companies handle quoting',
    pedestal: 'you quote every load yourself',
    myName: 'Anel Canto',
  });
  assert.equal(scriptVars({ id: '1', properties: {} }, null, null).pedestal, null);
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

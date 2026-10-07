import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillScript, normalizeScript, type ScriptVars } from '../src/lib/call-script.ts';

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

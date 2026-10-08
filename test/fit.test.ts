import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkCallLine,
  parseCallLines,
  parseFitLabel,
  pickNextUp,
  rankByFit,
  withCallLines,
  type FitLabel,
} from '../src/lib/fit.ts';

// Shapes taken from the account's real Company descriptions (Sept 2026).
const cases: [string | null, FitLabel][] = [
  ['Fit: STRONG - small, family-owned, owner-run asset carrier.', 'STRONG'],
  ['Fit: GOOD - family-owned rural asset carrier with mixed ag freight.', 'GOOD'],
  ['Fit: moderate - tanker niche, but a good industry connector.', 'WEAK'],
  ['Fit: POOR - large, almost certainly on an enterprise TMS.', 'DROP'],
  ['Fit: WEAK-MODERATE - mainly e-commerce fulfillment.', 'WEAK'],
  ['Fit: borderline - too big to buy, but could make a good interview.', 'WEAK'],
  ['Fit: mid-size family carrier since 1947. Good learning interview.', 'WEAK'],
  ['Fit: niche/partial - mostly a depot business.', 'WEAK'],
  ['Fit: POOR - at most a shipper who could introduce you to carriers. Likely drop.', 'DROP'],
  ['NOT A FIT - polar expedition + air logistics. Recommend: drop.', 'DROP'],
  ['Probably drop (or a former-owner post-mortem interview only).', 'DROP'],
  ['NOT A FIT for dispatch software.', 'DROP'],
  ['Not a good fit right now.', 'DROP'],
  ['Went out of business in 2024.', 'DROP'],
  ['Poor fit, runs an enterprise TMS.', 'DROP'],
  ['DISQUALIFIED: no decision maker reachable.', 'DROP'],
  ['Do not contact per their request.', 'DROP'],
  ['Overall a good fit for the pilot.', 'GOOD'],
  ['Saw a drop in freight volume last quarter.', 'UNKNOWN'],
  ['Family-owned distributor, 40 staff.', 'UNKNOWN'],
  ['', 'UNKNOWN'],
  [null, 'UNKNOWN'],
];

for (const [description, expected] of cases) {
  test(`parseFitLabel(${JSON.stringify(description)}) → ${expected}`, () => {
    assert.equal(parseFitLabel(description), expected);
  });
}

const row = (id: string, fit: FitLabel, createdAt: string | null, hasDraft = false) => ({
  id,
  fit,
  createdAt,
  hasDraft,
});

test('ranks STRONG > GOOD > WEAK > UNKNOWN > DROP, oldest first within a label', () => {
  const ranked = rankByFit([
    row('drop', 'DROP', '2026-01-01'),
    row('weak', 'WEAK', '2026-01-01'),
    row('good-new', 'GOOD', '2026-03-01'),
    row('unknown', 'UNKNOWN', '2026-01-01'),
    row('good-old', 'GOOD', '2026-02-01'),
    row('strong', 'STRONG', null),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['strong', 'good-old', 'good-new', 'weak', 'unknown', 'drop']
  );
});

test('next up is the best task still to draft, never a drop-flagged one', () => {
  const ranked = rankByFit([
    row('strong-drafted', 'STRONG', '2026-01-01', true),
    row('drop', 'DROP', '2026-01-01'),
    row('good', 'GOOD', '2026-01-01'),
  ]);
  assert.deepEqual(pickNextUp(ranked), { item: ranked[1], step: 'draft' });
  assert.equal(pickNextUp(ranked)?.item.id, 'good');
});

test('once everything is drafted, next up is the best one to send', () => {
  const ranked = rankByFit([row('weak', 'WEAK', '2026-01-01', true), row('good', 'GOOD', '2026-02-01', true)]);
  assert.deepEqual(pickNextUp(ranked), { item: ranked[0], step: 'send' });
  assert.equal(ranked[0].id, 'good');
});

test('nothing to suggest when every task is drop-flagged', () => {
  assert.equal(pickNextUp([row('drop', 'DROP', '2026-01-01')]), null);
});

const WORLD = 'how freight forwarders handle quoting and shipments';
const PEDESTAL = 'you run both ocean and air out of Miami, so no two quotes look alike';

test('reads the World and Pedestal lines written after the Fit line', () => {
  const description = `Contact: Ana Ruiz (President). FMC OTI license 012345. Fit: GOOD - ocean and air, owner quotes.\nWorld: ${WORLD}.\nPedestal: ${PEDESTAL}.`;
  assert.deepEqual(parseCallLines(description), { theirWorld: WORLD, pedestal: PEDESTAL });
  assert.equal(parseFitLabel(description), 'GOOD', 'the new lines leave the rating alone');
});

test('reads them from one paragraph, each ending at the next label', () => {
  assert.deepEqual(parseCallLines(`Fit: STRONG - owner-run. World: ${WORLD}. Pedestal: ${PEDESTAL}.`), {
    theirWorld: WORLD,
    pedestal: PEDESTAL,
  });
  assert.deepEqual(
    parseCallLines('Pedestal: you run terminals in St. George and Price. Fit: GOOD - LTL and TL.'),
    { theirWorld: null, pedestal: 'you run terminals in St. George and Price' },
    'a period inside the clause stays'
  );
});

test('labels match in any case, and quotes around a value come off', () => {
  assert.deepEqual(parseCallLines(`WORLD: "${WORLD}"\npedestal :  ‘${PEDESTAL}’`), {
    theirWorld: WORLD,
    pedestal: PEDESTAL,
  });
});

test('a line that is missing, empty, or only mid-sentence fills nothing', () => {
  const none = { theirWorld: null, pedestal: null };
  assert.deepEqual(parseCallLines(null), none);
  assert.deepEqual(parseCallLines('Fit: STRONG - owner-run asset carrier.'), none);
  assert.deepEqual(parseCallLines('World:\nPedestal: .'), none);
  assert.deepEqual(parseCallLines('Hauls for the Old World: Imports chain.'), none);
});

test('rewriting the lines moves them after the Fit line and keeps the rest', () => {
  assert.equal(
    withCallLines(`Contact: Ana. World: old world. Fit: GOOD - x. Pedestal: old one.`, { pedestal: PEDESTAL }),
    `Contact: Ana. Fit: GOOD - x.\nWorld: old world.\nPedestal: ${PEDESTAL}.`
  );
  assert.equal(withCallLines(null, { theirWorld: WORLD }), `World: ${WORLD}.`);
});

test('a line is checked for one breath in the rep’s voice', () => {
  assert.deepEqual(checkCallLine('pedestal', ` "${PEDESTAL}." `), { value: PEDESTAL });
  assert.ok('problem' in checkCallLine('theirWorld', `${WORLD} ${WORLD} ${WORLD}`), 'too long');
  assert.ok('problem' in checkCallLine('pedestal', 'you quote;\nI listen'));
});

test("the call script's lines never rate a company", () => {
  const description =
    'Fit: STRONG - owner quotes every load.\nWorld: how trucking companies handle quoting.\nPedestal: you work spot freight, so rates probably drop between quote and tender.';
  assert.equal(parseFitLabel(description), 'STRONG');
  assert.equal(parseFitLabel('Family carrier. Pedestal: you are a good fit for this, NOT A FIT for that.'), 'UNKNOWN');
  assert.equal(parseFitLabel('World: how carriers quote. Fit: POOR - enterprise TMS.'), 'DROP');
});

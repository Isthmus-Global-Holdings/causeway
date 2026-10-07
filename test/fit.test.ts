import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFitLabel, parseFitReason, pickNextUp, rankByFit, type FitLabel } from '../src/lib/fit.ts';

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

const reasons: [string | null, string | null][] = [
  [
    'Contact: Jesse Ferris (President). Family-owned. Fit: STRONG - runs the full quote-to-invoice workflow, closest match to the pilot.',
    'runs the full quote-to-invoice workflow, closest match to the pilot',
  ],
  ['Fit: GOOD – family-owned rural asset carrier.\nContact: Ana', 'family-owned rural asset carrier'],
  ['Fit: WEAK-MODERATE - mainly e-commerce fulfillment.', 'mainly e-commerce fulfillment'],
  ['Fit: niche/partial - mostly a depot business.', 'mostly a depot business'],
  [
    'Fit: mid-size family carrier since 1947. Good learning interview.',
    'mid-size family carrier since 1947. Good learning interview',
  ],
  ['Fit label: strong — owner-run.', 'owner-run'],
  ['Fit: POOR - large, almost certainly on an enterprise TMS.', null],
  ['NOT A FIT - polar expeditions. Fit: none.', null],
  ['Overall a good fit for the pilot.', null],
  ['Fit: STRONG - ', null],
  ['Fit: STRONG -', null],
  ['Fit: STRONG', null],
  ['Fit: GOOD.\nContact: Ana', null],
  [null, null],
];

for (const [description, expected] of reasons) {
  test(`parseFitReason(${JSON.stringify(description)}) → ${JSON.stringify(expected)}`, () => {
    assert.equal(parseFitReason(description), expected);
  });
}

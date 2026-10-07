import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextInPlan, parsePlan, withoutItem, withSetTimeCall, type WorkPlan } from '../src/lib/work-plan.ts';

const plan: WorkPlan = {
  date: '2026-09-25',
  items: [
    { id: 'a', drafted: true },
    { id: 'b', drafted: false },
    { id: 'c', drafted: false },
  ],
};

test('the next item skips the current one and any already worked', () => {
  assert.equal(nextInPlan(plan, '2026-09-25', 'a', new Set())?.id, 'b');
  assert.equal(nextInPlan(plan, '2026-09-25', 'a', new Set(['b']))?.id, 'c');
  assert.equal(nextInPlan(plan, '2026-09-25', 'c', new Set(['a', 'b'])), null, 'all done');
});

test("an earlier day's plan is stale", () => {
  assert.equal(nextInPlan(plan, '2026-09-26', 'x', new Set()), null);
  assert.equal(nextInPlan(null, '2026-09-25', 'x', new Set()), null);
});

test('emails: one still to draft comes before one ready to send, like Next up', () => {
  assert.equal(nextInPlan(plan, '2026-09-25', 'x', new Set(), { undraftedFirst: true })?.id, 'b');
  assert.equal(
    nextInPlan(plan, '2026-09-25', 'x', new Set(['b', 'c']), { undraftedFirst: true })?.id,
    'a',
    'then the best one to send'
  );
});

test('calls: a set-time call is next once its time comes, and skipped before', () => {
  const calls: WorkPlan = {
    date: '2026-09-25',
    items: [
      { id: 'at-2pm', drafted: false, at: 1_000 },
      { id: 'a', drafted: false },
      { id: 'b', drafted: false },
    ],
  };
  assert.equal(nextInPlan(calls, '2026-09-25', 'x', new Set(), { now: 999 })?.id, 'a');
  assert.equal(nextInPlan(calls, '2026-09-25', 'a', new Set(), { now: 1_000 })?.id, 'at-2pm');
  assert.equal(nextInPlan(calls, '2026-09-25', 'a', new Set(['b']), { now: 999 }), null, 'nothing else yet');
  assert.deepEqual(parsePlan(JSON.stringify(calls)), calls);
});

test('a set-time call made after the plan was saved joins it, among the set-time calls by time', () => {
  const calls: WorkPlan = {
    date: '2026-09-25',
    items: [
      { id: 'at-1', drafted: false, at: 1_000 },
      { id: 'at-3', drafted: false, at: 3_000 },
      { id: 'a', drafted: false },
    ],
  };
  const ids = (p: WorkPlan | null) => p?.items.map((i) => i.id);
  assert.deepEqual(ids(withSetTimeCall(calls, '2026-09-25', 'new', 2_000)), ['at-1', 'new', 'at-3', 'a']);
  assert.deepEqual(ids(withSetTimeCall(calls, '2026-09-25', 'new', 9_000)), ['at-1', 'at-3', 'new', 'a']);
  assert.deepEqual(
    ids(withSetTimeCall(calls, '2026-09-25', 'a', 500)),
    ['a', 'at-1', 'at-3'],
    'moved: it replaces its entry'
  );
  assert.equal(withSetTimeCall(calls, '2026-09-26', 'new', 2_000), calls, "another day's plan is left alone");
  assert.equal(withSetTimeCall(null, '2026-09-25', 'new', 2_000), null);

  const after = withSetTimeCall(calls, '2026-09-25', 'new', 2_000);
  assert.equal(nextInPlan(after, '2026-09-25', 'a', new Set(['at-1']), { now: 2_000 })?.id, 'new');
});

test('a stored plan is read back, and anything else is no plan', () => {
  assert.deepEqual(parsePlan(JSON.stringify(plan)), plan);
  assert.equal(parsePlan(undefined), null);
  assert.equal(parsePlan('not json'), null);
  assert.equal(parsePlan('{"date":"2026-09-25"}'), null);
  assert.deepEqual(parsePlan('{"date":"2026-09-25","items":[{"id":"a","drafted":true},{"id":7}]}')?.items, [
    { id: 'a', drafted: true },
  ]);
});

test('an item taken out of the plan is never next', () => {
  assert.equal(nextInPlan(withoutItem(plan, 'b'), '2026-09-25', 'a', new Set())?.id, 'c');
});

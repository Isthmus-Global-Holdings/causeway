// What the connector's tools return, cut down from the app's records.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companySummary, contactSummary, history, HISTORY_SHOWN, storedTime, taskSummary } from '../src/mcp/format.ts';
import type { HistoryItem } from '../src/workflows/call-context.ts';

const ORIGIN = 'https://app.example';
const TZ = 'America/Denver';

test('a contact comes with a dialable number, a one-line address and its page', () => {
  const summary = contactSummary(
    {
      id: '10',
      properties: {
        firstname: 'Ana',
        lastname: 'Díaz',
        phone: '(385) 555-0100',
        address: '2150 S 1300 W',
        city: 'Salt Lake City',
        state: 'UT',
        zip: '84119',
        country: 'United States',
      },
    },
    ORIGIN
  );
  assert.equal(summary.name, 'Ana Díaz');
  assert.equal(summary.phone, '+13855550100');
  assert.equal(summary.address, '2150 S 1300 W, Salt Lake City, UT 84119');
  assert.equal(summary.url, `${ORIGIN}/contacts/10`);
});

test('a company says how well it fits', () => {
  const summary = companySummary({ id: '20', properties: { name: 'Acme', description: null } }, ORIGIN);
  assert.equal(summary.name, 'Acme');
  assert.equal(typeof summary.fit, 'string');
  assert.equal(summary.url, `${ORIGIN}/companies/20`);
  assert.equal(summary.pedestal, null, 'a gap Claude can see');
});

test('a task links to its call page or its draft page', () => {
  const call = taskSummary(
    { id: '1', properties: { hs_task_type: 'CALL', hs_timestamp: '2026-09-25T15:00:00Z' } },
    TZ,
    ORIGIN
  );
  assert.equal(call.url, `${ORIGIN}/calls/1`);
  assert.equal(call.due, 'Fri, Sep 25, 9:00 AM');
  const email = taskSummary({ id: '2', properties: { hs_task_type: 'EMAIL' } }, TZ, ORIGIN);
  assert.equal(email.url, `${ORIGIN}/tasks/2/draft`);
});

test("times stored in D1 read the same whether SQLite's or ISO", () => {
  assert.equal(storedTime('2026-09-25 15:00:00', TZ), 'Fri, Sep 25, 9:00 AM');
  assert.equal(storedTime('2026-09-25T15:00:00.000Z', TZ), 'Fri, Sep 25, 9:00 AM');
  assert.equal(storedTime(null, TZ), null);
});

test('the history is newest first, capped, and says which parts HubSpot refused', () => {
  const item = (i: number): HistoryItem => ({
    kind: 'note',
    id: String(i),
    at: Date.UTC(2026, 8, 1) + i * 60_000,
    title: `Note ${i}`,
    detail: null,
    text: '',
    fullText: null,
  });
  const notes = Array.from({ length: HISTORY_SHOWN + 5 }, (_, i) => item(i));
  const result = history(
    {
      notes: { items: notes, failed: false, missingScopes: [] },
      calls: { items: [], failed: true, missingScopes: [] },
      emails: { items: [], failed: false, missingScopes: [] },
    },
    TZ
  );
  assert.equal(result.items.length, HISTORY_SHOWN);
  assert.equal(result.items[0].title, `Note ${HISTORY_SHOWN + 4}`);
  assert.deepEqual(result.unread, ['calls']);
});

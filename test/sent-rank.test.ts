import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heat, rankSends, type RankableSend } from '../src/lib/sent-rank.ts';

const send = (id: string, overrides: Partial<RankableSend> = {}) => ({
  id,
  status: 'sent',
  track_opens: 1,
  track_clicks: 1,
  opens: 0,
  clicks: 0,
  last_event_at: null,
  last_open_at: null,
  called_at: null,
  ...overrides,
});

test('clicked, then opened, then the rest in their order (newest sent first)', () => {
  const ranked = rankSends([
    send('a'),
    send('b', { opens: 1, last_open_at: '2026-09-25 18:00:00', last_event_at: '2026-09-25 18:00:00' }),
    send('c'),
    send('d', { clicks: 1, last_event_at: '2026-09-25 17:00:00' }),
  ]);
  assert.deepEqual(
    ranked.map((s) => s.id),
    ['d', 'b', 'a', 'c']
  );
});

test('within a tier, the most recent engagement first', () => {
  const ranked = rankSends([
    send('a', { opens: 1, last_open_at: '2026-09-25 10:00:00' }),
    send('b', { opens: 3, last_open_at: '2026-09-25 16:00:00' }),
  ]);
  assert.deepEqual(
    ranked.map((s) => s.id),
    ['b', 'a']
  );
});

test("a contact called since isn't hot, nor is a send that isn't sent or had tracking off", () => {
  assert.equal(heat(send('a', { clicks: 2, called_at: '2026-09-26 15:00:00' })), null);
  assert.equal(heat(send('a', { opens: 1, status: 'unknown' })), null);
  assert.equal(heat(send('a', { opens: 1, track_opens: 0 })), null);
  assert.equal(heat(send('a', { opens: 1, clicks: 1, track_clicks: 0 })), 'opened');
  assert.equal(heat(send('a', { opens: 1, clicks: 1 })), 'clicked');
});

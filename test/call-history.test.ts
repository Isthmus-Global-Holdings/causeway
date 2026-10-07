// The Calls page (/calls), the record of every call in and
// out, newest first, searchable, with the summary inline and the transcript a
// click away, and the callers waiting on a call back on top.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  clock,
  cursorParam,
  historyFilters,
  likePattern,
  numberPattern,
  searchMatches,
  snippet,
  type HistoryFilters,
} from '../src/lib/call-history.ts';
import { callHistory, dismissCallBack, waitingOnCallBack } from '../src/lib/db.ts';
import type { AppEnv } from '../src/types.ts';
import { waitingCard } from '../src/views/calls.ts';
import { historyPage } from '../src/views/history.ts';
import { queueTabs } from '../src/views/layout.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const TZ = 'America/Denver';
const DAY = 86_400;
const T0 = Date.parse('2026-09-20T15:00:00Z') / 1000;
const NOW_SEC = T0 + 4 * DAY;

let db: D1Database;

const transcript = (...texts: [speaker: string, text: string][]) =>
  JSON.stringify(texts.map(([speaker, text], i) => ({ speaker, start: i * 5, text })));

async function dial(
  id: string,
  startedSec: number,
  extra: Partial<Record<'subject' | 'task_id' | 'prospect_status' | 'summary' | 'transcript_json', string>> & {
    duration?: number;
  } = {}
) {
  await db
    .prepare(
      `INSERT INTO dials (id, task_id, subject, contact_id, contact_label, to_number, from_number, rep_number,
         started_sec, rep_status, prospect_status, prospect_duration_sec, record, recording_sid, transcript_status,
         transcript_json, summary)
       VALUES (?, ?, ?, 'c1', 'Dana Reyes', '+18015550130', '+13852557051', '+15555550100', ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      extra.task_id ?? `t-${id}`,
      extra.subject ?? 'task',
      startedSec,
      extra.prospect_status ?? 'completed',
      extra.duration ?? null,
      extra.transcript_json ? 1 : 0,
      extra.transcript_json ? `RE${id}` : null,
      extra.transcript_json ? 'done' : null,
      extra.transcript_json ?? null,
      extra.summary ?? null
    )
    .run();
}

async function callLog(taskId: string, createdAt: string, dialId: string | null, notes: string) {
  await db
    .prepare(
      `INSERT INTO call_logs (call_task_id, contact_id, title, outcome, notes, dial_id, to_number, created_at)
       VALUES (?, 'c1', 'Call with Dana Reyes', 'connected', ?, ?, '+18015550130', ?)`
    )
    .bind(taskId, notes, dialId, createdAt)
    .run();
}

async function inbound(id: string, startedSec: number, voicemail: boolean, text: string | null) {
  await db
    .prepare(
      `INSERT INTO inbound_calls (id, call_sid, from_number, to_number, started_sec, contact_label, voicemail, status,
         ended_sec, recording_sid, recording_duration_sec, transcript_status, transcript_json, summary)
       VALUES (?, ?, '+13855550000', '+13852557051', ?, NULL, ?, 'completed', ?, ?, 20, ?, ?, ?)`
    )
    .bind(
      id,
      `CA${id}`,
      startedSec,
      voicemail ? 1 : 0,
      startedSec + 30,
      voicemail ? `RE${id}` : null,
      text ? 'done' : null,
      text ? transcript(['call', text]) : null,
      text ? 'Wants a call back about pricing.' : null
    )
    .run();
}

const filters = (f: Partial<HistoryFilters> = {}): HistoryFilters => ({ dir: 'all', q: null, before: null, ...f });

beforeEach(async () => {
  db = sqliteD1();
  // Newest first: a voicemail, a connected call logged with notes, a call
  // logged by hand, a call back that went unanswered.
  await inbound('in1', T0 + 3 * DAY, true, 'Hi this is Sam from Ogden Freight');
  await dial('d2', T0 + 2 * DAY, {
    duration: 192,
    summary: 'Runs 12 trucks.\nWants a demo next week.',
    transcript_json: transcript(['rep', 'Hi Dana'], ['prospect', 'We run a reefer fleet out of Salt Lake']),
  });
  await callLog('t-d2', '2026-09-22 16:00:00', 'd2', 'Follow up Tuesday.');
  await callLog('t-hand', '2026-09-21 15:00:00', null, 'Called from my cell.');
  await dial('d1', T0, { subject: 'inbound', task_id: 'in0', prospect_status: 'no-answer' });
});

test('The call record lists every kind of call once, newest first', async () => {
  const page = await callHistory(db, filters(), 25);
  assert.deepEqual(
    page.items.map(
      (i) => `${i.kind}:${i.kind === 'dial' ? i.dial.id : i.kind === 'inbound' ? i.call.id : i.log.call_task_id}`
    ),
    ['inbound:in1', 'dial:d2', 'logged:t-hand', 'dial:d1']
  );
  const logged = page.items[1];
  assert.ok(logged.kind === 'dial');
  assert.equal(logged.dial.log_outcome, 'connected');
  assert.equal(logged.dial.log_notes, 'Follow up Tuesday.');
  assert.equal(page.nextBefore, null);
});

test('The call record filters by direction', async () => {
  const kinds = async (dir: HistoryFilters['dir']) =>
    (await callHistory(db, filters({ dir }), 25)).items.map((i) => i.kind);
  assert.deepEqual(await kinds('in'), ['inbound']);
  assert.deepEqual(await kinds('out'), ['dial', 'logged', 'dial']);
});

test('The call record pages by the last call shown', async () => {
  const first = await callHistory(db, filters(), 2);
  assert.equal(first.items.length, 2);
  assert.deepEqual(first.nextBefore, { sec: T0 + 2 * DAY, key: 'd:d2' });
  const second = await callHistory(db, filters({ before: first.nextBefore }), 2);
  assert.deepEqual(
    second.items.map((i) => i.kind),
    ['logged', 'dial']
  );
  assert.equal(second.nextBefore, null);
});

test('The call record pages through calls in the same second without skipping or repeating one', async () => {
  // Four more calls in the second t-hand was logged: five in one second, so
  // page boundaries fall among them.
  const at = T0 + DAY;
  await dial('dA', at);
  await dial('dB', at);
  await inbound('iA', at, false, null);
  await callLog('t-same', new Date(at * 1000).toISOString().slice(0, 19).replace('T', ' '), null, 'Same second.');
  const seen: string[] = [];
  let before: HistoryFilters['before'] = null;
  for (let pages = 0; pages < 10; pages++) {
    const page = await callHistory(db, filters({ before }), 2);
    seen.push(...page.items.map((i) => i.key));
    if (!page.nextBefore) break;
    before = page.nextBefore;
  }
  assert.deepEqual(seen, ['i:in1', 'd:d2', 'l:t-same', 'l:t-hand', 'i:iA', 'd:dB', 'd:dA', 'd:d1']);
});

test('The call record searches transcripts’ words, summaries, notes, names and numbers', async () => {
  const found = async (q: string) =>
    (await callHistory(db, filters({ q }), 25)).items.map((i) =>
      i.kind === 'dial' ? i.dial.id : i.kind === 'inbound' ? i.call.id : i.log.call_task_id
    );
  assert.deepEqual(await found('reefer'), ['d2']); // the transcript
  assert.deepEqual(await found('Ogden'), ['in1']); // a voicemail's transcript
  assert.deepEqual(await found('demo'), ['d2']); // the summary
  assert.deepEqual(await found('cell'), ['t-hand']); // the notes
  assert.deepEqual(await found('(385) 555'), ['in1']); // the caller's number, by its digits
  assert.deepEqual(await found('speaker'), []); // not the transcript's JSON
  assert.deepEqual(await found('Dana%'), []); // LIKE's wildcards are literal
});

test('historyFilters reads the query string', () => {
  assert.deepEqual(historyFilters({}), { dir: 'all', q: null, before: null });
  assert.deepEqual(historyFilters({ dir: 'in', q: '  demo ', before: '1790000000~d:ab~c' }), {
    dir: 'in',
    q: 'demo',
    before: { sec: 1790000000, key: 'd:ab~c' },
  });
  assert.deepEqual(historyFilters({ before: '1790000000' }).before, { sec: 1790000000, key: '' });
  assert.deepEqual(historyFilters({ dir: 'sideways', q: 'a', before: 'soon' }), {
    dir: 'all',
    q: null,
    before: null,
  });
  assert.equal(cursorParam({ sec: 1790000000, key: 'i:x' }), '1790000000~i:x');
  assert.equal(likePattern('50%_off\\'), '%50\\%\\_off\\\\%');
  assert.equal(numberPattern('(801) 555'), '%801555%');
  assert.equal(numberPattern('Dana'), null);
  assert.equal(numberPattern('12'), null);
});

const render = async (f: HistoryFilters) =>
  String(
    await historyPage(
      {
        page: await callHistory(db, f, 25),
        filters: f,
        setup: { twilioReady: true, fromNumber: '+13852557051', repPhone: '+15555550100' },
        nowSec: NOW_SEC,
        timeZone: TZ,
        insights: new Map(),
        back: '/calls',
      },
      'rep@example.com'
    )
  );

test('Calls, the record, shows each call’s summary, notes and transcript', async () => {
  const out = await render(filters());
  assert.match(out, /href="\/calls" aria-current="page">Calls</); // the nav
  assert.match(out, /<h1>Calls<\/h1>/);
  assert.doesNotMatch(out, /class="tabs"/); // the Queue's tabs aren't here
  assert.doesNotMatch(out, /Waiting on a call back/); // that's work: the Queue's
  assert.doesNotMatch(out, /href="\/inbound"/); // no Inbound in the nav
  assert.match(out, /<li>Wants a demo next week\.<\/li>/);
  assert.match(out, /<strong>Connected\.<\/strong>/);
  assert.match(out, /Follow up Tuesday\./);
  assert.match(out, /We run a reefer fleet out of Salt Lake/);
  assert.match(out, /src="\/calls\/t-d2\/recording\/d2"/);
  assert.match(out, /href="\/calls\/t-d2"/);
  assert.match(out, />Voicemail</);
  assert.match(out, /src="\/inbound\/in1\/recording"/);
  assert.match(out, /Logged by hand/);
  assert.match(out, /href="\/calls\/t-hand"/);
  assert.match(out, /Not read for coaching yet\./);
  assert.match(out, /action="\/coaching\/calls\/t-hand\/exclude"/);
  assert.match(out, />Leave out of coaching</);
  assert.match(out, /Call back/);
  assert.match(out, /href="\/inbound\/in0"/);
});

test('the voicemail nobody returned waits in the call queue, with Dismiss and Call back', async () => {
  const out = String(await waitingCard(await waitingOnCallBack(db, NOW_SEC), TZ));
  assert.match(out, /Waiting on a call back \(1\)/);
  assert.match(out, /<form method="post" action="\/inbound\/in1\/dismiss">/);
  assert.match(out, /href="\/inbound\/in1#call-back">Call back</);
  assert.match(out, />Voicemail</);
  assert.match(out, /Wants a call back about pricing\./);
});

test('the Queue’s tabs: emails to send, calls to make and who’s waiting on a call back', async () => {
  const emails = String(await queueTabs('emails', 2));
  assert.match(emails, /<a href="\/" aria-current="page">Emails to send<\/a>/);
  assert.match(emails, /<a href="\/queue\/calls">Calls to make <span class="muted">· 2 to call back<\/span><\/a>/);
  const calls = String(await queueTabs('calls', 0));
  assert.match(calls, /<a href="\/queue\/calls" aria-current="page">Calls to make<\/a>/);
  // Never loaded ahead: opening a tab is what remembers it for the Queue link,
  // and a prefetched page opens without a request of its own.
  assert.match(calls, /<a href="\/">Emails to send<\/a>/);
  assert.doesNotMatch(emails + calls, /data-prefetch/);
});

test('a caller stops waiting once called back, answered, or dismissed', async () => {
  const waitingIds = async () => (await waitingOnCallBack(db, NOW_SEC)).map((c) => c.id);
  assert.deepEqual(await waitingIds(), ['in1']);

  // A second missed call from the number: only the latest shows.
  await inbound('in2', T0 + 3 * DAY + 600, false, null);
  assert.deepEqual(await waitingIds(), ['in2']);

  // A call back the rep never confirmed (didn't press 1, or the browser call
  // never started) didn't dial them: they're still waiting.
  const callBack = (id: string, sec: number, connectedAt: string | null) =>
    db
      .prepare(
        `INSERT INTO dials (id, task_id, subject, contact_id, contact_label, to_number, from_number, rep_number, started_sec,
           connected_at)
         VALUES (?, 'in2', 'inbound', '', 'Sam', '+13855550000', '+13852557051', 'browser', ?, ?)`
      )
      .bind(id, sec, connectedAt)
      .run();
  await callBack('d8', T0 + 3 * DAY + 800, null);
  assert.deepEqual(await waitingIds(), ['in2']);

  // Dialling the number from the app, from anywhere, counts as calling back.
  await callBack('d9', T0 + 3 * DAY + 900, '2026-09-23T15:15:00Z');
  assert.deepEqual(await waitingIds(), []);

  // A later missed call waits again, until it's dismissed.
  await inbound('in3', T0 + 3 * DAY + 1200, false, null);
  assert.deepEqual(await waitingIds(), ['in3']);
  assert.equal(await dismissCallBack(db, 'in3', '2026-09-24T00:00:00Z'), true);
  assert.equal(await dismissCallBack(db, 'in3', '2026-09-24T00:00:00Z'), false);
  assert.deepEqual(await waitingIds(), []);

  // A call answered later is no one to call back.
  await inbound('in4', T0 + 3 * DAY + 1500, false, null);
  await db.prepare(`UPDATE inbound_calls SET answered_at = 'x' WHERE id = 'in4'`).run();
  assert.deepEqual(await waitingIds(), []);

  // Only the last two weeks.
  assert.deepEqual(
    (await waitingOnCallBack(db, NOW_SEC + 30 * DAY)).map((c) => c.id),
    []
  );
});

test('a search shows where the words turned up, marked', async () => {
  const out = await render(filters({ q: 'reefer' }));
  assert.match(
    out,
    /<span class="muted">Prospect at 0:05<\/span><span>We run a <mark>reefer<\/mark> fleet out of Salt Lake<\/span>/
  );
  assert.doesNotMatch(out, /<li>Runs 12 trucks\.<\/li>/); // the matches stand in for the summary

  const notes = await render(filters({ q: 'cell' }));
  assert.match(notes, /Your notes<\/span><span>Called from my <mark>cell<\/mark>\.<\/span>/);
  assert.match(await render(filters({ q: 'nothing like it' })), /No calls mention “nothing like it”\./);
});

test('searchMatches picks summary lines, notes, then what was said', () => {
  const found = {
    summary: ['Runs 12 trucks.', 'Wants a demo next week.'],
    notes: 'Demo on Tuesday.',
    turns: [
      { speaker: 'rep' as const, start: 64.2, text: 'Would a demo help?' },
      { speaker: 'prospect' as const, start: 70, text: 'A DEMO would be great.' },
    ],
  };
  assert.deepEqual(
    searchMatches('demo', found).map((m) => (m.where === 'transcript' ? `${m.speaker}@${clock(m.startSec)}` : m.where)),
    ['summary', 'notes', 'rep@1:04'] // three at most
  );
  assert.deepEqual(snippet('A DEMO would be great.', 'demo'), { before: 'A ', hit: 'DEMO', after: ' would be great.' });
  const long = `${'a'.repeat(100)} demo ${'b'.repeat(100)}`;
  const cut = snippet(long, 'demo')!;
  assert.ok(cut.before.startsWith('…') && cut.after.endsWith('…'));
  assert.equal(snippet('Runs 12 trucks.', 'demo'), null);
  assert.equal(clock(4), '0:04');
  assert.equal(clock(750.9), '12:30');
});

test('GET /calls is the record, /calls/:id still a call task, /inbound redirects, Dismiss lands on the queue', async () => {
  const { default: app } = await import('../src/index.ts');
  const env = { DB: db, DEV_BYPASS_ACCESS: 'true', TZ, HUBSPOT_ACCESS_TOKEN: 'test' } as unknown as AppEnv['Bindings'];
  const page = await app.request('http://localhost/calls', {}, env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>Calls<\/h1>/);

  // The call task's routes are untouched by the record's GET /calls.
  const task = await app.request('http://localhost/calls/1/dial/nope/status', {}, env);
  assert.equal(task.status, 404);
  assert.match(await task.text(), /That call isn’t on this task\./);

  const old = await app.request('http://localhost/inbound', {}, env);
  assert.equal(old.status, 301);
  assert.equal(old.headers.get('Location'), '/calls?dir=in');

  const dismissed = await app.request(
    'http://localhost/inbound/in1/dismiss',
    { method: 'POST', headers: { Origin: 'http://localhost' } },
    env
  );
  assert.equal(dismissed.status, 303);
  assert.equal(dismissed.headers.get('Location'), '/queue/calls');
  assert.deepEqual(await waitingOnCallBack(db, NOW_SEC), []);
});

test('the Queue link opens the tab the rep was last on', async () => {
  const { default: app } = await import('../src/index.ts');
  const { Hono } = await import('hono');
  const { rememberQueueTab } = await import('../src/lib/queue-tab.ts');
  const env = { DB: db, DEV_BYPASS_ACCESS: 'true', TZ, HUBSPOT_ACCESS_TOKEN: 'test' } as unknown as AppEnv['Bindings'];
  const queue = (cookie?: string) =>
    app.request('http://localhost/queue', { headers: cookie ? { Cookie: cookie } : {} }, env);

  assert.equal((await queue()).headers.get('Location'), '/');
  assert.equal((await queue('queue_tab=calls')).headers.get('Location'), '/queue/calls');
  assert.equal((await queue('queue_tab=emails')).headers.get('Location'), '/');
  assert.equal((await queue('queue_tab=bogus')).headers.get('Location'), '/');

  const tabs = new Hono().get('/', (c) => {
    rememberQueueTab(c, 'calls');
    return c.text('ok');
  });
  const cookie = (await tabs.request('https://example.test/')).headers.get('Set-Cookie') ?? '';
  assert.match(cookie, /^queue_tab=calls; Max-Age=7776000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
});

test('a WhatsApp message logged on a task shows in the record as one', async () => {
  await db
    .prepare(
      `INSERT INTO call_logs (call_task_id, contact_id, title, channel, outcome, notes, to_number, created_at)
       VALUES ('t-wa', 'c1', 'WhatsApp message to Dana Reyes', 'whatsapp_message', 'replied',
               'Hi Dana, this is Anel.', '+18015550130', '2026-09-23 15:00:00')`
    )
    .run();
  const out = await render(filters());
  assert.match(out, /WhatsApp message to Dana Reyes/);
  assert.match(out, /<strong>They replied\.<\/strong> <span class="muted">Messaged on WhatsApp\.<\/span>/);
  assert.match(await render(filters({ q: 'WhatsApp' })), /href="\/calls\/t-wa"/, 'found by its title');
});

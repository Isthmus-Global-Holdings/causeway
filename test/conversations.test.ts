// Real conversations toward 100: the counting and the pace (pure), and the
// store on SQLite with the real migrations, and Coaching's Count and
// Uncount through the app.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  canCount,
  conversationReport,
  firstLine,
  parseConversationForm,
  suggestConversation,
  whoFromTitle,
  whoLabel,
  type ConversationRow,
} from '../src/lib/conversations.ts';
import { callsLogged, d1CallInsightStore, d1ConversationStore, type CallInsight } from '../src/lib/db.ts';
import { RULES_VERSION } from '../src/lib/call-insight.ts';
import type { AppEnv } from '../src/types.ts';
import { bookingReport, callFunnel, coachingReport, momTestReport, talkReport } from '../src/lib/coaching.ts';
import { coachingPage } from '../src/views/coaching.ts';
import { todayStrip } from '../src/views/layout.ts';
import { FakeHubSpot, hubspotApi } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

let db: D1Database;
beforeEach(() => {
  db = sqliteD1();
});

const row = (over: Partial<ConversationRow> & Pick<ConversationRow, 'ref_id'>): ConversationRow => ({
  kind: 'call',
  contact_id: `c-${over.ref_id}`,
  who: `Contact ${over.ref_id}`,
  learned: null,
  at: '2026-09-28T19:24:30.000Z',
  notes: null,
  ...over,
});

test('who: the way a dial labels them, from the contact or from a logged call’s title', () => {
  assert.equal(whoLabel('Dallas Peery', 'Wanship Transportation'), 'Dallas Peery at Wanship Transportation');
  assert.equal(whoLabel('Dallas Peery', null), 'Dallas Peery');
  assert.equal(
    whoFromTitle('Call with Dallas Peery (Wanship Transportation)'),
    'Dallas Peery at Wanship Transportation'
  );
  assert.equal(whoFromTitle('WhatsApp message to Ana Díaz (Acme)'), 'Ana Díaz at Acme');
  assert.equal(whoFromTitle('WhatsApp call with Bo'), 'Bo');
  assert.equal(whoFromTitle('Call with Grant Ives at Ives Logistics'), 'Grant Ives at Ives Logistics');
  assert.equal(whoFromTitle('Lyle Moss at Cedar Point'), 'Lyle Moss at Cedar Point', 'a dial’s label is left alone');
});

test('the form: the box, and the line trimmed to one', () => {
  assert.deepEqual(parseConversationForm({ conversation: '1', learned: '  People,\n not software. ' }), {
    counts: true,
    learned: 'People, not software.',
  });
  assert.deepEqual(parseConversationForm({ learned: '' }), { counts: false, learned: null });
  assert.equal(parseConversationForm({ conversation: '1', learned: 'x'.repeat(400) }).learned?.length, 280);
});

test('the notes’ first sentence stands in for a line', () => {
  assert.equal(
    firstLine(
      "He said that the issue is not software, it's that people don't have skills. Even people that have been there 10 years."
    ),
    "He said that the issue is not software, it's that people don't have skills."
  );
  assert.equal(firstLine('Call back Thursday\nAsked about loads'), 'Call back Thursday');
  assert.equal(firstLine('   '), null);
  assert.equal(firstLine('a'.repeat(200), 20), `${'a'.repeat(19)}…`);
});

test('what can count, and what’s ticked for the rep: a held interview, a connect that ran five minutes', () => {
  assert.equal(canCount('call', 'connected'), true);
  assert.equal(canCount('call', 'replied'), true);
  assert.equal(canCount('call', 'left_voicemail'), false);
  assert.equal(canCount('interview', 'COMPLETED'), true);
  assert.equal(canCount('interview', 'NO_SHOW'), false);
  assert.equal(suggestConversation({ kind: 'interview', outcome: 'COMPLETED' }), true);
  assert.equal(suggestConversation({ kind: 'call', outcome: 'connected', durationSec: 543 }), true);
  assert.equal(suggestConversation({ kind: 'call', outcome: 'connected', durationSec: 68 }), false);
  assert.equal(suggestConversation({ kind: 'call', outcome: 'connected', durationSec: null }), false);
  assert.equal(suggestConversation({ kind: 'call', outcome: 'replied' }), false);
});

test('the report counts people, not calls, and the pace in calls', () => {
  const none = conversationReport([], 13);
  assert.equal(none.people, 0);
  assert.equal(none.toGo, 100);
  assert.equal(none.callsPerConversation, null);
  assert.equal(none.callsToGo, null);

  const dallas = conversationReport(
    [row({ ref_id: 't1', contact_id: 'dallas', notes: 'The issue is not software. It’s people.' })],
    13
  );
  assert.equal(dallas.people, 1);
  assert.equal(dallas.callsPerConversation, 13);
  assert.equal(dallas.callsToGo, 1287);
  assert.deepEqual(dallas.entries[0], {
    kind: 'call',
    refId: 't1',
    contactId: 'dallas',
    who: 'Contact t1',
    line: 'The issue is not software.',
    own: false,
    at: '2026-09-28T19:24:30.000Z',
  });

  const twice = conversationReport(
    [
      row({ ref_id: 't1', contact_id: 'dallas', learned: 'People, not software' }),
      row({ ref_id: 'm1', kind: 'interview', contact_id: 'dallas', at: '2026-10-02T15:00:00.000Z' }),
      row({ ref_id: 't2', contact_id: 'jeremy', at: '2026-10-07T18:52:23.000Z' }),
    ],
    20
  );
  assert.equal(twice.people, 2, 'Dallas twice is one person');
  assert.deepEqual(
    twice.entries.map((e) => e.refId),
    ['t2', 'm1', 't1'],
    'newest first'
  );
  assert.equal(twice.entries[2]!.own, true);
});

async function logCall(id: string, contactId: string, notes: string, channel = 'phone') {
  await db
    .prepare(
      `INSERT INTO call_logs (call_task_id, contact_id, title, channel, outcome, notes, created_at)
       VALUES (?, ?, ?, ?, 'connected', ?, '2026-09-28 19:24:30')`
    )
    .bind(id, contactId, `Call with ${contactId}`, channel, notes)
    .run();
}

async function read(id: string, over: Partial<CallInsight> = {}) {
  await d1CallInsightStore(db).save({
    call_task_id: id,
    subject: 'task',
    meeting_log_id: null,
    contact_id: `c-${id}`,
    company_id: null,
    dial_id: null,
    label: `Contact ${id} at Co`,
    at_sec: Date.parse('2026-09-28T19:14:19Z') / 1000,
    contact_tz: null,
    outcome: 'connected',
    duration_sec: 543,
    gate: 'owner',
    gatekeeper_result: null,
    gatekeeper_name: null,
    phone_tree_sec: null,
    phone_tree_digit: null,
    reached: 1,
    talk_sec: null,
    stage: 'next_step',
    objection: null,
    objection_kind: null,
    got_past_objection: 0,
    next_step: 1,
    next_step_text: null,
    opening: null,
    gatekeeper_line: null,
    what_worked: null,
    adjust: null,
    asked_last_time: null,
    pitched: null,
    longest_story_sec: null,
    fluff_caught: null,
    commitment: null,
    prospect_talk_share: null,
    rep_questions: null,
    you_focus: null,
    source: 'notes',
    rules_version: RULES_VERSION,
    unsure: '[]',
    sources: '{}',
    timeline_json: null,
    excluded: 0,
    extracted_at: '2026-09-28T19:30:00.000Z',
    ...over,
  });
}

test('the store: marking again replaces, unmark takes it back, people counted once', async () => {
  const store = d1ConversationStore(db);
  await logCall('t1', 'dallas', 'The issue is not software.');
  const mark = {
    kind: 'call' as const,
    ref_id: 't1',
    contact_id: 'dallas',
    who: 'Dallas',
    learned: null,
    at: '2026-09-28T19:24:30.000Z',
  };
  await store.mark(mark, '2026-10-07T00:00:00.000Z');
  await store.mark({ ...mark, learned: 'People, not software' }, '2026-10-07T00:01:00.000Z');
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(
    { ...(await store.get('call', 't1')) },
    { ...mark, learned: 'People, not software', notes: 'The issue is not software.' }
  );

  await store.mark(
    { ...mark, kind: 'interview', ref_id: 'm1', at: '2026-10-02T15:00:00.000Z' },
    '2026-10-07T00:02:00.000Z'
  );
  const summary = await store.summary();
  assert.equal(summary.people, 1, 'a call and an interview with Dallas: one person');
  assert.equal(summary.latest?.ref_id, 'm1');

  await store.unmark('interview', 'm1');
  await store.unmark('call', 't1');
  assert.deepEqual(await store.summary(), { people: 0, latest: null });
});

test('candidates: calls that reached them, not left out, not counted yet, newest first, with their notes', async () => {
  const store = d1ConversationStore(db);
  await logCall('t1', 'c-t1', 'The issue is not software.');
  await logCall('t2', 'c-t2', 'Busy, call back.');
  await read('t1');
  await read('t2', { at_sec: Date.parse('2026-10-07T18:52:23Z') / 1000 });
  await read('t3', { reached: 0 });
  await read('t4');
  await d1CallInsightStore(db).setExcluded('t4', true); // a test call
  assert.deepEqual(
    (await store.candidates(10)).map((k) => ({ ...k })),
    [
      {
        kind: 'call',
        ref_id: 't2',
        contact_id: 'c-t2',
        who: 'Contact t2 at Co',
        at_sec: Date.parse('2026-10-07T18:52:23Z') / 1000,
        duration_sec: 543,
        notes: 'Busy, call back.',
      },
      {
        kind: 'call',
        ref_id: 't1',
        contact_id: 'c-t1',
        who: 'Contact t1 at Co',
        at_sec: Date.parse('2026-09-28T19:14:19Z') / 1000,
        duration_sec: 543,
        notes: 'The issue is not software.',
      },
    ]
  );
  await store.mark({ kind: 'call', ref_id: 't1', contact_id: 'c-t1', who: 'x', learned: null, at: 'x' }, 'x');
  assert.deepEqual(
    (await store.candidates(10)).map((k) => k.ref_id),
    ['t2']
  );
  await logCall('t5', 'c-t5', 'Hi', 'whatsapp_message');
  assert.equal(await callsLogged(db), 2, 'a WhatsApp message isn’t a call');
});

test('Count and Uncount on Coaching, through the app: D1 only, back to the card', async () => {
  const { default: app } = await import('../src/index.ts');
  await logCall('t1', 'c-t1', 'The issue is not software.');
  await read('t1');
  await read('t3', { reached: 0 });
  const post = (body: Record<string, string>) =>
    app.request(
      'http://localhost/coaching/conversations',
      {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      },
      {
        DB: db,
        DEV_BYPASS_ACCESS: 'true',
        TZ: 'America/Denver',
        HUBSPOT_ACCESS_TOKEN: 'unused',
      } as unknown as AppEnv['Bindings']
    );
  const counted = await post({ kind: 'call', ref: 't1', learned: 'People, not software' });
  assert.equal(counted.status, 303);
  assert.equal(counted.headers.get('Location'), '/coaching#conversations');
  const row = await d1ConversationStore(db).get('call', 't1');
  assert.equal(row?.who, 'Contact t1 at Co');
  assert.equal(row?.at, '2026-09-28T19:14:19.000Z', 'when the call was made');
  assert.equal(row?.learned, 'People, not software');

  const refused = await post({ kind: 'call', ref: 't3' });
  assert.equal(refused.status, 404, 'a call that didn’t reach them');
  assert.equal(await d1ConversationStore(db).get('call', 't3'), null);

  const uncounted = await post({ kind: 'call', ref: 't1', on: '0' });
  assert.equal(uncounted.status, 303);
  assert.equal(await d1ConversationStore(db).get('call', 't1'), null);
});

test('the today strip: the count toward 100, and the last thing learned', async () => {
  const counts = { emailsSent: 0, peopleCalled: 0, interviews: null };
  const none = String(await todayStrip({ ...counts, conversations: { people: 0, latest: null } }));
  assert.match(none, /0<span class="of"> \/ 100/);
  assert.match(none, /None counted yet/);
  const one = String(
    await todayStrip({
      ...counts,
      conversations: {
        people: 1,
        latest: row({ ref_id: 't1', who: 'Dallas Peery at Wanship Transportation', learned: 'People, not software' }),
      },
    })
  );
  assert.match(one, /1<span class="of"> \/ 100/);
  assert.match(one, /Dallas Peery: “People, not software”/);
});

test('Coaching’s card: the count, the pace, each one with its line, and the calls to count', async () => {
  const report = coachingReport([], 'America/Denver');
  const page = String(
    await coachingPage(
      {
        settings: { timeZone: 'America/Denver' } as never,
        conversations: conversationReport(
          [
            row({
              ref_id: 't1',
              contact_id: 'dallas',
              who: 'Dallas Peery at Wanship Transportation',
              learned: 'People, not software',
            }),
          ],
          13
        ),
        candidates: [
          {
            kind: 'call',
            ref_id: 't2',
            contact_id: 'c-t2',
            who: 'Jeremy Hallows at Overland',
            at_sec: 1791399143,
            duration_sec: 312,
            notes: 'Uses a spreadsheet for loads. Call back.',
          },
        ],
        report,
        bookings: bookingReport([], 0),
        funnel: callFunnel(report, [], 0),
        interviews: [],
        momTest: momTestReport([], []),
        talk: talkReport([]),
        strips: [],
        unread: 0,
      },
      'rep@example.com'
    )
  );
  assert.match(page, /Real conversations: 1 \/ 100/);
  assert.match(
    page,
    /About 1 in 13 calls you’ve logged got you one\.\s+At that rate, the other 99 take about 1,287 more calls/
  );
  assert.match(page, /<a href="\/calls\/t1">Dallas Peery at Wanship Transportation<\/a>/);
  assert.match(page, /“People, not software”/);
  assert.match(page, /Reached them, not counted yet/);
  assert.match(page, /value="Uses a spreadsheet for loads\."/, 'the notes’ first sentence, ready to keep or change');
});

test('the log forms’ box counts through the pages: a call and an interview, with the line', async () => {
  const { default: app } = await import('../src/index.ts');
  const hs = new FakeHubSpot();
  const earlier = new Date(Date.now() - 3_600_000).toISOString();
  hs.put('tasks', '1', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Call: Acme',
    hs_timestamp: earlier,
  });
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Díaz' });
  hs.put('companies', '20', { name: 'Acme' });
  hs.link('tasks', '1', 'contacts', '10');
  hs.link('tasks', '1', 'companies', '20');
  hs.put('meetings', 'm1', {
    hs_meeting_title: 'Interview',
    hs_meeting_start_time: earlier,
    hs_meeting_end_time: new Date(Date.parse(earlier) + 1_800_000).toISOString(),
    hs_meeting_outcome: 'SCHEDULED',
  });
  hs.link('meetings', 'm1', 'contacts', '10');
  hs.link('meetings', 'm1', 'companies', '20');
  const background: Promise<unknown>[] = [];
  const post = async (path: string, body: Record<string, string>) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = hubspotApi(hs) as unknown as typeof fetch;
    try {
      const res = await app.request(
        `http://localhost${path}`,
        {
          method: 'POST',
          headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(body),
        },
        {
          DB: db,
          DEV_BYPASS_ACCESS: 'true',
          TZ: 'America/Denver',
          HUBSPOT_ACCESS_TOKEN: 'hs',
          PUBLIC_BASE_URL: 'https://app.example',
        } as unknown as AppEnv['Bindings'],
        { waitUntil: (p: Promise<unknown>) => background.push(p), passThroughOnException() {} } as never
      );
      await Promise.all(background.splice(0));
      return res;
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const call = await post('/calls/1/log', {
    outcome: 'connected',
    notes: 'Quotes by phone.',
    next_type: '',
    conversation: '1',
    learned: 'Quoting takes an hour a load',
  });
  assert.equal(call.status, 303, await call.text());
  const counted = await d1ConversationStore(db).get('call', '1');
  assert.equal(counted?.who, 'Ana Díaz at Acme');
  assert.equal(counted?.learned, 'Quoting takes an hour a load');

  const interview = await post('/meetings/m1/log', {
    start: String(Date.parse(earlier)),
    outcome: 'COMPLETED',
    notes: 'Dispatch lives in a group text.',
    next_type: '',
    conversation: '1',
    learned: 'Dispatch lives in a group text',
  });
  assert.equal(interview.status, 303, await interview.text());
  assert.equal((await d1ConversationStore(db).get('interview', 'm1'))?.learned, 'Dispatch lives in a group text');
  assert.equal((await d1ConversationStore(db).summary()).people, 1, 'Ana, twice: one person');
});

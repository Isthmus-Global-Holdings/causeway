// The app's real SQL (src/lib/db.ts) against the real migrations, on SQLite.
// These are the queries the never-send-twice and never-duplicate-a-task
// guarantees rest on.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  d1ConfirmationStore,
  d1SentEmailStore,
  deleteSetting,
  engagementByContact,
  findByOpenToken,
  findLink,
  getSettings,
  insertAudit,
  missingMigration,
  recentlyWorked,
  recentSends,
  recordTrackingEvent,
  setSetting,
  type NewSentEmail,
} from '../src/lib/db.ts';
import { toTaskBodyHtml } from '../src/lib/richtext.ts';
import { HubSpotApiError, missingScopes } from '../src/lib/hubspot.ts';
import { resolveUnknownSend, runSend, SendOutcomeUnknownError } from '../src/workflows/send-email.ts';
import { noteOnce } from '../src/workflows/tracking-notes.ts';
import { FakeHubSpot } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

let db: D1Database;
beforeEach(() => {
  db = sqliteD1();
});

const email = (overrides: Partial<NewSentEmail> = {}): NewSentEmail => ({
  emailTaskId: '1',
  contactId: '10',
  companyId: '20',
  fromEmail: 'isthmusglobalholdings@gmail.com',
  toEmail: 'ana@acme.test',
  subject: 'Quick question',
  html: '<div dir="ltr">Hi</div>',
  openToken: 'a'.repeat(32),
  links: [{ token: 'b'.repeat(32), url: 'https://linkedin.com/in/anelcanto' }],
  trackOpens: false,
  trackClicks: true,
  ...overrides,
});

// --- sent_emails: the guard against sending twice ---

test('beginSend: the first caller wins, a second is refused', async () => {
  const store = d1SentEmailStore(db);
  assert.equal(await store.beginSend(email(), 1000, 60), true);
  assert.equal(await store.beginSend(email({ subject: 'other' }), 1000, 60), false);
  const row = await store.get('1');
  assert.equal(row?.status, 'sending');
  assert.equal(row?.subject, 'Quick question');
});

test('markSent records the Gmail id and time', async () => {
  const store = d1SentEmailStore(db);
  await store.beginSend(email(), 1000, 60);
  await store.markSent('1', 'gmail-1', '2026-09-25T15:00:00.000Z');
  const row = await store.get('1');
  assert.deepEqual([row?.status, row?.gmail_message_id, row?.sent_at], ['sent', 'gmail-1', '2026-09-25T15:00:00.000Z']);
});

test("markUnknownIfStale: only a 'sending' row whose lock has expired", async () => {
  const store = d1SentEmailStore(db);
  await store.beginSend(email(), 1000, 60); // lock until 1060
  assert.equal(await store.markUnknownIfStale('1', 1030), false, 'lock still live');
  assert.equal(await store.markUnknownIfStale('1', 1061), true);
  assert.equal((await store.get('1'))?.status, 'unknown');
  assert.equal(await store.markUnknownIfStale('1', 5000), false, 'already unknown');

  await store.beginSend(email({ emailTaskId: '2', openToken: 'c'.repeat(32), links: [] }), 1000, 60);
  await store.markSent('2', 'g', 'now');
  assert.equal(await store.markUnknownIfStale('2', 5000), false, 'a sent row never becomes unknown');
});

test('markSentManually only resolves an unknown row', async () => {
  const store = d1SentEmailStore(db);
  await store.beginSend(email(), 1000, 60);
  await store.markSentManually('1', 't');
  assert.equal((await store.get('1'))?.status, 'sending', 'not unknown yet, so untouched');
  await store.markUnknownIfStale('1', 2000);
  await store.markSentManually('1', 't');
  assert.equal((await store.get('1'))?.status, 'sent');
});

test('discard only removes a row in the expected state, with its links', async () => {
  const store = d1SentEmailStore(db);
  await store.beginSend(email(), 1000, 60);
  await store.discard('1', 'unknown');
  assert.ok(await store.get('1'), "a 'sending' row survives discard('unknown')");
  assert.ok(await findLink(db, 'b'.repeat(32)));

  await store.discard('1', 'sending');
  assert.equal(await store.get('1'), null);
  assert.equal(await findLink(db, 'b'.repeat(32)), null, 'its tracked links go too');

  await store.beginSend(email(), 2000, 60);
  assert.ok(await store.get('1'), 'and the task can be sent again');
});

test('setLoggedEmail and per-send tracking flags are stored', async () => {
  const store = d1SentEmailStore(db);
  await store.beginSend(email({ trackOpens: false, trackClicks: false }), 1000, 60);
  await store.setLoggedEmail('1', 'hs-email-9');
  assert.equal((await store.get('1'))?.logged_email_id, 'hs-email-9');
  await store.markSent('1', 'g', '2026-09-25T15:00:00.000Z');
  const [recent] = await recentSends(db);
  assert.deepEqual([recent.track_opens, recent.track_clicks], [0, 0]);
});

// --- sent_confirmations: the guard against a second CALL task ---

test('confirmations: create is idempotent, the lock is exclusive until it expires', async () => {
  const store = d1ConfirmationStore(db);
  await store.create({ emailTaskId: '1', contactId: '10', companyId: null });
  await store.create({ emailTaskId: '1', contactId: '99', companyId: '99' });
  assert.equal((await store.get('1'))?.contact_id, '10', 'the first confirmation sticks');

  assert.equal(await store.acquireLock('1', 1000, 60), true);
  assert.equal(await store.acquireLock('1', 1030, 60), false, 'held');
  assert.equal(await store.acquireLock('1', 1061, 60), true, 'expired, so it can be taken over');
  await store.releaseLock('1');
  assert.equal(await store.acquireLock('1', 1062, 60), true, 'released');

  await store.markCompleted('1', 'done-at');
  await store.setCallTask('1', 'call-5');
  const row = await store.get('1');
  assert.deepEqual([row?.completed_at, row?.call_task_id], ['done-at', 'call-5']);
});

test('recentSends: the follow-up call task, and the latest call logged to the contact since the send', async () => {
  const store = d1SentEmailStore(db);
  const confirmations = d1ConfirmationStore(db);
  const logCall = (taskId: string, contactId: string, outcome: string, at: string, next: string | null) =>
    db
      .prepare(
        `INSERT INTO call_logs (call_task_id, contact_id, title, outcome, notes, next_type, next_task_id, created_at)
         VALUES (?, ?, 'Call', ?, '', ?, ?, ?)`
      )
      .bind(taskId, contactId, outcome, next ? 'CALL' : null, next, at)
      .run();

  // 1: a follow-up call task, not called yet.
  await store.beginSend(email(), 1000, 60);
  await store.markSent('1', 'g', '2026-09-25T15:00:00.000Z');
  await confirmations.create({ emailTaskId: '1', contactId: '10', companyId: '20' });
  await confirmations.setCallTask('1', 'call-1');
  // 2: called twice since; the latest set up another call.
  await store.beginSend(email({ emailTaskId: '2', contactId: '11', openToken: 'c'.repeat(32), links: [] }), 1000, 60);
  await store.markSent('2', 'g', '2026-09-25T16:00:00.000Z');
  await logCall('call-2', '11', 'no_answer', '2026-09-26 15:00:00', 'call-3');
  await logCall('call-3', '11', 'left_voicemail', '2026-09-27 15:00:00', 'call-4');
  // 3: the only call was before the email.
  await store.beginSend(email({ emailTaskId: '3', contactId: '12', openToken: 'd'.repeat(32), links: [] }), 1000, 60);
  await store.markSent('3', 'g', '2026-09-25T17:00:00.000Z');
  await logCall('call-0', '12', 'connected', '2026-09-20 15:00:00', null);

  const rows = new Map((await recentSends(db)).map((r) => [r.email_task_id, r]));
  const pick = (id: string) => {
    const r = rows.get(id);
    return [r?.contact_id, r?.call_task_id, r?.called_outcome, r?.next_call_task_id];
  };
  assert.deepEqual(pick('1'), ['10', 'call-1', null, null]);
  assert.deepEqual(pick('2'), ['11', null, 'left_voicemail', 'call-4']);
  assert.equal(rows.get('2')?.called_at, '2026-09-27 15:00:00');
  assert.deepEqual(pick('3'), ['12', null, null, null], 'a call before the email is not a call back');
});

// --- tracking ---

test('tracking: pixel lookups need a sent email; clicks count per link', async () => {
  const store = d1SentEmailStore(db);
  await store.beginSend(email(), 1000, 60);
  assert.equal(await findByOpenToken(db, 'a'.repeat(32)), null, 'not sent yet');
  await store.markSent('1', 'g', '2026-09-25T15:00:00.000Z');
  assert.equal((await findByOpenToken(db, 'a'.repeat(32)))?.email_task_id, '1');
  assert.equal((await findLink(db, 'b'.repeat(32)))?.url, 'https://linkedin.com/in/anelcanto');

  assert.equal(await recordTrackingEvent(db, { emailTaskId: '1', kind: 'open' }), 0);
  assert.equal(await recordTrackingEvent(db, { emailTaskId: '1', kind: 'open' }), 1);
  assert.equal(await recordTrackingEvent(db, { emailTaskId: '1', kind: 'click', url: 'https://a' }), 0);
  assert.equal(await recordTrackingEvent(db, { emailTaskId: '1', kind: 'click', url: 'https://b' }), 0, 'another link');
  assert.equal(await recordTrackingEvent(db, { emailTaskId: '1', kind: 'click', url: 'https://a' }), 1);

  const [recent] = await recentSends(db);
  assert.deepEqual([recent.opens, recent.clicks], [2, 3]);
  assert.match(recent.last_open_at ?? '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'when the last open was');
});

test("engagementByContact sums each contact's opens and clicks over the emails sent them", async () => {
  const store = d1SentEmailStore(db);
  await store.beginSend(email(), 1000, 60);
  await store.markSent('1', 'g', '2026-09-24T15:00:00.000Z');
  await store.beginSend(email({ emailTaskId: '2', openToken: 'c'.repeat(32), links: [] }), 1000, 60);
  await store.markSent('2', 'g', '2026-09-25T15:00:00.000Z');
  await store.beginSend(email({ emailTaskId: '3', contactId: '11', openToken: 'd'.repeat(32), links: [] }), 1000, 60);
  await store.markSent('3', 'g', '2026-09-25T15:00:00.000Z');
  await store.beginSend(email({ emailTaskId: '4', contactId: '12', openToken: 'e'.repeat(32), links: [] }), 1000, 60);
  await recordTrackingEvent(db, { emailTaskId: '1', kind: 'click', url: 'https://a' });
  await recordTrackingEvent(db, { emailTaskId: '2', kind: 'open' });
  await recordTrackingEvent(db, { emailTaskId: '2', kind: 'click', url: 'https://a' });
  await recordTrackingEvent(db, { emailTaskId: '4', kind: 'click', url: 'https://a' });

  await db.prepare(`UPDATE tracking_events SET created_at = '2026-09-25 18:30:00' WHERE kind = 'open'`).run();

  const byContact = await engagementByContact(db);
  assert.deepEqual(
    byContact.get('10'),
    { opens: 1, clicks: 2, lastOpenAt: Date.parse('2026-09-25T18:30:00Z') },
    'both emails to contact 10; SQLite times are UTC'
  );
  assert.equal(byContact.has('11'), false, 'sent, but nothing tracked');
  assert.equal(byContact.has('12'), false, 'never marked sent');
});

test('recentlyWorked: emails sent, marked sent or dropped (a failed drop is still open)', async () => {
  await d1SentEmailStore(db).beginSend(email({ emailTaskId: '1' }), Math.floor(Date.now() / 1000), 60);
  await d1ConfirmationStore(db).create({ emailTaskId: '2', contactId: '10', companyId: null });
  const drop = { actor: 'rep@x', workflow: 'task-action', action: 'drop email task' } as const;
  await insertAudit(db, { ...drop, taskId: '3', outcome: 'success' });
  await insertAudit(db, { ...drop, taskId: '4', outcome: 'failed', error: 'HubSpot 502' });
  assert.deepEqual([...(await recentlyWorked(db, 'email'))].sort(), ['1', '2', '3']);
});

test('settings: upsert, read back, delete', async () => {
  await setSetting(db, 'signature_html', 'v1');
  await setSetting(db, 'signature_html', 'v2');
  await setSetting(db, 'track_opens', '0');
  assert.deepEqual(await getSettings(db), { signature_html: 'v2', track_opens: '0' });
  await deleteSetting(db, 'signature_html');
  assert.deepEqual(await getSettings(db), { track_opens: '0' });
});

// --- the whole send against the real SQL ---

test('runSend on real SQL: one Gmail send, one CALL task, however often it is clicked', async () => {
  const hs = new FakeHubSpot();
  hs.put('tasks', '1', {
    hs_task_type: 'EMAIL',
    hs_task_status: 'NOT_STARTED',
    hs_task_body: toTaskBodyHtml('Hi there', 'Hi Ana,\n\nThanks,\nAnel'),
  });
  hs.put('contacts', '10', { firstname: 'Ana', email: 'ana@acme.test' });
  hs.link('tasks', '1', 'contacts', '10');
  const sent: string[] = [];
  const deps = {
    hs,
    mailer: {
      fromEmail: 'isthmusglobalholdings@gmail.com',
      send: async (raw: string) => (sent.push(raw), { id: `g${sent.length}` }),
    },
    sent: d1SentEmailStore(db),
    confirmations: d1ConfirmationStore(db),
  };
  const opts = {
    now: Date.parse('2026-09-25T15:00:00Z'),
    timeZone: 'America/Panama',
    baseUrl: 'https://app.example',
    fromName: 'Anel Canto',
  };

  await runSend(deps, '1', null, opts);
  await runSend(deps, '1', null, opts);
  await Promise.all([runSend(deps, '1', null, opts), runSend(deps, '1', null, opts)]);
  assert.equal(sent.length, 1);
  assert.equal(hs.created.length, 1);
  assert.equal(hs.objects.get('tasks/1')!.properties.hs_task_status, 'COMPLETED');
});

test('runSend on real SQL: a crash mid-send becomes "unknown", never a resend', async () => {
  const hs = new FakeHubSpot();
  hs.put('tasks', '1', { hs_task_type: 'EMAIL', hs_task_body: toTaskBodyHtml('s', 'b') });
  hs.put('contacts', '10', { email: 'ana@acme.test' });
  hs.link('tasks', '1', 'contacts', '10');
  let calls = 0;
  const deps = {
    hs,
    mailer: {
      fromEmail: 'me@example.com',
      send: async () => {
        calls++;
        throw new Error('socket hang up');
      },
    },
    sent: d1SentEmailStore(db),
    confirmations: d1ConfirmationStore(db),
  };
  const at = (ms: number) => ({ now: ms, timeZone: 'America/Panama', baseUrl: 'https://app.example', fromName: null });
  const t0 = Date.parse('2026-09-25T15:00:00Z');

  await assert.rejects(runSend(deps, '1', null, at(t0)), /socket hang up/);
  await assert.rejects(runSend(deps, '1', null, at(t0 + 5 * 60_000)), SendOutcomeUnknownError);
  assert.equal(calls, 1, 'Gmail was never called a second time');
});

test('the log marker: one attempt only, cleared only while nothing was logged', async () => {
  const store = d1SentEmailStore(db);
  await store.beginSend(email(), 1000, 60);
  assert.equal(await store.markLogAttempted('1', 't1'), true);
  assert.equal(await store.markLogAttempted('1', 't2'), false);
  await store.clearLogAttempt('1');
  assert.equal(await store.markLogAttempted('1', 't3'), true, 'cleared after a definite rejection');
  await store.setLoggedEmail('1', 'hs-1');
  await store.clearLogAttempt('1');
  assert.equal((await store.get('1'))?.log_attempted_at, 't3', 'never cleared once logged');
});

test('tracking notes: a definite HubSpot rejection is retried, an ambiguous failure is not duplicated', async () => {
  let writes = 0;
  const rejected = async () => {
    writes++;
    throw new HubSpotApiError(429, 'rate limited', '/crm/objects/2026-09/notes');
  };
  const lost = async () => {
    writes++;
    throw new Error('connection reset'); // HubSpot may have created it
  };
  const working = async () => {
    writes++;
  };

  const open1 = { emailTaskId: '1', kind: 'open' as const, url: null };
  await assert.rejects(noteOnce(db, open1, rejected), HubSpotApiError);
  assert.equal(await noteOnce(db, open1, working), 'written', 'retried on the next open');
  assert.equal(await noteOnce(db, open1, working), 'already-noted');

  const open2 = { emailTaskId: '2', kind: 'open' as const, url: null };
  await assert.rejects(noteOnce(db, open2, lost), /connection reset/);
  assert.equal(await noteOnce(db, open2, working), 'already-noted', 'claim kept: no duplicate note');
  assert.equal(writes, 3);

  const a = { emailTaskId: '1', kind: 'click' as const, url: 'https://a' };
  const b = { emailTaskId: '1', kind: 'click' as const, url: 'https://b' };
  assert.equal(await noteOnce(db, a, working), 'written');
  assert.equal(await noteOnce(db, b, working), 'written', 'each link gets its own note');
  assert.equal(await noteOnce(db, a, working), 'already-noted');
});

test('resolving an unknown send acts on the state, not on a stale button', async () => {
  const store = d1SentEmailStore(db);
  const unknown = async (id: string) => {
    await store.beginSend(email({ emailTaskId: id, openToken: id.repeat(32).slice(0, 32), links: [] }), 1000, 60);
    await store.markUnknownIfStale(id, 2000);
  };

  await unknown('1');
  assert.equal(await resolveUnknownSend(store, '1', true, 3000), 'sent');
  assert.equal(await resolveUnknownSend(store, '1', true, 3000), 'sent', 'a repeat "went out" just resumes');

  await unknown('2');
  assert.equal(await resolveUnknownSend(store, '2', false, 3000), 'cleared');
  // The other tab, still showing the old page, now says "it's in Sent".
  assert.equal(
    await resolveUnknownSend(store, '2', true, 3000),
    'cleared',
    'no row to resume: the route must not send'
  );

  await store.beginSend(email({ emailTaskId: '3', openToken: 'd'.repeat(32), links: [] }), 1000, 60);
  assert.equal(await resolveUnknownSend(store, '3', true, 1010), 'pending', 'a live send is left alone');
  assert.equal((await store.get('3'))?.status, 'sending');
});

test('missingMigration picks out the missing column or table from a D1 error', () => {
  const d1 = new Error('D1_ERROR: no such column: mode at offset 83: SQLITE_ERROR', {
    cause: new Error('no such column: mode at offset 83: SQLITE_ERROR'),
  });
  assert.equal(missingMigration(d1), 'no such column: mode');
  assert.equal(missingMigration(new Error('D1_ERROR: no such table: inbound_calls')), 'no such table: inbound_calls');
  assert.equal(missingMigration(new Error('UNIQUE constraint failed')), null);
  assert.equal(missingMigration('not an error'), null);
});

test('missingMigration recognises the error from a real query against an older schema', async () => {
  const err = await sqliteD1()
    .prepare('SELECT not_migrated_yet FROM settings')
    .all()
    .then(
      () => null,
      (e: unknown) => e
    );
  assert.equal(missingMigration(err), 'no such column: not_migrated_yet');
});

test('missingScopes reads the scopes a HubSpot 403 asks for', () => {
  const body = JSON.stringify({
    category: 'MISSING_SCOPES',
    errors: [{ context: { requiredGranularScopes: ['crm.objects.emails.read', 'sales-email-read'] } }],
  });
  assert.deepEqual(missingScopes(new HubSpotApiError(403, body, '/x')), [
    'crm.objects.emails.read',
    'sales-email-read',
  ]);
  assert.equal(missingScopes(new HubSpotApiError(403, '{"category":"OTHER"}', '/x')), null);
  assert.equal(missingScopes(new HubSpotApiError(403, 'not json', '/x')), null);
  assert.equal(missingScopes(new HubSpotApiError(500, body, '/x')), null);
});

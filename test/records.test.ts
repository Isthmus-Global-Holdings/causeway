// Contacts and companies on their own pages: search, what each page loads,
// Call and Email opening (or creating) the contact's task, and the calls
// logged recently.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { d1ContactTaskLockStore, recentCallLogs, type ContactTaskLockStore } from '../src/lib/db.ts';
import type { AppEnv } from '../src/types.ts';
import { companyPage, contactPage } from '../src/views/records.ts';
import { loadCompanyRecord, loadContactRecord, searchContactList, taskForContact } from '../src/workflows/records.ts';
import { FakeHubSpot } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const NOW = Date.parse('2026-09-28T15:00:00Z');
const TZ = 'America/Denver';

let hs: FakeHubSpot;
let db: D1Database;
let locks: ContactTaskLockStore;

beforeEach(() => {
  hs = new FakeHubSpot();
  db = sqliteD1();
  locks = d1ContactTaskLockStore(db);
  hs.put('contacts', 'c1', {
    firstname: 'Dana',
    lastname: 'Reyes',
    email: 'dana@granger.test',
    jobtitle: 'Owner',
    phone: '(801) 555-0130',
    mobilephone: null,
    hubspot_owner_id: '42',
    address: '2150 S 1300 W',
    city: 'Salt Lake City',
    state: 'UT',
    zip: '84119',
    country: 'United States',
  });
  hs.put('companies', 'co1', {
    name: 'Granger Hauling',
    domain: 'granger.test',
    phone: '(801) 555-0100',
    description: 'Contact: Dana Reyes (Owner). 30 trucks. Fit: STRONG - owner-run asset carrier.',
    address: '1 Depot Rd',
    city: 'Ogden',
    state: 'UT',
  });
  hs.link('contacts', 'c1', 'companies', 'co1');
  hs.link('companies', 'co1', 'contacts', 'c1');
});

function task(id: string, type: 'CALL' | 'EMAIL', status: string, due: string) {
  hs.put('tasks', id, {
    hs_task_type: type,
    hs_task_status: status,
    hs_task_subject: `${type} ${id}`,
    hs_timestamp: due,
  });
  hs.link('contacts', 'c1', 'tasks', id);
}

test('Call opens the contact’s open call task, soonest due, without creating one', async () => {
  task('t-done', 'CALL', 'COMPLETED', '2026-09-01T15:00:00Z');
  task('t-later', 'CALL', 'NOT_STARTED', '2026-10-02T15:00:00Z');
  task('t-soon', 'CALL', 'NOT_STARTED', '2026-09-29T15:00:00Z');
  task('t-email', 'EMAIL', 'NOT_STARTED', '2026-09-20T15:00:00Z');
  const result = await taskForContact({ hs, locks }, 'c1', 'CALL', { now: NOW });
  assert.deepEqual(result, { taskId: 't-soon', created: false });
  assert.equal(hs.created.length, 0);
});

test('with no open task, one is created due now, for the owner, on the contact and company, and reused after', async () => {
  task('t-done', 'EMAIL', 'COMPLETED', '2026-09-01T15:00:00Z');
  task('t-dropped', 'EMAIL', 'DEFERRED', '2026-09-02T15:00:00Z');
  const first = await taskForContact({ hs, locks }, 'c1', 'EMAIL', { now: NOW });
  assert.equal(first.created, true);
  assert.equal(hs.created.length, 1);
  assert.deepEqual(hs.created[0].properties, {
    hs_task_type: 'EMAIL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Email: Granger Hauling (Dana Reyes)',
    hs_timestamp: new Date(NOW).toISOString(),
    hubspot_owner_id: '42',
  });
  assert.deepEqual(hs.created[0].links, { contactId: 'c1', companyId: 'co1' });

  // A second click (or a retry after HubSpot answered too late) finds it.
  const again = await taskForContact({ hs, locks }, 'c1', 'EMAIL', { now: NOW + 5_000 });
  assert.deepEqual(again, { taskId: first.taskId, created: false });
  assert.equal(hs.created.length, 1);
});

test('the company page’s company is used only when the contact belongs to it', async () => {
  hs.put('companies', 'co2', { name: 'Second Co' });
  hs.link('contacts', 'c1', 'companies', 'co2');
  await taskForContact({ hs, locks }, 'c1', 'CALL', { now: NOW, companyId: 'co2' });
  assert.equal(hs.created[0].links.companyId, 'co2');
  assert.match(hs.created[0].properties.hs_task_subject, /^Call: Second Co/);

  hs.objects.delete('tasks/900');
  hs.links.set('contacts/c1/tasks', []);
  await taskForContact({ hs, locks }, 'c1', 'CALL', { now: NOW, companyId: 'someone-elses' });
  assert.equal(hs.created[1].links.companyId, 'co1');
});

test('Email with no address and Call with no dialable number are refused, and the lock is freed', async () => {
  hs.put('contacts', 'c2', { firstname: 'No', lastname: 'Details', email: '', phone: 'unknown' });
  await assert.rejects(taskForContact({ hs, locks }, 'c2', 'EMAIL', { now: NOW }), /no email address/);
  await assert.rejects(taskForContact({ hs, locks }, 'c2', 'CALL', { now: NOW }), /No number the app can dial/);
  assert.equal(hs.created.length, 0);
  assert.notEqual(await locks.acquire('c2', 'CALL', NOW / 1000, 30), null, 'released after the refusal');
});

test('the company line counts as a number to call', async () => {
  hs.put('contacts', 'c3', { firstname: 'Desk', lastname: 'Only', phone: null, mobilephone: null });
  hs.link('contacts', 'c3', 'companies', 'co1');
  const result = await taskForContact({ hs, locks }, 'c3', 'CALL', { now: NOW });
  assert.equal(result.created, true);
});

test('a second click while the first is still opening the task is turned away', async () => {
  const nowSec = NOW / 1000;
  assert.notEqual(await locks.acquire('c1', 'CALL', nowSec, 30), null);
  await assert.rejects(
    taskForContact({ hs, locks }, 'c1', 'CALL', { now: NOW }),
    (err: Error & { status?: number }) => err.status === 409 && /Already opening a call task/.test(err.message)
  );
  assert.equal(hs.created.length, 0);
  // The other type isn't held, and a lock left behind expires.
  assert.equal((await taskForContact({ hs, locks }, 'c1', 'EMAIL', { now: NOW })).created, true);
  assert.equal((await taskForContact({ hs, locks }, 'c1', 'CALL', { now: NOW + 31_000 })).created, true);
});

test('a run that outlasted its lock doesn’t free the lock a later run took', async () => {
  const nowSec = NOW / 1000;
  const slow = await locks.acquire('c1', 'CALL', nowSec, 30);
  assert.notEqual(slow, null);
  const later = await locks.acquire('c1', 'CALL', nowSec + 31, 30);
  assert.notEqual(later, null, 'the slow run’s lock expired');
  await locks.release('c1', 'CALL', slow as number);
  assert.equal(await locks.acquire('c1', 'CALL', nowSec + 32, 30), null, 'the later run still holds it');
  await locks.release('c1', 'CALL', later as number);
  assert.notEqual(await locks.acquire('c1', 'CALL', nowSec + 33, 30), null);
});

test('the contact list is three rounds of requests, with each contact’s company', async () => {
  hs.put('contacts', 'c2', { firstname: 'Solo', lastname: 'Driver', email: 'solo@test' });
  const rows = await searchContactList(hs, 'dana');
  assert.deepEqual(
    rows.map((r) => [r.contact.id, r.company?.id ?? null]),
    [['c1', 'co1']]
  );
  assert.equal(hs.waves, 3);

  hs.waves = 0;
  const all = await searchContactList(hs, null);
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.contact.id === 'c2')?.company, null);
});

test('the contact page loads in two rounds: the contact with its links, then everything else', async () => {
  task('t-open', 'CALL', 'NOT_STARTED', '2026-09-29T15:00:00Z');
  task('t-done', 'CALL', 'COMPLETED', '2026-09-20T15:00:00Z');
  hs.put('notes', 'n1', { hs_note_body: '<p>Runs 30 trucks out of Ogden.</p>', hs_timestamp: '2026-09-10T15:00:00Z' });
  hs.link('contacts', 'c1', 'notes', 'n1');
  const record = await loadContactRecord(hs, 'c1');
  assert.equal(hs.waves, 2);
  assert.equal(record.company?.id, 'co1');
  assert.deepEqual(
    record.tasks.open.map((t) => t.id),
    ['t-open']
  );
  assert.deepEqual(
    record.tasks.completed.map((t) => t.id),
    ['t-done']
  );
  assert.equal(record.context.notes.items[0]?.text, 'Runs 30 trucks out of Ogden.');

  const page = String(
    await contactPage({ record, lastEmail: null, portalId: '247260710', timeZone: TZ }, 'rep@example.com')
  );
  assert.match(page, /2150 S 1300 W<br \/>Salt Lake City, UT 84119/);
  assert.match(page, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=2150%20S%201300%20W/);
  assert.match(page, /1 Depot Rd<br \/>Ogden, UT/, 'the company’s address too');
  assert.match(page, /Runs 30 trucks out of Ogden\./, 'HubSpot history');
  assert.match(page, /<span class="fit">STRONG<\/span>/);
  assert.match(page, /action="\/contacts\/c1\/call"[\s\S]*?Opens their open call task\./);
  assert.match(
    page,
    /<input type="hidden" name="then" value="whatsapp" \/>\s*<button type="submit" class="wide">WhatsApp<\/button>/,
    'WhatsApp opens their call task too'
  );
  assert.match(page, /action="\/contacts\/c1\/email"[\s\S]*?Creates an email task and opens its draft\./);
  assert.match(page, /href="\/calls\/t-done">Review</, 'a completed call can be opened again');
});

test('the company page lists its contacts, each with Call and Email for this company', async () => {
  hs.put('contacts', 'c2', { firstname: 'Ana', lastname: 'Beltran', email: null, phone: null });
  hs.link('companies', 'co1', 'contacts', 'c2');
  const record = await loadCompanyRecord(hs, 'co1');
  assert.deepEqual(
    record.contacts.map((c) => c.id),
    ['c2', 'c1'],
    'by name'
  );
  const page = String(await companyPage({ ...record, portalId: '247260710', timeZone: TZ }, 'rep@example.com'));
  assert.match(page, /name="company_id" value="co1"/);
  assert.match(page, /1 Depot Rd<br \/>Ogden, UT/);
  // Ana has no email, but the company line makes her callable.
  assert.match(page, /action="\/contacts\/c2\/call"><input[^>]*><button type="submit" class="primary" >Call/);
  assert.match(page, /action="\/contacts\/c2\/email"><input[^>]*><button type="submit" disabled>Email/);
});

test('recently logged calls come newest first, with the dial’s summary', async () => {
  const insert = (id: string, at: string, dialId: string | null) =>
    db
      .prepare(
        `INSERT INTO call_logs (call_task_id, contact_id, title, outcome, notes, dial_id, created_at)
         VALUES (?, 'c1', ?, 'connected', 'Talked dispatch.', ?, ?)`
      )
      .bind(id, `Call ${id}`, dialId, at)
      .run();
  await db
    .prepare(
      `INSERT INTO dials (id, task_id, contact_id, contact_label, to_number, from_number, rep_number, started_sec, summary)
       VALUES ('d1', 't2', 'c1', 'Dana', '+18015550130', '+13852557051', '+15555550100', 0, 'Wants a demo.')`
    )
    .run();
  await insert('t1', '2026-09-27 15:00:00', null);
  await insert('t2', '2026-09-28 15:00:00', 'd1');
  const recent = await recentCallLogs(db, 10);
  assert.deepEqual(
    recent.map((r) => [r.call_task_id, r.summary]),
    [
      ['t2', 'Wants a demo.'],
      ['t1', null],
    ]
  );
});

test('POST /contacts/:id/call lands on the call page of their open task', async () => {
  const { default: app } = await import('../src/index.ts');
  const realFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(new URL(url).pathname);
    if (url.includes('/crm/objects/2026-09/contacts/c1')) {
      return Response.json({
        id: 'c1',
        properties: { firstname: 'Dana', phone: '(801) 555-0130' },
        associations: { tasks: { results: [{ id: '77' }] } },
      });
    }
    if (url.endsWith('/crm/objects/2026-09/tasks/batch/read')) {
      return Response.json({
        results: [{ id: '77', properties: { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED' } }],
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as unknown as typeof fetch;
  try {
    const res = await app.request(
      'http://localhost/contacts/c1/call',
      {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({}),
      },
      {
        DB: db,
        DEV_BYPASS_ACCESS: 'true',
        TZ,
        HUBSPOT_ACCESS_TOKEN: 'test',
      } as unknown as AppEnv['Bindings']
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), '/calls/77');

    const whatsapp = await app.request(
      'http://localhost/contacts/c1/call',
      {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ then: 'whatsapp' }),
      },
      { DB: db, DEV_BYPASS_ACCESS: 'true', TZ, HUBSPOT_ACCESS_TOKEN: 'test' } as unknown as AppEnv['Bindings']
    );
    assert.equal(whatsapp.headers.get('Location'), '/calls/77#numbers', 'at the WhatsApp button');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(requests.slice(0, 2), ['/crm/objects/2026-09/contacts/c1', '/crm/objects/2026-09/tasks/batch/read']);
});

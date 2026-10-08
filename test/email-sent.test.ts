import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { FakeHubSpot, FakeStore } from './fakes.ts';
import { followUpSubject, runEmailSent } from '../src/workflows/email-sent.ts';

const NOW = Date.parse('2026-09-24T15:00:00Z'); // 10:00 in Panama
const opts = { now: NOW, timeZone: 'America/Panama' };
let hs: FakeHubSpot;
let store: FakeStore;

beforeEach(() => {
  hs = new FakeHubSpot();
  store = new FakeStore();
  hs.put('tasks', '1', {
    hs_task_type: 'EMAIL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Email Ana',
    hs_timestamp: '2026-09-24T19:30:00Z',
  });
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Díaz', email: 'ana@acme.test' });
  hs.put('companies', '20', { name: 'Acme', description: 'Fit: STRONG' });
  hs.link('tasks', '1', 'contacts', '10');
  hs.link('tasks', '1', 'companies', '20');
});

test("completes the email task and creates one CALL task due tomorrow at the email task's local time", async () => {
  const result = await runEmailSent(hs, store, '1', opts);

  assert.equal(hs.objects.get('tasks/1')!.properties.hs_task_status, 'COMPLETED');
  assert.equal(hs.created.length, 1);
  assert.deepEqual(hs.created[0], {
    properties: {
      hs_task_type: 'CALL',
      hs_task_status: 'NOT_STARTED',
      hs_task_subject: 'Call: Acme (Ana Díaz) — follow up on email',
      hs_timestamp: '2026-09-25T19:30:00.000Z', // 14:30 Panama, same as the email task
    },
    links: { contactId: '10', companyId: '20' },
  });
  assert.deepEqual(result, { callTaskId: '900', completedNow: true, callTaskCreated: true });
});

test('a second confirmation creates no second CALL task', async () => {
  await runEmailSent(hs, store, '1', opts);
  const again = await runEmailSent(hs, store, '1', opts);

  assert.equal(hs.created.length, 1);
  assert.deepEqual(again, { callTaskId: '900', completedNow: false, callTaskCreated: false });
});

test('after a failed create, a retry skips the completed step and creates the CALL task', async () => {
  hs.failNextCreate = true;
  await assert.rejects(runEmailSent(hs, store, '1', opts), /HubSpot 500/);
  assert.ok(store.rows.get('1')!.completed_at, 'step 1 recorded before the failure');
  assert.equal(store.rows.get('1')!.lock_until, null, 'lock released on failure');

  const retry = await runEmailSent(hs, store, '1', opts);
  assert.equal(retry.completedNow, false);
  assert.equal(retry.callTaskCreated, true);
  assert.equal(hs.created.length, 1);
});

test('reuses a CALL task that was created but never recorded in D1', async () => {
  // Simulate a run that died between HubSpot's create and the D1 write.
  const subject = followUpSubject('Acme', 'Ana Díaz');
  hs.put('tasks', '555', { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED', hs_task_subject: subject });
  hs.link('contacts', '10', 'tasks', '555');

  const result = await runEmailSent(hs, store, '1', opts);
  assert.equal(result.callTaskId, '555');
  assert.equal(result.callTaskCreated, false);
  assert.equal(hs.created.length, 0);
});

test('a contact with an open CALL task keeps that one, moved to the follow-up time', async () => {
  hs.put('tasks', '556', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Call: Acme (Ana Díaz)',
    hs_timestamp: '2026-09-24T13:00:00Z', // due this morning
  });
  hs.link('contacts', '10', 'tasks', '556');

  const result = await runEmailSent(hs, store, '1', opts);
  assert.deepEqual(result, { callTaskId: '556', completedNow: true, callTaskCreated: false });
  assert.equal(hs.created.length, 0);
  const call = hs.objects.get('tasks/556')!.properties;
  assert.equal(call.hs_timestamp, '2026-09-25T19:30:00.000Z', 'tomorrow, like a new follow-up');
  assert.equal(call.hs_task_subject, 'Call: Acme (Ana Díaz)', 'its subject is kept');
});

test('an open CALL task at a set time, or due later, stays put', async () => {
  hs.put('tasks', '557', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_timestamp: '2026-09-24T21:00:00Z',
    hs_task_reminders: String(Date.parse('2026-09-24T20:55:00Z')),
  });
  hs.link('contacts', '10', 'tasks', '557');
  await runEmailSent(hs, store, '1', opts);
  assert.equal(hs.objects.get('tasks/557')!.properties.hs_timestamp, '2026-09-24T21:00:00Z');

  hs.put('tasks', '4', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED' });
  hs.put('contacts', '12', { firstname: 'Bo' });
  hs.put('tasks', '558', { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED', hs_timestamp: '2026-10-01T15:00:00Z' });
  hs.link('tasks', '4', 'contacts', '12');
  hs.link('contacts', '12', 'tasks', '558');
  assert.equal((await runEmailSent(hs, store, '4', opts)).callTaskId, '558');
  assert.equal(hs.objects.get('tasks/558')!.properties.hs_timestamp, '2026-10-01T15:00:00Z');
  assert.equal(hs.created.length, 0);
});

test('a completed or dropped CALL task is not reused', async () => {
  hs.put('tasks', '559', { hs_task_type: 'CALL', hs_task_status: 'COMPLETED', hs_task_subject: 'Call: Acme' });
  hs.put('tasks', '560', { hs_task_type: 'CALL', hs_task_status: 'DEFERRED', hs_task_subject: 'Call: Acme' });
  hs.link('contacts', '10', 'tasks', '559');
  hs.link('contacts', '10', 'tasks', '560');

  const result = await runEmailSent(hs, store, '1', opts);
  assert.equal(result.callTaskCreated, true);
  assert.equal(hs.created.length, 1);
});

test('a concurrent run holding the lock is refused', async () => {
  await store.create({ emailTaskId: '1', contactId: '10', companyId: '20' });
  await store.acquireLock('1', Math.floor(NOW / 1000), 60);
  await assert.rejects(runEmailSent(hs, store, '1', opts), /already being processed/);
  assert.equal(hs.created.length, 0);
});

test('refuses non-EMAIL tasks', async () => {
  hs.put('tasks', '2', { hs_task_type: 'CALL', hs_task_status: 'NOT_STARTED' });
  await assert.rejects(runEmailSent(hs, store, '2', opts), /not EMAIL/);
});

test("the CALL task goes to the email task's owner", async () => {
  await hs.updateObject('tasks', '1', { hubspot_owner_id: '77' });
  await runEmailSent(hs, store, '1', opts);
  assert.equal(hs.created[0].properties.hubspot_owner_id, '77');
});

test('with no company anywhere, the subject names only the contact', async () => {
  hs.put('tasks', '3', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED' });
  hs.put('contacts', '11', { email: 'solo@example.test' });
  hs.link('tasks', '3', 'contacts', '11');

  await runEmailSent(hs, store, '3', opts);
  assert.equal(hs.created[0].properties.hs_task_subject, 'Call: solo@example.test — follow up on email');
  assert.equal(hs.created[0].properties.hs_timestamp, '2026-09-25T14:00:00.000Z', 'no email due time, so 09:00 Panama');
  assert.equal(hs.created[0].links.companyId, null);
});

test('Mark sent refuses a dropped task', async () => {
  await hs.updateObject('tasks', '1', { hs_task_status: 'DEFERRED' });
  await assert.rejects(runEmailSent(hs, store, '1', opts), /dropped/);
  assert.equal(hs.created.length, 0);
  assert.equal(await store.get('1'), null);
});

test('Mark sent re-checks after its D1 row exists, so a Drop landing just before is seen', async () => {
  const create = store.create.bind(store);
  store.create = async (r) => {
    await create(r);
    await hs.updateObject('tasks', '1', { hs_task_status: 'DEFERRED' });
  };
  await assert.rejects(runEmailSent(hs, store, '1', opts), /dropped/);
  assert.equal((await hs.getObject('tasks', '1')).properties.hs_task_status, 'DEFERRED');
  assert.equal(hs.created.length, 0);
});

test('running again re-completes a finished task that HubSpot shows open', async () => {
  await runEmailSent(hs, store, '1', opts);
  await hs.updateObject('tasks', '1', { hs_task_status: 'NOT_STARTED' });
  const again = await runEmailSent(hs, store, '1', opts);
  assert.equal(again.callTaskCreated, false);
  assert.equal((await hs.getObject('tasks', '1')).properties.hs_task_status, 'COMPLETED');
  assert.equal(hs.created.length, 1);
});

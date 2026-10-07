// How many HubSpot requests each page waits on, one after another. Pages were
// slow because every read waited for the one before it; these pin down the
// rounds (see FakeHubSpot.waves) so they don't creep back up.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createHubSpot } from '../src/lib/hubspot.ts';
import { toTaskBodyHtml } from '../src/lib/richtext.ts';
import { HISTORY_LINKS, loadCallContext } from '../src/workflows/call-context.ts';
import { loadDraftContext } from '../src/workflows/draft-email.ts';
import { contactMeetings, loadMeeting } from '../src/workflows/meeting-queue.ts';
import { loadTask } from '../src/workflows/parties.ts';
import { runSend, type Mailer } from '../src/workflows/send-email.ts';
import { FakeHubSpot, FakeSentStore, FakeStore } from './fakes.ts';

const NOW = Date.parse('2026-09-25T15:00:00Z');
const TZ = 'America/Panama';
let hs: FakeHubSpot;

beforeEach(() => {
  hs = new FakeHubSpot();
  hs.put('tasks', '1', {
    hs_task_type: 'CALL',
    hs_task_status: 'NOT_STARTED',
    hs_task_subject: 'Call: Acme (Ana Díaz)',
  });
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Díaz', email: 'ana@acme.test' });
  hs.put('companies', '20', { name: 'Acme' });
  hs.link('tasks', '1', 'contacts', '10');
  hs.link('tasks', '1', 'companies', '20');
  hs.put('notes', '30', { hs_note_body: 'Runs 12 trucks', hs_timestamp: '2026-09-01T12:00:00Z' });
  hs.link('contacts', '10', 'notes', '30');
  hs.put('calls', '40', { hs_call_title: 'Intro', hs_timestamp: '2026-09-02T12:00:00Z' });
  hs.link('contacts', '10', 'calls', '40');
  hs.put('meetings', '50', {
    hs_meeting_title: 'Interview',
    hs_meeting_start_time: '2026-09-28T15:00:00Z',
    hs_meeting_outcome: 'SCHEDULED',
  });
  hs.link('contacts', '10', 'meetings', '50');
  hs.link('meetings', '50', 'contacts', '10');
});

test('a task with its own company: the task, then the contact and company together', async () => {
  const parties = await loadTask(hs, '1', 'CALL');
  assert.equal(parties.contact.id, '10');
  assert.equal(parties.company?.id, '20');
  assert.equal(hs.waves, 2);
  assert.ok(!hs.reads.includes('associatedIds'));
});

test("a task without a company falls back to the contact's first company, one round later", async () => {
  hs.links.delete('tasks/1/companies');
  hs.link('contacts', '10', 'companies', '20');
  const parties = await loadTask(hs, '1', 'CALL');
  assert.equal(parties.company?.id, '20');
  assert.equal(hs.waves, 3);
});

test('the call page reads in three rounds: task, contact and company, then each history in one batch', async () => {
  const parties = await loadTask(hs, '1', 'CALL', [...HISTORY_LINKS, 'meetings']);
  assert.deepEqual(parties.related, { notes: ['30'], calls: ['40'], emails: [], meetings: ['50'] });

  const [context, interviews] = await Promise.all([
    loadCallContext(hs, parties),
    contactMeetings(hs, parties.contact.id, NOW, TZ, parties.related?.meetings),
  ]);
  assert.deepEqual(
    context.notes.items.map((n) => n.id),
    ['30']
  );
  assert.deepEqual(
    context.calls.items.map((n) => n.id),
    ['40']
  );
  assert.deepEqual(
    interviews.interviews.map((m) => m.meetingId),
    ['50']
  );
  assert.equal(hs.waves, 3);
  assert.ok(!hs.reads.includes('associatedIds'), 'no association lookups after the contact');
});

test('without the ids the history still loads, looking them up first', async () => {
  const parties = await loadTask(hs, '1', 'CALL');
  const context = await loadCallContext(hs, { contact: parties.contact });
  assert.equal(context.notes.items.length, 1);
  assert.ok(hs.reads.includes('associatedIds'));
});

test('an interview page reads the meeting, then the contact and company together', async () => {
  hs.link('meetings', '50', 'companies', '20');
  const parties = await loadMeeting(hs, '50', [...HISTORY_LINKS]);
  assert.equal(parties.contact.id, '10');
  assert.equal(parties.company?.id, '20');
  assert.deepEqual(parties.related?.notes, ['30']);
  assert.equal(hs.waves, 2);
});

test('the draft page reads in three rounds', async () => {
  hs.put('tasks', '2', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED' });
  hs.link('tasks', '2', 'contacts', '10');
  hs.link('tasks', '2', 'companies', '20');
  const ctx = await loadDraftContext(hs, '2');
  assert.deepEqual(
    ctx.notes.map((n) => n.id),
    ['30']
  );
  assert.equal(hs.waves, 3);
});

test('a send reads the task and contact once, and finds the follow-up without another lookup', async () => {
  hs.put('tasks', '2', {
    hs_task_type: 'EMAIL',
    hs_task_status: 'NOT_STARTED',
    hs_task_body: toTaskBodyHtml('Quick question', 'Hi Ana,\n\nThanks,\nAnel'),
  });
  hs.link('tasks', '2', 'contacts', '10');
  hs.link('tasks', '2', 'companies', '20');
  const mailer: Mailer = { fromEmail: 'rep@example.com', send: async () => ({ id: 'gmail-1' }) };
  const result = await runSend({ hs, mailer, sent: new FakeSentStore(), confirmations: new FakeStore() }, '2', null, {
    now: NOW,
    timeZone: TZ,
    baseUrl: 'https://app.example',
    fromName: null,
    newToken: () => 'tok',
  });
  assert.equal(result.callTaskCreated, true);
  assert.deepEqual(
    hs.reads.filter((r) => r === 'getWithAssociations'),
    ['getWithAssociations', 'getWithAssociations'],
    'the task and the contact, once each'
  );
  assert.ok(!hs.reads.includes('associatedIds'));
});

test("getWithAssociations reads links inline, once each, and pages the ones that don't fit", async () => {
  const urls: string[] = [];
  const fetchStub = (async (url: string) => {
    urls.push(url);
    if (url.includes('/associations/emails')) return Response.json({ results: [{ toObjectId: 7 }, { toObjectId: 8 }] });
    return Response.json({
      id: '10',
      properties: { firstname: 'Ana' },
      associations: {
        companies: {
          results: [
            { id: '20', type: 'contact_to_company' },
            { id: '20', type: 'contact_to_company_unlabeled' },
          ],
        },
        emails: { results: [{ id: '7' }], paging: { next: { after: '1' } } },
      },
    });
  }) as unknown as typeof fetch;
  const { object, associated } = await createHubSpot('token', fetchStub).getWithAssociations(
    'contacts',
    '10',
    ['firstname'],
    ['companies', 'emails', 'notes']
  );
  assert.deepEqual(object, { id: '10', properties: { firstname: 'Ana' } });
  assert.deepEqual(associated.get('companies'), ['20']);
  assert.deepEqual(associated.get('emails'), ['7', '8'], 'paged in full');
  assert.deepEqual(associated.get('notes'), [], 'none linked');
  assert.match(
    urls[0],
    /\/crm\/objects\/2026-09\/contacts\/10\?properties=firstname&associations=companies%2Cemails%2Cnotes$/
  );
  assert.match(urls[1], /\/crm\/objects\/2026-09\/contacts\/10\/associations\/emails\?limit=500$/);
});

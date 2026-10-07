import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { GoogleApiError } from '../src/lib/google.ts';
import { HubSpotApiError } from '../src/lib/hubspot.ts';
import { toTaskBodyHtml } from '../src/lib/richtext.ts';
import { resolveUnknownSend, runSend, SendOutcomeUnknownError, type Mailer } from '../src/workflows/send-email.ts';
import { FakeHubSpot, FakeSentStore, FakeStore } from './fakes.ts';

class FakeMailer implements Mailer {
  fromEmail = 'isthmusglobalholdings@gmail.com';
  sent: string[] = [];
  failWith: Error | null = null;
  async send(raw: string) {
    if (this.failWith) {
      const err = this.failWith;
      this.failWith = null;
      throw err;
    }
    this.sent.push(Buffer.from(raw, 'base64url').toString('utf8'));
    return { id: `gmail-${this.sent.length}` };
  }
}

const NOW = Date.parse('2026-09-25T15:00:00Z');
const SIGNATURE = '<b>Anel Canto</b><br><a href="https://isthmus.example">isthmus.example</a>';
let hs: FakeHubSpot;
let mailer: FakeMailer;
let sent: FakeSentStore;
let confirmations: FakeStore;
let tokens: number;

const opts = (now = NOW) => ({
  now,
  timeZone: 'America/Panama',
  baseUrl: 'https://app.example',
  fromName: 'Anel Canto',
  newToken: () => `tok${++tokens}`,
  boundary: 'b1',
  trackOpens: true,
  trackClicks: true,
  logToHubSpot: true,
});
const deps = () => ({ hs, mailer, sent, confirmations });

beforeEach(() => {
  hs = new FakeHubSpot();
  mailer = new FakeMailer();
  sent = new FakeSentStore();
  confirmations = new FakeStore();
  tokens = 0;
  hs.put('tasks', '1', {
    hs_task_type: 'EMAIL',
    hs_task_status: 'NOT_STARTED',
    hs_task_body: toTaskBodyHtml('Quick question about quoting', 'Hi Ana,\n\nThanks,\nAnel'),
    hs_timestamp: '2026-09-25T19:30:00Z',
  });
  hs.put('contacts', '10', { firstname: 'Ana', lastname: 'Diaz', email: 'ana@acme.test' });
  hs.put('companies', '20', { name: 'Acme', description: 'Fit: STRONG' });
  hs.link('tasks', '1', 'contacts', '10');
  hs.link('tasks', '1', 'companies', '20');
});

test('sends once from Gmail with tracking, logs the clean email, then runs the follow-up', async () => {
  const result = await runSend(deps(), '1', SIGNATURE, opts());

  assert.equal(mailer.sent.length, 1);
  const mime = mailer.sent[0];
  assert.match(mime, /^From: "Anel Canto" <isthmusglobalholdings@gmail\.com>/);
  assert.match(mime, /\r\nTo: "Ana Diaz" <ana@acme\.test>\r\n/);
  assert.match(mime, /\r\nSubject: Quick question about quoting\r\n/);
  const html = Buffer.from(mime.split('--b1')[2].split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.ok(html.includes('href="https://app.example/t/c/tok2"'), 'signature link is tracked');
  assert.ok(html.includes('<img src="https://app.example/t/o/tok1"'), 'pixel is present');

  // HubSpot gets the untracked version, so viewing the timeline isn't an "open".
  assert.equal(hs.loggedEmails.length, 1);
  const logged = hs.loggedEmails[0];
  assert.ok(!logged.email.html.includes('/t/o/') && !logged.email.html.includes('/t/c/'));
  assert.ok(logged.email.html.includes('href="https://isthmus.example"'));
  assert.deepEqual(logged.links, { contactId: '10', companyId: '20' });
  assert.deepEqual(logged.email.from, {
    email: 'isthmusglobalholdings@gmail.com',
    firstName: 'Anel',
    lastName: 'Canto',
  });

  assert.equal(hs.objects.get('tasks/1')!.properties.hs_task_status, 'COMPLETED');
  assert.equal(hs.created.length, 1);
  assert.equal(hs.created[0].properties.hs_task_type, 'CALL');
  assert.deepEqual(sent.links, [{ token: 'tok2', url: 'https://isthmus.example', emailTaskId: '1' }]);
  assert.equal(result.sentNow, true);
  assert.equal(result.gmailMessageId, 'gmail-1');
});

test('clicking Send again never sends a second email or creates a second CALL task', async () => {
  await runSend(deps(), '1', SIGNATURE, opts());
  const again = await runSend(deps(), '1', SIGNATURE, opts());
  assert.equal(mailer.sent.length, 1);
  assert.equal(hs.loggedEmails.length, 1);
  assert.equal(hs.created.length, 1);
  assert.equal(again.sentNow, false);
});

test('a Gmail 4xx means not sent: the attempt is discarded and can be retried', async () => {
  mailer.failWith = new GoogleApiError(400, 'invalid To header', 'send');
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), GoogleApiError);
  assert.equal(sent.rows.size, 0);
  assert.equal(sent.links.length, 0);

  await runSend(deps(), '1', SIGNATURE, opts());
  assert.equal(mailer.sent.length, 1);
});

test('a network error or 5xx is ambiguous: no resend until the rep checks Gmail', async () => {
  mailer.failWith = new Error('connection reset');
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), /connection reset/);
  assert.equal(sent.rows.get('1')!.status, 'sending');

  // Right away: the lock is still live.
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), /being sent right now/);
  // After the lock expires: unknown, still no resend.
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts(NOW + 5 * 60_000)), SendOutcomeUnknownError);
  assert.equal(mailer.sent.length, 0);

  // The rep finds it in Sent: continue with the follow-up, still no send.
  await resolveUnknownSend(sent, '1', true, NOW + 6 * 60_000);
  const result = await runSend(deps(), '1', SIGNATURE, opts(NOW + 6 * 60_000));
  assert.equal(mailer.sent.length, 0);
  assert.equal(result.gmailMessageId, null);
  assert.equal(hs.loggedEmails.length, 1);
  assert.equal(hs.created.length, 1);
});

test('if the rep finds it is not in Sent, it can be sent again', async () => {
  mailer.failWith = new Error('timeout');
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()));
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts(NOW + 5 * 60_000)), SendOutcomeUnknownError);
  await resolveUnknownSend(sent, '1', false, NOW + 6 * 60_000);
  await runSend(deps(), '1', SIGNATURE, opts(NOW + 6 * 60_000));
  assert.equal(mailer.sent.length, 1);
});

test('refuses to send without a draft or without a recipient email', async () => {
  hs.put('tasks', '2', { hs_task_type: 'EMAIL', hs_task_status: 'NOT_STARTED' });
  hs.link('tasks', '2', 'contacts', '10');
  await assert.rejects(runSend(deps(), '2', SIGNATURE, opts()), /no draft/);

  hs.put('tasks', '3', { hs_task_type: 'EMAIL', hs_task_body: toTaskBodyHtml('s', 'b') });
  hs.put('contacts', '11', { firstname: 'NoEmail' });
  hs.link('tasks', '3', 'contacts', '11');
  await assert.rejects(runSend(deps(), '3', SIGNATURE, opts()), /no email address/);
  assert.equal(mailer.sent.length, 0);
});

test('with HubSpot inbox sync doing the logging, the app logs nothing', async () => {
  const result = await runSend(deps(), '1', SIGNATURE, { ...opts(), logToHubSpot: false });
  assert.equal(mailer.sent.length, 1);
  assert.equal(hs.loggedEmails.length, 0);
  assert.equal(result.loggedEmailId, null);
  assert.equal(hs.created.length, 1, 'follow-up still runs');
});

test('each send records whether opens and clicks were tracked', async () => {
  await runSend(deps(), '1', SIGNATURE, { ...opts(), trackOpens: false, trackClicks: false });
  const row = sent.rows.get('1')!;
  assert.equal(row.track_opens, 0);
  assert.equal(row.track_clicks, 0);
  assert.ok(!mailer.sent[0].includes('/t/'), 'nothing tracked in the email');
});

test('refuses a task that is already completed: a stale Send page never re-sends', async () => {
  hs.put('tasks', '1', {
    hs_task_type: 'EMAIL',
    hs_task_status: 'COMPLETED',
    hs_task_body: toTaskBodyHtml('Quick question about quoting', 'Hi Ana,\n\nThanks,\nAnel'),
  });
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), /already completed/);
  assert.equal(mailer.sent.length, 0);
  assert.equal(sent.rows.size, 0);
});

test('refuses a task that was already confirmed with "Mark sent"', async () => {
  await confirmations.create({ emailTaskId: '1', contactId: '10', companyId: '20' });
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), /already marked as sent/);
  assert.equal(mailer.sent.length, 0);
});

test('a HubSpot log whose response was lost is never logged twice', async () => {
  hs.failNextLog = new Error('connection reset'); // HubSpot may or may not have created it
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), /connection reset/);
  assert.equal(mailer.sent.length, 1, 'the email itself went out');

  const retry = await runSend(deps(), '1', SIGNATURE, opts());
  assert.equal(hs.loggedEmails.length, 0, 'no second log attempt');
  assert.equal(retry.loggedEmailId, null);
  assert.equal(hs.created.length, 1, 'the follow-up still completes');
  assert.equal(mailer.sent.length, 1);
});

test('a definite HubSpot rejection (4xx) lets the retry log it', async () => {
  hs.failNextLog = new HubSpotApiError(400, 'bad property', '/crm/objects/2026-09/emails');
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), HubSpotApiError);
  const stopped = confirmations.rows.get('1')!;
  assert.equal(stopped.lock_until, null, 'the follow-up lock is released');
  assert.match(stopped.last_error ?? '', /bad property/, 'kept for the notice');
  const retry = await runSend(deps(), '1', SIGNATURE, opts());
  assert.equal(hs.loggedEmails.length, 1);
  assert.equal(retry.loggedEmailId, 'email-1');
  assert.equal(confirmations.rows.get('1')!.last_error, null, 'cleared once finished');
});

test('a dropped task is never sent, even from a Send page left open', async () => {
  await hs.updateObject('tasks', '1', { hs_task_status: 'DEFERRED' });
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), /dropped/);
  assert.equal(mailer.sent.length, 0);
  assert.equal(await sent.get('1'), null);
});

test('a Drop landing between the preview check and the claim stops the send', async () => {
  const beginSend = sent.beginSend.bind(sent);
  sent.beginSend = async (...args) => {
    const claimed = await beginSend(...args);
    await hs.updateObject('tasks', '1', { hs_task_status: 'DEFERRED' });
    return claimed;
  };
  await assert.rejects(runSend(deps(), '1', SIGNATURE, opts()), /dropped just now/);
  assert.equal(mailer.sent.length, 0);
  assert.equal(await sent.get('1'), null, 'the claim is released');
});

test('once Gmail took the email, the follow-up runs even if the task was dropped meanwhile', async () => {
  const send = mailer.send.bind(mailer);
  mailer.send = async (raw) => {
    await hs.updateObject('tasks', '1', { hs_task_status: 'DEFERRED' });
    return send(raw);
  };
  const result = await runSend(deps(), '1', SIGNATURE, opts());
  assert.equal(mailer.sent.length, 1);
  assert.equal((await hs.getObject('tasks', '1')).properties.hs_task_status, 'COMPLETED');
  assert.ok(result.callTaskId);
});

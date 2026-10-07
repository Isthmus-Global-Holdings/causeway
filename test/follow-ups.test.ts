// The follow-up emails after a missed interview, and where follow-ups go in
// the email queue.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saidWhen } from '../src/lib/dates.ts';
import { canceledInterviewEmail, closeTheLoopEmail, missedInterviewEmail } from '../src/prompts/follow-up-emails.ts';
import { isTemplatedFollowUp, isWarmFollowUp, rankQueue, type QueueRow } from '../src/workflows/email-queue.ts';

const TZ = 'America/Denver';
const NOW = Date.parse('2026-09-25T15:00:00Z'); // Friday 09:00 Denver

test('saidWhen puts the day the way you would in an email', () => {
  assert.equal(saidWhen(Date.parse('2026-09-25T14:00:00Z'), NOW, TZ), 'today');
  assert.equal(saidWhen(Date.parse('2026-09-24T22:00:00Z'), NOW, TZ), 'yesterday');
  assert.equal(saidWhen(Date.parse('2026-09-22T15:00:00Z'), NOW, TZ), 'on Tuesday');
  assert.equal(saidWhen(Date.parse('2026-09-10T15:00:00Z'), NOW, TZ), 'on Sep 10');
  // 20:00 Denver on the 24th is already the 25th in UTC.
  assert.equal(saidWhen(Date.parse('2026-09-25T02:00:00Z'), NOW, TZ), 'yesterday');
});

test('the missed-interview email: short, no blame, two easy ways back', () => {
  const video = missedInterviewEmail({ firstName: 'Drew', when: 'today', phone: false });
  assert.equal(video.subject, 'sorry we missed each other');
  assert.equal(
    video.body,
    [
      'Hi Drew,',
      'I think we missed each other today. No worries at all, I know things come up.',
      "Is there another day this week or next that works? Happy to just give you a call instead if that's easier than a video call.",
      "Or if it's easier, I can send over 3 quick questions by email and you can answer whenever you have a minute.",
      'Thanks,',
    ].join('\n\n')
  );
  const phone = missedInterviewEmail({ firstName: null, when: 'on Friday', phone: true });
  assert.match(phone.body, /^Hi there,\n\nI think we missed each other on Friday\./);
  assert.match(phone.body, /I can just give you a call, so tell me a time/);
});

test('the canceled-interview email thanks them for saying so and offers another time', () => {
  const video = canceledInterviewEmail({ firstName: 'Drew', phone: false });
  assert.equal(video.subject, 'thanks for letting me know');
  assert.match(video.body, /^Hi Drew,\n\nThanks for letting me know\. No worries at all\./);
  assert.match(video.body, /Happy to just give you a call instead/);
  assert.match(video.body, /3 quick questions by email/);
  const phone = canceledInterviewEmail({ firstName: null, phone: true });
  assert.match(phone.body, /^Hi there,/);
  assert.match(phone.body, /Tell me a time and I'll give you a call then\./);
});

test('the last-try email closes the loop without asking again', () => {
  const email = closeTheLoopEmail({ firstName: 'Drew' });
  assert.equal(email.subject, 'closing the loop');
  assert.match(email.body, /^Hi Drew,\n\nI tried you a couple of times/);
  assert.match(email.body, /I'll leave it here for now/);
});

test('the templates stay in the rep’s voice: no em dashes or semicolons', () => {
  for (const email of [
    missedInterviewEmail({ firstName: 'A', when: 'today', phone: true }),
    missedInterviewEmail({ firstName: 'A', when: 'today', phone: false }),
    canceledInterviewEmail({ firstName: 'A', phone: true }),
    canceledInterviewEmail({ firstName: 'A', phone: false }),
    closeTheLoopEmail({ firstName: 'A' }),
  ]) {
    assert.doesNotMatch(email.subject + email.body, /[—;]/);
  }
});

test('the app’s follow-up subjects are recognised', () => {
  assert.equal(isWarmFollowUp('Email: Pine Hollow Transport (Drew Pollard) — missed interview'), true);
  assert.equal(isWarmFollowUp('Email: Pine Hollow (Drew Pollard) — close the loop'), true);
  assert.equal(isWarmFollowUp('Email: Pine Hollow (Drew Pollard) — follow up on interview'), true);
  assert.equal(isWarmFollowUp('Email: Pine Hollow (Drew Pollard) — follow up on call'), true);
  assert.equal(isWarmFollowUp('Email: Pine Hollow (VFWPA outreach)'), false);
  assert.equal(isTemplatedFollowUp('Email: Pine Hollow (Drew Pollard) — missed interview'), true);
  assert.equal(isWarmFollowUp('Email: Pine Hollow (Drew Pollard) — canceled interview'), true);
  assert.equal(isTemplatedFollowUp('Email: Pine Hollow (Drew Pollard) — canceled interview'), true);
  assert.equal(
    isTemplatedFollowUp('Email: Pine Hollow (Drew Pollard) — follow up on call'),
    false,
    'Claude may draft it'
  );
  assert.equal(isTemplatedFollowUp(null), false);
});

function row(taskId: string, extra: Partial<QueueRow>): QueueRow {
  return {
    taskId,
    subject: taskId,
    createdAt: '2026-09-01T00:00:00Z',
    hasDraft: false,
    contactName: null,
    companyName: null,
    fit: 'GOOD',
    warm: false,
    ...extra,
  };
}

test('a follow-up that’s due goes ahead of cold outreach, and a drafted one is next to send', () => {
  const strongCold = row('cold', { fit: 'STRONG' });
  const warm = row('warm', { fit: 'WEAK', warm: true, hasDraft: true });
  const { rows, nextUp } = rankQueue([strongCold, warm]);
  assert.deepEqual(
    rows.map((r) => r.taskId),
    ['warm', 'cold']
  );
  assert.deepEqual(nextUp, { item: warm, step: 'send' });

  const undrafted = row('warm2', { warm: true });
  assert.deepEqual(rankQueue([strongCold, undrafted]).nextUp, { item: undrafted, step: 'draft' });
  assert.deepEqual(rankQueue([strongCold, row('later', { warm: false })]).nextUp?.item, strongCold);
});

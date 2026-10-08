import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_BOT, codexVerdict, headChangedAt } from '../scripts/codex-review-gate.mjs';

const HEAD = '9c1a642a3d5e7f0b1c2d3e4f5a6b7c8d9e0f1a2b';
const bot = { login: CODEX_BOT };
const since = new Date('2026-10-08T03:00:00Z');

function summary(status: string, sha: string) {
  return {
    user: bot,
    created_at: '2026-10-08T01:48:19Z',
    body: [
      '<!-- codex-pull-request-review-summary -->',
      '',
      '## Codex Review Summary',
      '',
      '| Review | Status | Commit | Review trigger |',
      '| --- | --- | --- | --- |',
      `| 📝 **Code Review** | ${status} | \`${sha}\` | New commits |`,
    ].join('\n'),
  };
}

const usageLimit = (created_at: string, user = bot) => ({
  user,
  created_at,
  body: 'You have reached your Codex usage limits for code reviews. You can see your limits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage).',
});

const review = (sha: string, user = bot) => ({
  user,
  body: `\n### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** \`${sha}\`\n`,
});

const verdict = (comments: object[], reviews: object[] = []) =>
  codexVerdict({ comments, reviews, headSha: HEAD, since }).state;

test('reviewed once the summary shows the head commit completed', () => {
  const completed =
    '✅ **Completed** <relative-time datetime="2026-10-08T03:17:38Z">2026-10-08T03:17:38Z</relative-time>';
  assert.equal(verdict([summary(completed, '9c1a642')]), 'reviewed');
});

test('waits while the summary is about an older commit, or still running', () => {
  assert.equal(verdict([summary('✅ **Completed**', '1d2c601')]), 'waiting');
  assert.equal(
    verdict([
      summary(
        '🔄 **Running** since <relative-time datetime="2026-10-08T03:31:17Z">2026-10-08T03:31:17Z</relative-time>',
        '9c1a642'
      ),
    ]),
    'waiting'
  );
});

test('a review with suggestions for the head commit counts', () => {
  assert.equal(verdict([], [review('9c1a642a3d')]), 'reviewed');
  assert.equal(verdict([], [review('cbb322b572')]), 'waiting');
});

test('out of usage only when Codex said so after the head commit', () => {
  assert.equal(verdict([usageLimit('2026-10-08T03:02:00Z')]), 'out-of-usage');
  assert.equal(verdict([usageLimit('2026-10-08T02:26:57Z')]), 'waiting');
});

test('only Codex itself counts', () => {
  const someone = { login: 'anelcanto' };
  assert.equal(verdict([{ ...summary('✅ **Completed**', '9c1a642'), user: someone }]), 'waiting');
  assert.equal(verdict([usageLimit('2026-10-08T03:02:00Z', someone)]), 'waiting');
  assert.equal(verdict([], [review('9c1a642', someone)]), 'waiting');
});

test('a short or empty commit never matches', () => {
  assert.equal(verdict([], [review('9c1a')]), 'waiting');
  assert.equal(verdict([{ user: bot, created_at: since.toISOString(), body: null }]), 'waiting');
});

test('the head changed when its commit was made, or at the last force-push if later', () => {
  const commitDate = '2026-10-08T03:31:06Z';
  assert.equal(headChangedAt(commitDate, []).toISOString(), '2026-10-08T03:31:06.000Z');
  // Reset to an old commit: the force-push is what's fresh, so a usage-limit
  // comment left for the previous head no longer counts.
  const events = [
    { event: 'head_ref_force_pushed', created_at: '2026-10-08T02:00:00Z' },
    { event: 'labeled', created_at: '2026-10-08T05:00:00Z' },
    { event: 'head_ref_force_pushed', created_at: '2026-10-08T04:10:00Z' },
  ];
  const since = headChangedAt('2026-10-07T12:00:00Z', events);
  assert.equal(since.toISOString(), '2026-10-08T04:10:00.000Z');
  const stale = usageLimit('2026-10-08T04:00:00Z');
  assert.equal(codexVerdict({ comments: [stale], reviews: [], headSha: HEAD, since }).state, 'waiting');
});

// The `codex-review` check (.github/workflows/codex-review.yml): waits until
// Codex has reviewed the PR's latest commit, so "merge when ready" waits for
// it too. Codex posts no status of its own, only comments, reviews and
// reactions, so this reads what it posts. It never blocks a merge for long:
// out of usage, or no answer in WAIT_MINUTES, and the check passes with a
// warning. The `skip-codex` label passes it at once. Findings don't block:
// once Codex has reviewed, what to do with its comments is the rep's call.

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CODEX_BOT = 'chatgpt-codex-connector[bot]';
export const SKIP_LABEL = 'skip-codex';
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
const WAIT_MINUTES = 15;
const POLL_SECONDS = 30;

// What Codex has said about `headSha`. `since` is when the PR's head became
// this commit (headChangedAt): a usage-limit comment older than that was
// about an earlier push.
export function codexVerdict({ comments, reviews, headSha, since }) {
  const byBot = (item) => item.user?.login === CODEX_BOT;
  const isHead = (sha) => sha.length >= 7 && headSha.toLowerCase().startsWith(sha.toLowerCase());

  // The summary comment, edited in place on every review:
  // | 📝 **Code Review** | ✅ **Completed** <relative-time …> | `9c1a642` | New commits |
  const summary = comments.find((c) => byBot(c) && c.body?.includes(SUMMARY_MARKER));
  for (const row of summary?.body.split('\n') ?? []) {
    const m = /^\|\s*📝 \*\*Code Review\*\*\s*\|([^|]*)\|\s*`([0-9a-f]+)`/i.exec(row);
    if (m && /Completed/i.test(m[1]) && isHead(m[2])) {
      return { state: 'reviewed', detail: `Codex finished reviewing ${m[2]}.` };
    }
  }

  // A review with suggestions names its commit: **Reviewed commit:** `02c2f4162e`
  for (const review of reviews.filter(byBot)) {
    const m = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]+)`/i.exec(review.body ?? '');
    if (m && isHead(m[1])) return { state: 'reviewed', detail: `Codex reviewed ${m[1]}.` };
  }

  const outOfUsage = comments.find(
    (c) =>
      byBot(c) && /reached your Codex usage limits/i.test(c.body ?? '') && Date.parse(c.created_at) >= since.getTime()
  );
  if (outOfUsage) return { state: 'out-of-usage', detail: 'Codex is out of usage, not waiting for it.' };

  return { state: 'waiting', detail: `Waiting for Codex to review ${headSha.slice(0, 7)}.` };
}

// When the PR's head became this commit, from what GitHub records rather than
// the commit's own date (old or made up for a commit pushed later): the first
// workflow run this commit started on this PR, which lands seconds after the
// push, or the last force-push if that's later (a reset back to an old commit
// it already ran on). Both come from the API, so a re-run, or a restart when a
// label changes, still sees the usage-limit comment Codex left on this push.
// With nothing recorded (a fork's runs name no PR), only what Codex says from
// `now` on counts.
export function headChangedAt({ runs, issueEvents, prNumber, now }) {
  const firstRun = runs
    .filter((r) => r.event === 'pull_request' && r.pull_requests?.some((p) => p.number === prNumber))
    .map((r) => Date.parse(r.created_at));
  if (firstRun.length === 0) return now;
  const forcePushes = issueEvents
    .filter((e) => e.event === 'head_ref_force_pushed')
    .map((e) => Date.parse(e.created_at));
  return new Date(Math.max(Math.min(...firstRun), ...forcePushes));
}

async function github(path) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (res.ok) return res.json();
    if (attempt === 3) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
    await sleep(5_000 * attempt);
  }
}

async function all(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await github(`${path}?per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pass(detail, { warn = false } = {}) {
  console.log(warn ? `::warning::${detail}` : detail);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${detail}\n`);
  process.exit(0);
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  const repo = process.env.GITHUB_REPOSITORY;
  if (pr.labels.some((l) => l.name === SKIP_LABEL)) pass(`The ${SKIP_LABEL} label is on: not waiting for Codex.`);

  const [{ workflow_runs: runs }, issueEvents] = await Promise.all([
    github(`/repos/${repo}/actions/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=100`),
    all(`/repos/${repo}/issues/${pr.number}/events`),
  ]);
  const since = headChangedAt({ runs, issueEvents, prNumber: pr.number, now: new Date() });
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  for (;;) {
    const [comments, reviews] = await Promise.all([
      all(`/repos/${repo}/issues/${pr.number}/comments`),
      all(`/repos/${repo}/pulls/${pr.number}/reviews`),
    ]);
    const verdict = codexVerdict({ comments, reviews, headSha: pr.head.sha, since });
    if (verdict.state === 'reviewed') pass(verdict.detail);
    if (verdict.state === 'out-of-usage') pass(verdict.detail, { warn: true });
    if (Date.now() >= deadline) pass(`Codex didn't answer in ${WAIT_MINUTES} minutes: not waiting.`, { warn: true });
    console.log(verdict.detail);
    await sleep(POLL_SECONDS * 1000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

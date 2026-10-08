// The `codex-review` check (.github/workflows/codex-review.yml), so "merge
// when ready" waits for Codex too:
//   1. Codex reviews the PR's latest commit. Codex posts no status of its
//      own, only comments, reviews and reactions, so this reads what it
//      posts. Out of usage, or no answer in WAIT_MINUTES, and it moves on
//      with a warning: Codex being away never holds a merge for long.
//   2. Every finding Codex left on the PR is resolved: each of its review
//      threads, fixed or answered, then marked resolved. Resolving a thread
//      starts no workflow, so this stays running and looks again every
//      THREAD_POLL_SECONDS, passing as soon as the last one is resolved. Past
//      THREAD_WAIT_MINUTES the check fails, naming them; re-run it once
//      they're resolved. Other reviewers' comments (Qodo's, CodeRabbit's)
//      never hold it.
// The `skip-codex` label passes it at once.

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CODEX_BOT = 'chatgpt-codex-connector[bot]';
// GraphQL names a bot without the "[bot]".
const CODEX_LOGINS = new Set([CODEX_BOT, CODEX_BOT.replace(/\[bot\]$/, '')]);
export const SKIP_LABEL = 'skip-codex';
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
const WAIT_MINUTES = 15;
const POLL_SECONDS = 30;
// Inside the job's six hours (timeout-minutes in the workflow), after the
// wait for the review.
const THREAD_WAIT_MINUTES = 330;
const THREAD_POLL_SECONDS = 60;

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

// Codex's findings not resolved yet: its review threads (the first comment
// is Codex's) that nobody has marked resolved, whatever commit they were on.
// Each with its priority badge and title: **<sub><sub>![P2 Badge](…)</sub></sub>  Preserve …**
export function openCodexFindings(threads) {
  return threads
    .filter((t) => !t.isResolved && CODEX_LOGINS.has(t.comments?.nodes?.[0]?.author?.login))
    .map((t) => {
      const first = t.comments.nodes[0];
      const head = (first.body ?? '').split('\n')[0];
      const priority = /!\[(P\d) Badge\]/.exec(head)?.[1] ?? null;
      const title = head
        .replace(/<[^>]+>/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\*\*/g, '')
        .trim();
      return { url: first.url, path: t.path ?? null, priority, title: title || 'Codex finding' };
    });
}

export function findingsText(findings) {
  return findings
    .map((f) => `- ${f.priority ? `${f.priority} ` : ''}${f.title}${f.path ? ` (${f.path})` : ''}: ${f.url}`)
    .join('\n');
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

async function github(path, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.github.com${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.ok ? await res.json() : null;
    if (json && !json.errors) return json;
    if (attempt === 3)
      throw new Error(`GitHub ${path}: ${res.status} ${json ? JSON.stringify(json.errors) : await res.text()}`);
    await sleep(5_000 * attempt);
  }
}

// The PR's review threads, with whether each is resolved and its first
// comment. Only GraphQL has the resolved flag.
async function reviewThreads(repo, number) {
  const [owner, name] = repo.split('/');
  const threads = [];
  for (let after = null; ;) {
    const { data } = await github('/graphql', {
      query: `query($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { isResolved path comments(first: 1) { nodes { author { login } url body } } }
          }
        } }
      }`,
      variables: { owner, name, number, after },
    });
    const page = data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return threads;
    after = page.pageInfo.endCursor;
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

function say(detail, level = null) {
  console.log(level ? `::${level}::${detail}` : detail);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${detail}\n\n`);
}

function pass(detail) {
  say(detail);
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

  // 1. Codex's review of the head commit.
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  for (;;) {
    const [comments, reviews] = await Promise.all([
      all(`/repos/${repo}/issues/${pr.number}/comments`),
      all(`/repos/${repo}/pulls/${pr.number}/reviews`),
    ]);
    const verdict = codexVerdict({ comments, reviews, headSha: pr.head.sha, since });
    if (verdict.state === 'reviewed') {
      say(verdict.detail);
      break;
    }
    if (verdict.state === 'out-of-usage') {
      say(verdict.detail, 'warning');
      break;
    }
    if (Date.now() >= deadline) {
      say(`Codex didn't answer in ${WAIT_MINUTES} minutes: not waiting for its review.`, 'warning');
      break;
    }
    console.log(verdict.detail);
    await sleep(POLL_SECONDS * 1000);
  }

  // 2. Its findings, every one resolved.
  const threadDeadline = Date.now() + THREAD_WAIT_MINUTES * 60_000;
  let shown = '';
  for (;;) {
    const open = openCodexFindings(await reviewThreads(repo, pr.number));
    if (open.length === 0) pass('No Codex findings left open.');
    const list = findingsText(open);
    if (Date.now() >= threadDeadline) {
      say(
        `${open.length} Codex finding(s) still open after ${THREAD_WAIT_MINUTES} minutes. Fix or answer each, mark its thread resolved, then re-run this check:\n${list}`,
        'error'
      );
      process.exit(1);
    }
    if (list !== shown) {
      console.log(`Waiting for ${open.length} Codex finding(s) to be resolved:\n${list}`);
      shown = list;
    }
    await sleep(THREAD_POLL_SECONDS * 1000);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

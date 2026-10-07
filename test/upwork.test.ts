import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fillPitch,
  isLoomShareUrl,
  jobTitleFrom,
  parsePitch,
  pitchDealName,
  pitchDescription,
  upworkJobId,
} from '../src/lib/upwork.ts';

const JOB = '~021234567890123456789';
const LOOM = 'https://www.loom.com/share/0123456789abcdef0123456789abcdef';

test('upworkJobId reads the job from every Upwork URL that shows one', () => {
  for (const url of [
    `https://www.upwork.com/jobs/${JOB}`,
    `https://www.upwork.com/jobs/Build-a-Chrome-extension_${JOB}/`,
    `https://www.upwork.com/nx/proposals/job/${JOB}/apply/`,
    `https://www.upwork.com/ab/proposals/job/${JOB}/apply/?referrer=x`,
    `https://www.upwork.com/nx/find-work/best-matches/details/${JOB}`,
  ]) {
    assert.equal(upworkJobId(url), JOB, url);
  }
  assert.equal(
    upworkJobId('https://www.upwork.com/jobs/~01ABCDEF0123'),
    '~01abcdef0123',
    'old hex ciphers, lowercased'
  );
});

test('upworkJobId is null off Upwork and on pages without a job', () => {
  assert.equal(upworkJobId(`https://evil.example/jobs/${JOB}`), null);
  assert.equal(upworkJobId(`https://upwork.com.evil.example/jobs/${JOB}`), null);
  assert.equal(upworkJobId('https://www.upwork.com/nx/find-work/'), null);
  assert.equal(upworkJobId('https://www.upwork.com/ab/messages/rooms/room_123'), null);
  assert.equal(upworkJobId('not a url'), null);
});

test('isLoomShareUrl takes Loom’s copied link, with or without its query', () => {
  assert.ok(isLoomShareUrl(LOOM));
  assert.ok(isLoomShareUrl(`  ${LOOM}?sid=abc-123\n`));
  assert.ok(isLoomShareUrl('https://loom.com/share/0123456789abcdef0123456789abcdef'));
  for (const not of [
    '',
    'just some text',
    'http://www.loom.com/share/0123456789abcdef0123456789abcdef',
    'https://www.loom.com/looms/videos',
    'https://www.loom.com/share/short',
    'https://loom.com.evil.example/share/0123456789abcdef0123456789abcdef',
    `${LOOM} and more`,
  ]) {
    assert.equal(isLoomShareUrl(not), false, not);
  }
});

test('fillPitch puts the link at every {{loom}}', () => {
  assert.equal(fillPitch('Hi.\nVideo: {{loom}}\nAgain: {{loom}}', ` ${LOOM} `), `Hi.\nVideo: ${LOOM}\nAgain: ${LOOM}`);
});

test('jobTitleFrom prefers the tab title, skipping Upwork’s own page names', () => {
  assert.equal(jobTitleFrom('Build a Chrome extension - Upwork', []), 'Build a Chrome extension');
  assert.equal(jobTitleFrom('Submit a Proposal - Upwork', ['Submit a proposal', 'Build a CRM']), 'Build a CRM');
  assert.equal(jobTitleFrom('Upwork', ['Job details', '  ']), null);
  assert.equal(jobTitleFrom('x'.repeat(500), [])?.length, 200);
});

test('parsePitch checks the extension’s body', () => {
  assert.deepEqual(parsePitch({ jobId: JOB.toUpperCase(), jobTitle: '  Build it ', loomUrl: ` ${LOOM}` }), {
    jobId: JOB,
    jobTitle: 'Build it',
    loomUrl: LOOM,
  });
  assert.deepEqual(parsePitch({ jobId: JOB, jobTitle: null, loomUrl: LOOM }), {
    jobId: JOB,
    jobTitle: null,
    loomUrl: LOOM,
  });
  assert.equal(typeof parsePitch(null), 'string');
  assert.equal(typeof parsePitch({ jobId: 'room_123', loomUrl: LOOM }), 'string');
  assert.equal(typeof parsePitch({ jobId: `${JOB}/x`, loomUrl: LOOM }), 'string');
  assert.equal(typeof parsePitch({ jobId: JOB, loomUrl: 'https://example.com' }), 'string');
  assert.equal(typeof parsePitch({ jobId: JOB, loomUrl: LOOM, jobTitle: 5 }), 'string');
});

test('the deal is named for the job and says where the pitch is', () => {
  const pitch = { jobId: JOB, jobTitle: 'Build it', loomUrl: LOOM };
  assert.equal(pitchDealName(pitch), 'Upwork: Build it');
  assert.equal(pitchDealName({ ...pitch, jobTitle: null }), `Upwork: ${JOB}`);
  assert.equal(
    pitchDescription(pitch, '2026-09-29'),
    `Pitched on Upwork 2026-09-29.\nJob: https://www.upwork.com/jobs/${JOB}\nLoom: ${LOOM}`
  );
});

// Upwork pitches: one deal per job however often the extension's shortcut
// is pressed, and POST /pitches on the real app against a stand-in for
// HubSpot's HTTP API.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HubSpotApiError } from '../src/lib/hubspot.ts';
import type { AppEnv } from '../src/types.ts';
import { logPitch } from '../src/workflows/pitch-logged.ts';
import { FakeHubSpot, hubspotApi } from './fakes.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const JOB = '~021234567890123456789';
const LOOM = 'https://www.loom.com/share/0123456789abcdef0123456789abcdef';
const pitch = { jobId: JOB, jobTitle: 'Build a Chrome extension', loomUrl: LOOM };

test('a first pitch makes the job’s deal in the Sales Pipeline, marked Upwork', async () => {
  const hs = new FakeHubSpot();
  assert.deepEqual(await logPitch(hs, pitch, '2026-09-29'), { dealId: 'deal-1', created: true });
  const deal = hs.objects.get('deals/deal-1')!;
  assert.deepEqual(deal.properties, {
    dealname: 'Upwork: Build a Chrome extension',
    pipeline: 'default',
    dealstage: 'appointmentscheduled',
    deal_source: 'Upwork',
    upwork_job_id: JOB,
    description: `Pitched on Upwork 2026-09-29.\nJob: https://www.upwork.com/jobs/${JOB}\nLoom: ${LOOM}`,
  });
});

test('pitching the job again answers with its deal and leaves it where the rep moved it', async () => {
  const hs = new FakeHubSpot();
  await logPitch(hs, pitch, '2026-09-29');
  await hs.updateObject('deals', 'deal-1', { dealstage: 'qualifiedtobuy' });
  const again = await logPitch(hs, { ...pitch, loomUrl: `${LOOM}?sid=2` }, '2026-09-30');
  assert.deepEqual(again, { dealId: 'deal-1', created: false });
  assert.equal(hs.dealsCreated, 1);
  assert.equal(hs.objects.get('deals/deal-1')!.properties.dealstage, 'qualifiedtobuy');
});

test('two presses at once make one deal: HubSpot refuses the second, which answers with the first', async () => {
  const hs = new FakeHubSpot();
  const [a, b] = await Promise.all([logPitch(hs, pitch, '2026-09-29'), logPitch(hs, pitch, '2026-09-29')]);
  assert.equal(hs.dealsCreated, 1);
  assert.deepEqual(
    [a, b],
    [
      { dealId: 'deal-1', created: true },
      { dealId: 'deal-1', created: false },
    ]
  );
});

test('a HubSpot failure that isn’t a duplicate is passed on', async () => {
  const hs = new FakeHubSpot();
  hs.createDeal = () => Promise.reject(new HubSpotApiError(500, 'boom', '/deals'));
  await assert.rejects(
    logPitch(hs, pitch, '2026-09-29'),
    (err) => err instanceof HubSpotApiError && err.status === 500
  );
});

// --- POST /pitches ---

async function post(hs: FakeHubSpot, body: string, db = sqliteD1()) {
  const { default: app } = await import('../src/index.ts');
  const realFetch = globalThis.fetch;
  globalThis.fetch = hubspotApi(hs) as unknown as typeof fetch;
  try {
    return await app.request(
      'http://localhost/pitches',
      { method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body },
      {
        DB: db,
        DEV_BYPASS_ACCESS: 'true',
        TZ: 'America/Denver',
        HUBSPOT_ACCESS_TOKEN: 'hs',
        HUBSPOT_PORTAL_ID: '247548603',
      } as unknown as AppEnv['Bindings']
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('POST /pitches logs the deal, answers with its link, and audits it', async () => {
  const hs = new FakeHubSpot();
  const db = sqliteD1();
  const res = await post(hs, JSON.stringify(pitch), db);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    dealId: 'deal-1',
    created: true,
    dealUrl: 'https://app.hubspot.com/contacts/247548603/record/0-3/deal-1',
  });
  const again = await post(hs, JSON.stringify(pitch), db);
  assert.equal(((await again.json()) as { created: boolean }).created, false);
  const { results } = await db
    .prepare("SELECT task_id, outcome FROM audit_log WHERE workflow = 'pitch' ORDER BY id")
    .all<{ task_id: string; outcome: string }>();
  assert.deepEqual(
    results.map((r) => [r.task_id, r.outcome]),
    [
      [JOB, 'success'],
      [JOB, 'success'],
    ]
  );
});

test('POST /pitches says what’s wrong with a bad pitch, as JSON, without touching HubSpot', async () => {
  const hs = new FakeHubSpot();
  const notJson = await post(hs, 'nope');
  assert.equal(notJson.status, 400);
  assert.match(((await notJson.json()) as { error: string }).error, /JSON/);
  const noLoom = await post(hs, JSON.stringify({ ...pitch, loomUrl: 'https://example.com' }));
  assert.equal(noLoom.status, 400);
  assert.match(((await noLoom.json()) as { error: string }).error, /Loom/);
  assert.equal(hs.reads.length, 0);
});

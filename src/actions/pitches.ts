// What the Upwork pitch extension's POST /pitches does: check the pitch, log
// its deal (workflows/pitch-logged.ts), and audit it.

import type { Context } from 'hono';
import { loadAppSettings } from '../lib/app-settings';
import { localDate } from '../lib/dates';
import { insertAudit } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import { parsePitch } from '../lib/upwork';
import type { AppEnv } from '../types';
import { WorkflowError } from '../workflows/parties';
import { logPitch, type PitchResult } from '../workflows/pitch-logged';

export async function recordPitch(c: Context<AppEnv>, body: unknown): Promise<PitchResult> {
  const pitch = parsePitch(body);
  if (typeof pitch === 'string') throw new WorkflowError(pitch);
  const audit = (outcome: 'success' | 'failed', detail: unknown, error: string | null = null) =>
    insertAudit(c.env.DB, {
      actor: c.get('actor'),
      workflow: 'pitch',
      taskId: pitch.jobId,
      action: 'log Upwork pitch',
      outcome,
      error,
      detail,
    });
  try {
    const { timeZone } = await loadAppSettings(c.env);
    const result = await logPitch(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), pitch, localDate(Date.now(), timeZone));
    await audit('success', { ...result, loomUrl: pitch.loomUrl });
    return result;
  } catch (err) {
    await audit('failed', { loomUrl: pitch.loomUrl }, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

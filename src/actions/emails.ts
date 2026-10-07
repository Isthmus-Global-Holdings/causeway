// What the email pages and the Claude connector both do with EMAIL tasks:
// save a draft, mark one sent by hand, drop one. Each runs the workflow and
// writes the audit row; the caller only parses its input and answers.

import type { Context } from 'hono';
import { loadAppSettings, type AppSettings } from '../lib/app-settings';
import { afterResponse } from '../lib/background';
import { d1ConfirmationStore, d1SentEmailStore, insertAudit, removeFromPlan } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import type { AppEnv } from '../types';
import { saveDraft, type SaveDraftInput } from '../workflows/draft-email';
import { finishEmailSent, prepareEmailSent, type PreparedEmailSent } from '../workflows/email-sent';
import { dropEmail } from '../workflows/task-actions';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Writes Subject + body into the task's hs_task_body. Replacing a draft
// already there needs `overwrite`.
export async function saveEmailDraft(
  c: Context<AppEnv>,
  taskId: string,
  input: SaveDraftInput
): Promise<{ replaced: boolean }> {
  const actor = c.get('actor');
  try {
    const { replaced } = await saveDraft(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), taskId, input);
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'draft-email',
      taskId,
      action: replaced ? 'replace hs_task_body' : 'set hs_task_body',
      outcome: 'success',
      detail: { subject: input.subject },
    });
    return { replaced };
  } catch (err) {
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'draft-email',
      taskId,
      action: 'set hs_task_body',
      outcome: 'failed',
      error: errorText(err),
    });
    throw err;
  }
}

// The rep sent the email another way (from HubSpot or Gmail by hand).
// Completes the EMAIL task and creates tomorrow's CALL task after the
// response.
export async function markEmailSent(c: Context<AppEnv>, taskId: string): Promise<AppSettings> {
  const actor = c.get('actor');
  const settings = await loadAppSettings(c.env);
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  const confirmations = d1ConfirmationStore(c.env.DB);
  const opts = { now: Date.now(), timeZone: settings.timeZone };
  const audit = (outcome: 'success' | 'failed', extra: { detail?: unknown; error?: string }) =>
    insertAudit(c.env.DB, {
      actor,
      workflow: 'email-sent',
      taskId,
      action: 'complete email task + create call task',
      outcome,
      ...extra,
    });

  let prepared: PreparedEmailSent;
  try {
    prepared = await prepareEmailSent(hs, confirmations, taskId, opts);
  } catch (err) {
    await audit('failed', { error: errorText(err) });
    throw err;
  }
  afterResponse(c, `marking task ${taskId} sent`, async () => {
    try {
      await audit('success', { detail: await finishEmailSent(hs, confirmations, prepared, opts) });
    } catch (err) {
      await audit('failed', { error: errorText(err) });
    }
  });
  return settings;
}

// The rep won't send this one. Marks the EMAIL task DEFERRED in HubSpot,
// which takes it off the queue, and creates no follow-up.
export async function dropEmailTask(c: Context<AppEnv>, taskId: string): Promise<void> {
  const actor = c.get('actor');
  try {
    await dropEmail(
      createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN),
      d1SentEmailStore(c.env.DB),
      d1ConfirmationStore(c.env.DB),
      taskId
    );
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'task-action',
      taskId,
      action: 'drop email task',
      outcome: 'success',
    });
    await removeFromPlan(c.env.DB, 'email_plan', taskId);
  } catch (err) {
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'task-action',
      taskId,
      action: 'drop email task',
      outcome: 'failed',
      error: errorText(err),
    });
    throw err;
  }
}

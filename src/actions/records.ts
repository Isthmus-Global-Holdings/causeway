// What the contact, call and interview pages and the Claude connector all do
// to a contact: open their task of a type, creating one due now if there's
// none, and save the numbers they gave.

import type { Context } from 'hono';
import { d1ContactTaskLockStore, insertAudit } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import type { AppEnv } from '../types';
import { saveContactNumbers, type NumbersInput } from '../workflows/numbers';
import type { TaskType } from '../workflows/parties';
import { taskForContact, type ContactTaskResult } from '../workflows/records';

export async function openContactTask(
  c: Context<AppEnv>,
  contactId: string,
  type: TaskType,
  companyId: string | null
): Promise<ContactTaskResult> {
  const result = await taskForContact(
    { hs: createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), locks: d1ContactTaskLockStore(c.env.DB) },
    contactId,
    type,
    { now: Date.now(), companyId }
  );
  if (result.created) {
    await insertAudit(c.env.DB, {
      actor: c.get('actor'),
      workflow: 'task-action',
      taskId: result.taskId,
      action: `create ${type} task from contact`,
      outcome: 'success',
      detail: { contactId, companyId },
    });
  }
  return result;
}

// `from` is the page (or task) the numbers were saved from, for the audit log.
export async function saveNumbers(
  c: Context<AppEnv>,
  contactId: string,
  input: NumbersInput,
  from: { workflow: 'call' | 'meeting' | 'task-action'; taskId: string }
): Promise<Record<string, string>> {
  const changes = await saveContactNumbers(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), contactId, input);
  if (Object.keys(changes).length) {
    await insertAudit(c.env.DB, {
      actor: c.get('actor'),
      workflow: from.workflow,
      taskId: from.taskId,
      action: 'save contact numbers',
      outcome: 'success',
      detail: { contactId, ...changes },
    });
  }
  return changes;
}

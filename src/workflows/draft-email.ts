// Workflow 1: gather what a rep needs to draft a cold email, and store the
// finished draft on the Contact's EMAIL task.

import type { HubSpot } from '../lib/hubspot';
import { buildDraftContext } from '../lib/prompt';
import { htmlToText, toTaskBodyHtml } from '../lib/richtext';
import {
  companyName,
  contactName,
  loadContactNotes,
  loadTask,
  WorkflowError,
  type ContactNote,
  type TaskParties,
} from './parties';

// Enough to be useful in a prompt without pasting a contact's whole history.
const MAX_NOTES = 20;

export interface DraftContext extends TaskParties {
  notes: ContactNote[];
  existingDraft: string | null; // current hs_task_body as plain text
  claudeContext: string; // for pasting into a Claude chat (rules included)
  apiContext: string; // for "Draft with Claude" (rules live in the system prompt)
}

export async function loadDraftContext(hs: HubSpot, taskId: string): Promise<DraftContext> {
  // The contact comes with its notes' ids, so the notes are one batch read.
  const parties = await loadTask(hs, taskId, 'EMAIL', ['notes']);
  const notes = await loadContactNotes(hs, parties.contact.id, MAX_NOTES, parties.related?.notes);

  const body = parties.task.properties.hs_task_body;
  const existingDraft = body ? htmlToText(body) || null : null;

  const input = {
    contactName: contactName(parties.contact),
    contactTitle: parties.contact.properties.jobtitle,
    contactEmail: parties.contact.properties.email,
    companyName: companyName(parties.company),
    companyDescription: parties.company?.properties.description ?? null,
    notes: notes.map((n) => n.text),
    existingDraft,
  };

  return {
    ...parties,
    notes,
    existingDraft,
    claudeContext: buildDraftContext(input, { includeRules: true }),
    apiContext: buildDraftContext(input, { includeRules: false }),
  };
}

export interface SaveDraftInput {
  subject: string;
  body: string;
  // Must be true to replace a body that's already on the task, so a re-run
  // never silently clobbers a prior draft.
  overwrite: boolean;
}

export async function saveDraft(hs: HubSpot, taskId: string, input: SaveDraftInput): Promise<{ replaced: boolean }> {
  if (!input.subject.trim() || !input.body.trim()) {
    throw new WorkflowError('Both a subject and a body are required.');
  }
  // Just the task: its contact and company don't matter for saving.
  const task = await hs.getObject('tasks', taskId, ['hs_task_type', 'hs_task_body']);
  if (task.properties.hs_task_type !== 'EMAIL') {
    throw new WorkflowError(`Task ${taskId} is a ${task.properties.hs_task_type ?? 'untyped'} task, not EMAIL.`);
  }
  const replaced = Boolean(task.properties.hs_task_body?.trim());
  if (replaced && !input.overwrite) {
    throw new WorkflowError('This task already has a draft. Tick "Replace the existing draft" to overwrite it.', 409);
  }
  await hs.updateObject('tasks', taskId, { hs_task_body: toTaskBodyHtml(input.subject, input.body) });
  return { replaced };
}

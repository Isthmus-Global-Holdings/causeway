// The rep's work queue: every NOT_STARTED EMAIL task, ranked by the fit label
// in its Company's description, with the next one to draft picked out.
// Follow-ups to people the rep has already talked to (after a call, an
// interview or a missed one) that are due by today go first: they're warm,
// and waiting cools them.

import { parseFitLabel, pickNextUp, rankByFit, type FitLabel, type NextUp } from '../lib/fit';
import { dayBounds, parseHubSpotTime } from '../lib/dates';
import type { HubSpot } from '../lib/hubspot';
import { parseTaskBody } from '../lib/richtext';
import { companyName, contactName, loadOpenTasks } from './parties';

export interface QueueRow {
  taskId: string;
  subject: string;
  createdAt: string | null;
  hasDraft: boolean;
  contactName: string | null;
  companyName: string | null;
  fit: FitLabel;
  warm: boolean; // a follow-up due by today (isWarmFollowUp), ranked first
}

// The subjects the app gives follow-up EMAIL tasks: after a call
// (nextTaskSubject), an interview (interviewFollowUpSubject), a no-show
// (missedInterviewSubject) and the last try (lastTrySubject).
const WARM_SUBJECT = /— (follow up on call|follow up on interview|missed interview|close the loop)$/;

export function isWarmFollowUp(subject: string): boolean {
  return WARM_SUBJECT.test(subject.trim());
}

// Follow-ups drafted from the rep's templates (prompts/follow-up-emails.ts),
// not by Claude: Claude's drafting rules are for cold emails.
const TEMPLATED_SUBJECT = /— (missed interview|close the loop)$/;

export function isTemplatedFollowUp(subject: string | null | undefined): boolean {
  return TEMPLATED_SUBJECT.test((subject ?? '').trim());
}

// Warm follow-ups first, each group by fit. A warm one already drafted is the
// one to send next, ahead of drafting a cold one.
export function rankQueue(rows: QueueRow[]): { rows: QueueRow[]; nextUp: NextUp<QueueRow> | null } {
  const ranked = [...rankByFit(rows.filter((r) => r.warm)), ...rankByFit(rows.filter((r) => !r.warm))];
  const warmReady = ranked.find((r) => r.warm && r.hasDraft && r.fit !== 'DROP');
  return { rows: ranked, nextUp: warmReady ? { item: warmReady, step: 'send' } : pickNextUp(ranked) };
}

export interface EmailQueue {
  rows: QueueRow[]; // ranked
  nextUp: NextUp<QueueRow> | null;
  truncated: boolean;
}

// `closed` are tasks the rep just sent or dropped. HubSpot's search index
// trails a write by a few seconds, so the search may still return them.
export async function loadEmailQueue(
  hs: HubSpot,
  closed: string[] = [],
  now: number = Date.now(),
  timeZone: string = 'UTC'
): Promise<EmailQueue> {
  const { tasks, truncated } = await loadOpenTasks(hs, 'EMAIL', [
    'hs_task_subject',
    'hs_task_body',
    'hs_createdate',
    'hs_timestamp',
  ]);
  const { endMs } = dayBounds(now, timeZone);

  const rows: QueueRow[] = tasks
    .filter(({ task }) => !closed.includes(task.id))
    .map(({ task, contact, company }) => {
      const subject = task.properties.hs_task_subject ?? '(no subject)';
      const due = parseHubSpotTime(task.properties.hs_timestamp);
      return {
        taskId: task.id,
        subject,
        createdAt: task.properties.hs_createdate,
        // Only a "Subject: …" draft can be sent. A task holding just a note
        // (e.g. "skip this one") still needs drafting.
        hasDraft: parseTaskBody(task.properties.hs_task_body ?? '') !== null,
        contactName: contact ? contactName(contact) : null,
        companyName: companyName(company),
        fit: parseFitLabel(company?.properties.description),
        warm: isWarmFollowUp(subject) && due !== null && due < endMs,
      };
    });

  return { ...rankQueue(rows), truncated };
}

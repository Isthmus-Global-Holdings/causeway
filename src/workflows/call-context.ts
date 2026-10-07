// What the rep reads before and during a call: the contact's HubSpot notes,
// earlier calls and emails. Read-only. Each kind loads on its own, so one
// HubSpot failure (a missing scope, say) leaves the others on the page.

import { parseHubSpotTime } from '../lib/dates';
import { missingScopes, type HubSpot, type HubSpotObject } from '../lib/hubspot';
import { htmlToText } from '../lib/richtext';
import { CALL_OUTCOMES } from './call-logged';
import { loadContactNotes, type TaskParties } from './parties';

// Per kind: enough to see the story without scrolling through years of it.
const PER_KIND = 10;
const NOTE_CHARS = 1_500;
const CALL_CHARS = 600;
const EMAIL_CHARS = 300;

export type HistoryKind = 'note' | 'call' | 'email';

export interface HistoryItem {
  kind: HistoryKind;
  id: string;
  at: number | null; // epoch ms
  title: string;
  detail: string | null; // direction, outcome, length
  text: string; // clipped to a preview
  fullText: string | null; // the whole text, when the preview is clipped
}

export interface HistorySection {
  items: HistoryItem[];
  failed: boolean;
  missingScopes: string[]; // when HubSpot refused for lack of a scope (any one of these)
}

export interface CallContext {
  notes: HistorySection;
  calls: HistorySection;
  emails: HistorySection;
}

// The contact links a page asks loadTask or loadMeeting for, so the history
// needs only a batch read of each.
export const HISTORY_LINKS = ['notes', 'calls', 'emails'] as const;

// Also for an interview's prep page: only the contact is read. When the page
// read the contact's links with it (`related`), those ids are used.
export async function loadCallContext(
  hs: HubSpot,
  parties: Pick<TaskParties, 'contact' | 'related'>
): Promise<CallContext> {
  const contactId = parties.contact.id;
  const known = parties.related ?? {};
  const [notes, calls, emails] = await Promise.all([
    section('notes', async () =>
      (await loadContactNotes(hs, contactId, PER_KIND, known.notes)).map((n): HistoryItem => ({
        kind: 'note',
        id: n.id,
        at: parseHubSpotTime(n.timestamp),
        title: 'Note',
        detail: null,
        ...clip(n.text, NOTE_CHARS),
      }))
    ),
    section('calls', async () =>
      newest(
        await associated(hs, contactId, 'calls', known.calls, [
          'hs_call_title',
          'hs_call_body',
          'hs_call_disposition',
          'hs_call_direction',
          'hs_call_duration',
          'hs_timestamp',
        ])
      ).map(callItem)
    ),
    section('emails', async () =>
      newest(
        await associated(hs, contactId, 'emails', known.emails, [
          'hs_email_subject',
          'hs_email_direction',
          'hs_email_text',
          'hs_timestamp',
        ])
      ).map(emailItem)
    ),
  ]);
  return { notes, calls, emails };
}

// All three kinds in one timeline, newest first.
export function historyTimeline(context: CallContext): HistoryItem[] {
  return [...context.notes.items, ...context.calls.items, ...context.emails.items].sort(
    (a, b) => (b.at ?? 0) - (a.at ?? 0)
  );
}

async function section(what: string, load: () => Promise<HistoryItem[]>): Promise<HistorySection> {
  try {
    return { items: await load(), failed: false, missingScopes: [] };
  } catch (err) {
    console.error(`call context: loading ${what}`, err);
    return { items: [], failed: true, missingScopes: missingScopes(err) ?? [] };
  }
}

async function associated(
  hs: HubSpot,
  contactId: string,
  type: 'calls' | 'emails',
  knownIds: string[] | undefined,
  properties: string[]
): Promise<HubSpotObject[]> {
  const ids = knownIds ?? (await hs.associatedIds('contacts', contactId, type));
  return ids.length ? hs.batchRead(type, ids, properties) : [];
}

function newest(objects: HubSpotObject[]): HubSpotObject[] {
  return objects
    .map((o) => ({ o, at: parseHubSpotTime(o.properties.hs_timestamp) ?? 0 }))
    .sort((a, b) => b.at - a.at)
    .slice(0, PER_KIND)
    .map(({ o }) => o);
}

function callItem(call: HubSpotObject): HistoryItem {
  const p = call.properties;
  const outcome = CALL_OUTCOMES.find((o) => o.disposition === p.hs_call_disposition)?.label ?? null;
  const direction =
    p.hs_call_direction === 'INBOUND' ? 'Inbound' : p.hs_call_direction === 'OUTBOUND' ? 'Outbound' : null;
  const ms = Number(p.hs_call_duration);
  const length = Number.isFinite(ms) && ms > 0 ? duration(ms) : null;
  return {
    kind: 'call',
    id: call.id,
    at: parseHubSpotTime(p.hs_timestamp),
    title: p.hs_call_title?.trim() || 'Call',
    detail: [direction, outcome, length].filter(Boolean).join(' · ') || null,
    ...clip(htmlToText(p.hs_call_body ?? ''), CALL_CHARS),
  };
}

const EMAIL_DIRECTIONS: Record<string, string> = {
  EMAIL: 'Sent',
  INCOMING_EMAIL: 'Received',
  FORWARDED_EMAIL: 'Forwarded',
};

function emailItem(email: HubSpotObject): HistoryItem {
  const p = email.properties;
  return {
    kind: 'email',
    id: email.id,
    at: parseHubSpotTime(p.hs_timestamp),
    title: p.hs_email_subject?.trim() || '(no subject)',
    detail: EMAIL_DIRECTIONS[p.hs_email_direction ?? ''] ?? null,
    ...clip(p.hs_email_text ?? '', EMAIL_CHARS),
  };
}

function duration(ms: number): string {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// A preview of at most `max` characters, and the whole text when that cut it
// short (a logged call's transcript, a long email), for the page to open.
export function clip(text: string, max: number): Pick<HistoryItem, 'text' | 'fullText'> {
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length > max
    ? { text: `${clean.slice(0, max).trimEnd()}…`, fullText: clean }
    : { text: clean, fullText: null };
}

// Contacts and companies on their own, not through a task: finding one,
// everything on its page, and Call or Email from it. Call and Email open the
// contact's open task of that type, or create one, so the call page and the
// draft page (with their logging and follow-ups) do the rest.

import type { ContactTaskLockStore, LoggedCallRecord } from '../lib/db';
import type { HubSpot, HubSpotObject } from '../lib/hubspot';
import { HISTORY_LINKS, loadCallContext, type CallContext } from './call-context';
import { MEETING_PROPS, meetingRow, type MeetingRow } from './meeting-queue';
import {
  COMPANY_PROPS,
  CONTACT_PROPS,
  companyName,
  contactName,
  firstPhone,
  WorkflowError,
  type TaskType,
} from './parties';

// One page of search results. Past that, the rep narrows the search.
export const LIST_LIMIT = 50;
// The completed tasks a page lists, newest first.
const COMPLETED_SHOWN = 10;
// Long enough for one HubSpot read and one create.
const LOCK_TTL_SEC = 30;

const RECORD_CONTACT_PROPS = [...CONTACT_PROPS, 'hubspot_owner_id'];
export const TASK_LIST_PROPS = [
  'hs_task_subject',
  'hs_task_type',
  'hs_task_status',
  'hs_timestamp',
  'hs_task_completion_date',
];

export interface ContactRow {
  contact: HubSpotObject;
  company: HubSpotObject | null;
}

// Contacts matching the search (or the most recently changed), each with
// their first company's name: three rounds of requests.
export async function searchContactList(hs: HubSpot, query: string | null): Promise<ContactRow[]> {
  const contacts = await hs.searchRecords('contacts', query, CONTACT_PROPS, LIST_LIMIT);
  if (contacts.length === 0) return [];
  const links = await hs.batchAssociatedIds(
    'contacts',
    contacts.map((c) => c.id),
    'companies'
  );
  const companyIds = [...new Set(contacts.map((c) => links.get(c.id)?.[0]).filter((id): id is string => Boolean(id)))];
  const companies = companyIds.length ? await hs.batchRead('companies', companyIds, ['name', 'domain']) : [];
  const byId = new Map(companies.map((c) => [c.id, c]));
  return contacts.map((contact) => ({ contact, company: byId.get(links.get(contact.id)?.[0] ?? '') ?? null }));
}

// The names on "Sent from this app": one batch read of the contacts and one
// of the companies, together. A failed read leaves its names out, and the
// table shows the email address instead.
export interface RecordNames {
  contacts: Map<string, string>;
  companies: Map<string, string>;
}

export async function recordNames(
  hs: HubSpot,
  rows: { contact_id: string; company_id: string | null }[]
): Promise<RecordNames> {
  const contactIds = rows.map((r) => r.contact_id);
  const companyIds = rows.map((r) => r.company_id).filter((id): id is string => Boolean(id));
  const read = (type: 'contacts' | 'companies', ids: string[], properties: string[]) =>
    ids.length ? hs.batchRead(type, ids, properties).catch(() => []) : Promise.resolve([]);
  const [contacts, companies] = await Promise.all([
    read('contacts', contactIds, ['firstname', 'lastname', 'email']),
    read('companies', companyIds, ['name', 'domain']),
  ]);
  return {
    contacts: new Map(contacts.map((c) => [c.id, contactName(c)])),
    companies: new Map(companies.map((c) => [c.id, companyName(c) ?? ''])),
  };
}

export async function searchCompanyList(hs: HubSpot, query: string | null): Promise<HubSpotObject[]> {
  return hs.searchRecords('companies', query, COMPANY_PROPS, LIST_LIMIT);
}

export interface RecordTasks {
  open: HubSpotObject[]; // soonest due first
  completed: HubSpotObject[]; // most recently completed first
  failed: boolean;
}

export function isOpenTask(task: HubSpotObject): boolean {
  const status = task.properties.hs_task_status;
  return status !== 'COMPLETED' && status !== 'DEFERRED';
}

function time(value: string | null | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

async function readTasks(hs: HubSpot, ids: string[]): Promise<RecordTasks> {
  try {
    const tasks = ids.length ? await hs.batchRead('tasks', ids, TASK_LIST_PROPS) : [];
    const doneAt = (t: HubSpotObject) => time(t.properties.hs_task_completion_date ?? t.properties.hs_timestamp);
    return {
      open: tasks.filter(isOpenTask).sort((a, b) => time(a.properties.hs_timestamp) - time(b.properties.hs_timestamp)),
      completed: tasks
        .filter((t) => t.properties.hs_task_status === 'COMPLETED')
        .sort((a, b) => doneAt(b) - doneAt(a))
        .slice(0, COMPLETED_SHOWN),
      failed: false,
    };
  } catch (err) {
    console.error('tasks for record page', err);
    return { open: [], completed: [], failed: true };
  }
}

export interface ContactRecord {
  contact: HubSpotObject;
  company: HubSpotObject | null;
  tasks: RecordTasks;
  meetings: MeetingRow[] | null; // newest first; null when HubSpot couldn't be read
  context: CallContext;
}

// The contact with its first company, tasks, interviews and HubSpot history:
// the contact with its links, then everything else side by side.
export async function loadContactRecord(
  hs: HubSpot,
  contactId: string,
  records?: (callIds: string[]) => Promise<LoggedCallRecord[]>
): Promise<ContactRecord> {
  const { object: contact, associated } = await hs.getWithAssociations('contacts', contactId, RECORD_CONTACT_PROPS, [
    'companies',
    'tasks',
    'meetings',
    ...HISTORY_LINKS,
  ]);
  const companyId = associated.get('companies')?.[0] ?? null;
  const meetingIds = associated.get('meetings') ?? [];
  const related = Object.fromEntries(HISTORY_LINKS.map((t) => [t, associated.get(t) ?? []]));
  const [company, tasks, meetings, context] = await Promise.all([
    companyId ? hs.getObject('companies', companyId, COMPANY_PROPS) : Promise.resolve(null),
    readTasks(hs, associated.get('tasks') ?? []),
    (meetingIds.length ? hs.batchRead('meetings', meetingIds, MEETING_PROPS) : Promise.resolve([])).then(
      (list) =>
        list
          .map((m) => meetingRow(m, { contact: null, company: null }))
          .sort((a, b) => (b.startAt ?? 0) - (a.startAt ?? 0)),
      (err: unknown) => {
        console.error('interviews for contact page', err);
        return null;
      }
    ),
    loadCallContext(hs, { contact, related }, records),
  ]);
  return { contact, company, tasks, meetings, context };
}

export interface CompanyRecord {
  company: HubSpotObject;
  contacts: HubSpotObject[];
  tasks: RecordTasks;
}

export async function loadCompanyRecord(hs: HubSpot, companyId: string): Promise<CompanyRecord> {
  const { object: company, associated } = await hs.getWithAssociations('companies', companyId, COMPANY_PROPS, [
    'contacts',
    'tasks',
  ]);
  const contactIds = associated.get('contacts') ?? [];
  const [contacts, tasks] = await Promise.all([
    contactIds.length ? hs.batchRead('contacts', contactIds, CONTACT_PROPS) : Promise.resolve([]),
    readTasks(hs, associated.get('tasks') ?? []),
  ]);
  contacts.sort((a, b) => contactName(a).localeCompare(contactName(b)));
  return { company, contacts, tasks };
}

export interface ContactTaskDeps {
  hs: HubSpot;
  locks: ContactTaskLockStore;
}

export interface ContactTaskResult {
  taskId: string;
  created: boolean; // false: the contact's open task was reused
}

const NOUN: Record<TaskType, string> = { CALL: 'call', EMAIL: 'email' };

// Call or Email on a contact's (or their company's) page: the contact's open
// task of that type, soonest due, or a new one due now. Safe to repeat: a
// task HubSpot created is on the contact, so a retry finds and reuses it, and
// the lock keeps a double click from creating two at once. `companyId` is the
// company page it came from, used when the contact belongs to it.
export async function taskForContact(
  deps: ContactTaskDeps,
  contactId: string,
  type: TaskType,
  opts: { now: number; companyId?: string | null }
): Promise<ContactTaskResult> {
  const nowSec = Math.floor(opts.now / 1000);
  const lease = await deps.locks.acquire(contactId, type, nowSec, LOCK_TTL_SEC);
  if (lease === null) {
    throw new WorkflowError(
      `Already opening a ${NOUN[type]} task for this contact. Wait a few seconds and try again.`,
      409
    );
  }
  try {
    const { hs } = deps;
    const { object: contact, associated } = await hs.getWithAssociations('contacts', contactId, RECORD_CONTACT_PROPS, [
      'tasks',
      'companies',
    ]);
    const companyIds = associated.get('companies') ?? [];
    const companyId = opts.companyId && companyIds.includes(opts.companyId) ? opts.companyId : (companyIds[0] ?? null);
    const taskIds = associated.get('tasks') ?? [];
    const [tasks, company] = await Promise.all([
      taskIds.length ? hs.batchRead('tasks', taskIds, TASK_LIST_PROPS) : Promise.resolve([]),
      companyId ? hs.getObject('companies', companyId, COMPANY_PROPS) : Promise.resolve(null),
    ]);
    const open = tasks
      .filter((t) => t.properties.hs_task_type === type && isOpenTask(t))
      .sort((a, b) => time(a.properties.hs_timestamp) - time(b.properties.hs_timestamp))[0];
    if (open) return { taskId: open.id, created: false };

    const name = contactName(contact);
    if (type === 'EMAIL' && !contact.properties.email?.trim()) {
      throw new WorkflowError(`${name} has no email address in HubSpot. Add one there, then try again.`);
    }
    if (type === 'CALL' && !firstPhone(contact, company)) {
      throw new WorkflowError(
        `No number the app can dial for ${name}: add a phone to the contact or their company in HubSpot, then try again.`
      );
    }
    const company_ = companyName(company);
    const label = type === 'CALL' ? 'Call' : 'Email';
    const owner = contact.properties.hubspot_owner_id;
    const taskId = await hs.createTask(
      {
        hs_task_type: type,
        hs_task_status: 'NOT_STARTED',
        hs_task_subject: company_ ? `${label}: ${company_} (${name})` : `${label}: ${name}`,
        hs_timestamp: new Date(opts.now).toISOString(),
        ...(owner ? { hubspot_owner_id: owner } : {}),
      },
      { contactId: contact.id, companyId }
    );
    return { taskId, created: true };
  } finally {
    await deps.locks.release(contactId, type, lease);
  }
}

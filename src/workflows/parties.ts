import type { HubSpot, HubSpotObject, ObjectType } from '../lib/hubspot';
import { toE164 } from '../lib/phone';
import { htmlToText } from '../lib/richtext';

export const TASK_PROPS = [
  'hs_task_subject',
  'hs_task_body',
  'hs_task_status',
  'hs_task_type',
  'hs_timestamp',
  'hs_createdate',
  'hubspot_owner_id',
];
export const CONTACT_PROPS = [
  'firstname',
  'lastname',
  'email',
  'jobtitle',
  'phone',
  'mobilephone',
  'hs_lead_status',
  'lifecyclestage',
  'address',
  'city',
  'state',
  'zip',
  'country',
];
export const COMPANY_PROPS = [
  'name',
  'domain',
  'description',
  'phone',
  'industry',
  'numberofemployees',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  'country',
];

export type TaskType = 'EMAIL' | 'CALL';

// 10 pages of 100. The CRM search API is capped at 10k results anyway; past
// 1,000 open tasks of one type these pages are the wrong tool.
const MAX_PAGES = 10;

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
  }
}

// The task's owner, to copy onto what the app creates from it: a follow-up
// task lands in the same person's task list, and a logged call shows them as
// the caller on the timeline.
export function ownerOf(task: HubSpotObject): { hubspot_owner_id: string } | Record<string, never> {
  const owner = task.properties.hubspot_owner_id;
  return owner ? { hubspot_owner_id: owner } : {};
}

export function contactName(contact: HubSpotObject): string {
  const p = contact.properties;
  const full = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
  return full || p.email || `Contact ${contact.id}`;
}

export function companyName(company: HubSpotObject | null): string | null {
  if (!company) return null;
  return company.properties.name || company.properties.domain || `Company ${company.id}`;
}

// The first dialable number for the contact: their phone, their mobile, then
// the company line.
export function firstPhone(contact: HubSpotObject | null, company: HubSpotObject | null): string | null {
  return (
    toE164(contact?.properties.phone) ?? toE164(contact?.properties.mobilephone) ?? toE164(company?.properties.phone)
  );
}

// What else the contact is linked to, when a page asked for it along with the
// contact (see loadTask's `related`): read in the same request, so the page
// needs only a batch read for each rather than two requests in a row.
export type ContactLinks = Partial<Record<ObjectType, string[]>>;

export interface TaskParties {
  task: HubSpotObject;
  contact: HubSpotObject;
  company: HubSpotObject | null;
  related?: ContactLinks;
}

// Loads a task of the given type with the Contact and Company it belongs to,
// and the ids of the contact's `related` records.
export async function loadTask(
  hs: HubSpot,
  taskId: string,
  type: TaskType,
  related: ObjectType[] = []
): Promise<TaskParties> {
  const { record: task, ...parties } = await loadRecordParties(
    hs,
    'tasks',
    taskId,
    TASK_PROPS,
    CONTACT_PROPS,
    related,
    {
      check: (t) => {
        if (t.properties.hs_task_type !== type) {
          throw new WorkflowError(`Task ${taskId} is a ${t.properties.hs_task_type ?? 'untyped'} task, not ${type}.`);
        }
      },
      noContact: `Task ${taskId} isn't associated with a contact.`,
    }
  );
  return { task, ...parties };
}

// A task or meeting with its first Contact and Company, in as few requests
// in a row as HubSpot allows: the record with its links, then the contact
// (with its own links) and the record's company together. The record's own
// company link wins; otherwise the contact's first company is read after.
export async function loadRecordParties(
  hs: HubSpot,
  type: 'tasks' | 'meetings',
  id: string,
  recordProps: string[],
  contactProps: string[],
  related: ObjectType[],
  opts: { check: (record: HubSpotObject) => void; noContact: string }
): Promise<{ record: HubSpotObject; contact: HubSpotObject; company: HubSpotObject | null; related: ContactLinks }> {
  const { object: record, associated } = await hs.getWithAssociations(type, id, recordProps, ['contacts', 'companies']);
  opts.check(record);
  const contactId = associated.get('contacts')?.[0];
  if (!contactId) throw new WorkflowError(opts.noContact, 409);
  const recordCompanyId = associated.get('companies')?.[0] ?? null;

  const contactLinks: ObjectType[] = [...new Set([...(recordCompanyId ? [] : ['companies' as const]), ...related])];
  const [contactRead, recordCompany] = await Promise.all([
    hs.getWithAssociations('contacts', contactId, contactProps, contactLinks),
    recordCompanyId ? hs.getObject('companies', recordCompanyId, COMPANY_PROPS) : Promise.resolve(null),
  ]);
  const contactCompanyId = recordCompanyId ? null : (contactRead.associated.get('companies')?.[0] ?? null);
  const company =
    recordCompany ?? (contactCompanyId ? await hs.getObject('companies', contactCompanyId, COMPANY_PROPS) : null);

  const links: ContactLinks = {};
  for (const t of related) links[t] = contactRead.associated.get(t) ?? [];
  return { record, contact: contactRead.object, company, related: links };
}

export interface ContactNote {
  id: string;
  text: string;
  timestamp: string | null;
}

// The contact's HubSpot notes as plain text, newest first. `knownIds` are
// the note ids when the page already read them with the contact.
export async function loadContactNotes(
  hs: HubSpot,
  contactId: string,
  limit: number,
  knownIds?: string[]
): Promise<ContactNote[]> {
  const ids = knownIds ?? (await hs.associatedIds('contacts', contactId, 'notes'));
  const notes = ids.length ? await hs.batchRead('notes', ids, ['hs_note_body', 'hs_timestamp']) : [];
  return notes
    .map((n) => ({ id: n.id, text: htmlToText(n.properties.hs_note_body ?? ''), timestamp: n.properties.hs_timestamp }))
    .filter((n) => n.text)
    .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
    .slice(0, limit);
}

// Guards the gap between creating a task in HubSpot and recording its id in
// D1: if a run died there, the task exists but D1 doesn't know. The caller
// reuses it instead of creating a second one.
export async function findOpenTask(
  hs: HubSpot,
  contactId: string,
  type: TaskType,
  subject: string,
  knownTaskIds?: string[] // the contact's task ids, when read with it in this same run
): Promise<string | null> {
  const taskIds = knownTaskIds ?? (await hs.associatedIds('contacts', contactId, 'tasks'));
  if (taskIds.length === 0) return null;
  const tasks = await hs.batchRead('tasks', taskIds, ['hs_task_subject', 'hs_task_type', 'hs_task_status']);
  const match = tasks.find(
    (t) =>
      t.properties.hs_task_type === type &&
      t.properties.hs_task_status !== 'COMPLETED' &&
      t.properties.hs_task_subject === subject
  );
  return match?.id ?? null;
}

export interface OpenTask {
  task: HubSpotObject;
  contact: HubSpotObject | null;
  company: HubSpotObject | null;
}

// Every NOT_STARTED task of one type, each with its first Contact and Company,
// in a handful of batch requests rather than several per task.
export async function loadOpenTasks(
  hs: HubSpot,
  type: TaskType,
  properties: string[]
): Promise<{ tasks: OpenTask[]; truncated: boolean }> {
  const tasks: HubSpotObject[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const page = await hs.searchTasks(
      [
        { propertyName: 'hs_task_type', operator: 'EQ', value: type },
        { propertyName: 'hs_task_status', operator: 'EQ', value: 'NOT_STARTED' },
      ],
      properties,
      after
    );
    tasks.push(...page.results);
    after = page.after;
    pages += 1;
  } while (after && pages < MAX_PAGES);

  const parties = await resolveParties(hs, 'tasks', tasks);
  return {
    tasks: tasks.map((task) => ({ task, ...parties(task.id) })),
    truncated: after !== null,
  };
}

export interface Parties {
  contact: HubSpotObject | null;
  company: HubSpotObject | null;
}

// The first Contact and Company of each record (a task or a meeting), in a
// handful of batch requests rather than several per record. A record with no
// company of its own uses its contact's first company, like loadTask (where a
// small carrier's only phone number often is).
export async function resolveParties(
  hs: HubSpot,
  from: ObjectType,
  records: HubSpotObject[]
): Promise<(id: string) => Parties> {
  const ids = records.map((r) => r.id);
  if (ids.length === 0) return () => ({ contact: null, company: null });
  const [recordContacts, recordCompanies] = await Promise.all([
    hs.batchAssociatedIds(from, ids, 'contacts'),
    hs.batchAssociatedIds(from, ids, 'companies'),
  ]);

  const contactIds = [...recordContacts.values()].map((list) => list[0]).filter(Boolean);
  const needContactCompany = ids
    .filter((id) => !recordCompanies.get(id)?.length)
    .map((id) => recordContacts.get(id)?.[0])
    .filter((id): id is string => Boolean(id));
  const contactCompanies = needContactCompany.length
    ? await hs.batchAssociatedIds('contacts', needContactCompany, 'companies')
    : new Map<string, string[]>();
  const companyOf = (id: string): string | undefined =>
    recordCompanies.get(id)?.[0] ?? contactCompanies.get(recordContacts.get(id)?.[0] ?? '')?.[0];
  const companyIds = ids.map(companyOf).filter((id): id is string => Boolean(id));
  const [contacts, companies] = await Promise.all([
    contactIds.length ? hs.batchRead('contacts', contactIds, CONTACT_PROPS) : Promise.resolve([]),
    companyIds.length ? hs.batchRead('companies', companyIds, COMPANY_PROPS) : Promise.resolve([]),
  ]);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const companyById = new Map(companies.map((c) => [c.id, c]));

  return (id) => ({
    contact: contactById.get(recordContacts.get(id)?.[0] ?? '') ?? null,
    company: companyById.get(companyOf(id) ?? '') ?? null,
  });
}

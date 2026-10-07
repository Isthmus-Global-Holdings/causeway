// Thin wrapper over the handful of HubSpot CRM endpoints this app uses.
// No SDK: @hubspot/api-client is a large generated client, and every call here
// is one fetch with a Bearer token.

const BASE_URL = 'https://api.hubapi.com';

// HubSpot's date-based API version. Each is supported for 18 months after
// its release (March and September); move to the newest before then. Every
// path below is the legacy v3/v4 one under this prefix, same requests and
// responses.
const API_VERSION = '2026-09';
const OBJECTS = `/crm/objects/${API_VERSION}`;
const ASSOCIATIONS = `/crm/associations/${API_VERSION}`;

// HUBSPOT_DEFINED default association types for creating a task already
// linked to its records. Confirm with GET /crm/associations/2026-09/tasks/contacts/labels
// (and .../tasks/companies/labels) if HubSpot ever rejects them.
// Confirmed against this account with GET /crm/v4/associations/{from}/{to}/labels.
const TASK_TO_CONTACT = 204;
const TASK_TO_COMPANY = 192;
const EMAIL_TO_CONTACT = 198;
const EMAIL_TO_COMPANY = 186;
const NOTE_TO_CONTACT = 202;
const NOTE_TO_COMPANY = 190;
// Calls: from HubSpot's association type table, not yet confirmed on the account.
const CALL_TO_CONTACT = 194;
const CALL_TO_COMPANY = 182;
// Meetings: from HubSpot's association type table, not yet confirmed on the account.
const MEETING_TO_CONTACT = 200;
const MEETING_TO_COMPANY = 188;
// Communications (a WhatsApp message): from HubSpot's association type table,
// not yet confirmed on the account.
const COMMUNICATION_TO_CONTACT = 81;
const COMMUNICATION_TO_COMPANY = 87;

// Batch endpoints accept at most 100 inputs per request.
const BATCH_SIZE = 100;

export type ObjectType =
  'tasks' | 'contacts' | 'companies' | 'notes' | 'calls' | 'emails' | 'meetings' | 'deals' | 'communications';

export interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
}

export type SearchFilter =
  | { propertyName: string; operator: 'EQ' | 'NEQ' | 'GTE' | 'LTE'; value: string }
  | { propertyName: string; operator: 'IN'; values: string[] };

export interface RecordLinks {
  contactId: string;
  companyId: string | null;
}

export interface LoggedEmail {
  subject: string;
  html: string;
  text: string;
  from: { email: string; firstName?: string; lastName?: string };
  to: { email: string };
  sentAt: string; // ISO
}

// HubSpot's call statuses that a finished Twilio leg can map to.
export type CallStatus = 'COMPLETED' | 'BUSY' | 'NO_ANSWER' | 'FAILED' | 'CANCELED';

export interface LoggedCall {
  title: string;
  bodyHtml: string;
  status: CallStatus;
  disposition: string; // a call outcome GUID, see CALL_OUTCOMES in workflows/call-logged.ts
  durationMs: number | null;
  fromNumber: string | null;
  toNumber: string | null;
  ownerId: string | null; // shown as the caller on the timeline
  at: string; // ISO
  direction?: 'INBOUND' | 'OUTBOUND'; // OUTBOUND unless given
}

// A message sent outside HubSpot, on a channel HubSpot logs as a
// communication. The app only logs WhatsApp messages the rep sent.
export interface LoggedMessage {
  channel: 'WHATS_APP' | 'SMS';
  bodyHtml: string;
  ownerId: string | null;
  at: string; // ISO
}

// HubSpot's meeting outcomes. A meeting created in HubSpot's own UI may have
// none, which means scheduled.
export const MEETING_OUTCOMES = ['SCHEDULED', 'COMPLETED', 'RESCHEDULED', 'NO_SHOW', 'CANCELED'] as const;
export type MeetingOutcome = (typeof MEETING_OUTCOMES)[number];

export interface NewMeeting {
  title: string;
  bodyHtml: string; // shown to attendees in HubSpot's meeting description
  startAt: string; // ISO
  endAt: string; // ISO
  joinUrl: string | null; // a video link, e.g. Google Meet
  location: string | null; // e.g. "Phone: +1 801-555-0130" for a phone interview
  ownerId: string | null;
}

export interface SearchPage {
  results: HubSpotObject[];
  after: string | null;
}

export class HubSpotApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string
  ) {
    super(`HubSpot API ${status} on ${path}: ${body.slice(0, 500)}`);
  }
}

// The scopes a 403 says the app lacks (HubSpot lists alternatives: any one
// will do). Null when the error isn't a missing-scope refusal.
export function missingScopes(err: unknown): string[] | null {
  if (!(err instanceof HubSpotApiError) || err.status !== 403) return null;
  try {
    const body = JSON.parse(err.body) as {
      category?: string;
      errors?: { context?: { requiredGranularScopes?: unknown } }[];
    };
    if (body.category !== 'MISSING_SCOPES') return null;
    const scopes = (body.errors ?? []).flatMap((e) => e.context?.requiredGranularScopes ?? []);
    return scopes.filter((s): s is string => typeof s === 'string');
  } catch {
    return null;
  }
}

export class RateLimitError extends HubSpotApiError {
  constructor(
    readonly retryAfterSec: number,
    body: string,
    path: string
  ) {
    super(429, body, path);
  }
}

// The workflows depend on this interface rather than on fetch, so tests can
// hand them an in-memory fake.
export interface HubSpot {
  getObject(type: ObjectType, id: string, properties: string[]): Promise<HubSpotObject>;
  // The record whose unique-value property holds `value`, or null if none does.
  getByUniqueValue(
    type: ObjectType,
    property: string,
    value: string,
    properties: string[]
  ): Promise<HubSpotObject | null>;
  // The record and the ids of what it's associated with, in one request (a
  // type with more than fit in the response is read in full separately).
  getWithAssociations(
    type: ObjectType,
    id: string,
    properties: string[],
    to: ObjectType[]
  ): Promise<{ object: HubSpotObject; associated: Map<ObjectType, string[]> }>;
  updateObject(type: ObjectType, id: string, properties: Record<string, string>): Promise<void>;
  batchRead(type: ObjectType, ids: string[], properties: string[]): Promise<HubSpotObject[]>;
  createTask(properties: Record<string, string>, links: RecordLinks): Promise<string>;
  // Puts an email sent outside HubSpot on the contact's timeline, the way
  // HubSpot's own sends appear.
  logEmail(email: LoggedEmail, links: RecordLinks): Promise<string>;
  createNote(bodyHtml: string, links: RecordLinks): Promise<string>;
  // Puts a call made outside HubSpot on the contact's timeline, with its outcome.
  logCall(call: LoggedCall, links: RecordLinks): Promise<string>;
  // Puts a message sent outside HubSpot (WhatsApp) on the contact's timeline.
  logMessage(message: LoggedMessage, links: RecordLinks): Promise<string>;
  // Puts a scheduled meeting (an interview) on the contact's timeline.
  createMeeting(meeting: NewMeeting, links: RecordLinks): Promise<string>;
  // A deal on its own (an Upwork pitch): no contact or company yet.
  createDeal(properties: Record<string, string>): Promise<string>;
  searchTasks(filters: SearchFilter[], properties: string[], after: string | null): Promise<SearchPage>;
  // Meetings matching the filters, soonest start first.
  searchMeetings(filters: SearchFilter[], properties: string[], after: string | null): Promise<SearchPage>;
  // One page of contacts matching any of the filter groups, most recently
  // changed first.
  searchContacts(filterGroups: SearchFilter[][], properties: string[], limit: number): Promise<HubSpotObject[]>;
  // One page of contacts or companies matching HubSpot's free-text search
  // (name, email, phone, domain…), or every one when `query` is null, most
  // recently changed first.
  searchRecords(
    type: 'contacts' | 'companies',
    query: string | null,
    properties: string[],
    limit: number
  ): Promise<HubSpotObject[]>;
  associatedIds(from: ObjectType, id: string, to: ObjectType): Promise<string[]>;
  batchAssociatedIds(from: ObjectType, ids: string[], to: ObjectType): Promise<Map<string, string[]>>;
}

function associationsFor(links: RecordLinks, toContactType: number, toCompanyType: number) {
  const link = (id: string, typeId: number) => ({
    to: { id },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
  });
  return [link(links.contactId, toContactType), ...(links.companyId ? [link(links.companyId, toCompanyType)] : [])];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createHubSpot(token: string, fetchImpl: typeof fetch = fetch): HubSpot {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const start = Date.now();
    const res = await fetchImpl(BASE_URL + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // Every page waits on these, so each one's time goes to Workers Logs.
    console.log(
      JSON.stringify({ hubspot: `${method} ${path.split('?')[0]}`, status: res.status, ms: Date.now() - start })
    );
    if (res.status === 429) {
      throw new RateLimitError(Number(res.headers.get('Retry-After') ?? '10'), text, path);
    }
    // Batch endpoints answer 207 Multi-Status when some inputs had no data;
    // that's still a usable response.
    if (!res.ok) throw new HubSpotApiError(res.status, text, path);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function search(
    type: ObjectType,
    filters: SearchFilter[],
    properties: string[],
    sortBy: string,
    after: string | null
  ): Promise<SearchPage> {
    const res = await request<{ results: HubSpotObject[]; paging?: { next?: { after: string } } }>(
      'POST',
      `${OBJECTS}/${type}/search`,
      {
        filterGroups: [{ filters }],
        properties,
        sorts: [{ propertyName: sortBy, direction: 'ASCENDING' }],
        limit: 100,
        ...(after ? { after } : {}),
      }
    );
    return { results: res.results, after: res.paging?.next?.after ?? null };
  }

  // Every page: a contact's calls or emails can run past one page of 500,
  // and a partial set can't say which are newest.
  async function associatedIds(from: ObjectType, id: string, to: ObjectType): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    do {
      const res: { results: { toObjectId: number | string }[]; paging?: { next?: { after: string } } } = await request(
        'GET',
        `${OBJECTS}/${from}/${encodeURIComponent(id)}/associations/${to}?limit=500${after ? `&after=${encodeURIComponent(after)}` : ''}`
      );
      ids.push(...res.results.map((r) => String(r.toObjectId)));
      after = res.paging?.next?.after ?? null;
    } while (after);
    return ids;
  }

  function propsQuery(properties: string[]): string {
    return properties.length ? `?properties=${properties.map(encodeURIComponent).join(',')}` : '';
  }

  return {
    async getObject(type, id, properties) {
      return request<HubSpotObject>('GET', `${OBJECTS}/${type}/${encodeURIComponent(id)}${propsQuery(properties)}`);
    },

    async getByUniqueValue(type, property, value, properties) {
      const query = new URLSearchParams({ idProperty: property });
      if (properties.length) query.set('properties', properties.join(','));
      try {
        return await request<HubSpotObject>('GET', `${OBJECTS}/${type}/${encodeURIComponent(value)}?${query}`);
      } catch (err) {
        if (err instanceof HubSpotApiError && err.status === 404) return null;
        throw err;
      }
    },

    async getWithAssociations(type, id, properties, to) {
      const query = new URLSearchParams();
      if (properties.length) query.set('properties', properties.join(','));
      if (to.length) query.set('associations', to.join(','));
      const res = await request<
        HubSpotObject & {
          associations?: Record<string, { results: { id: string | number }[]; paging?: { next?: unknown } }>;
        }
      >('GET', `${OBJECTS}/${type}/${encodeURIComponent(id)}?${query}`);
      const associated = new Map<ObjectType, string[]>();
      await Promise.all(
        to.map(async (t) => {
          const inline = res.associations?.[t];
          // A record linked twice (a primary and a plain link) is listed twice.
          const ids = inline?.paging?.next
            ? await associatedIds(type, id, t)
            : [...new Set((inline?.results ?? []).map((r) => String(r.id)))];
          associated.set(t, ids);
        })
      );
      return { object: { id: res.id, properties: res.properties }, associated };
    },

    async updateObject(type, id, properties) {
      await request('PATCH', `${OBJECTS}/${type}/${encodeURIComponent(id)}`, { properties });
    },

    // Chunks of 100, read at the same time.
    async batchRead(type, ids, properties) {
      const pages = await Promise.all(
        chunk([...new Set(ids)], BATCH_SIZE).map((group) =>
          request<{ results: HubSpotObject[] }>('POST', `${OBJECTS}/${type}/batch/read`, {
            properties,
            inputs: group.map((id) => ({ id })),
          })
        )
      );
      return pages.flatMap((res) => res.results);
    },

    async createTask(properties, links) {
      const res = await request<HubSpotObject>('POST', `${OBJECTS}/tasks`, {
        properties,
        associations: associationsFor(links, TASK_TO_CONTACT, TASK_TO_COMPANY),
      });
      return res.id;
    },

    async logEmail(email, links) {
      const res = await request<HubSpotObject>('POST', `${OBJECTS}/emails`, {
        properties: {
          hs_timestamp: email.sentAt,
          hs_email_direction: 'EMAIL',
          hs_email_status: 'SENT',
          hs_email_subject: email.subject,
          hs_email_html: email.html,
          hs_email_text: email.text,
          hs_email_headers: JSON.stringify({ from: email.from, to: [email.to] }),
        },
        associations: associationsFor(links, EMAIL_TO_CONTACT, EMAIL_TO_COMPANY),
      });
      return res.id;
    },

    async createNote(bodyHtml, links) {
      const res = await request<HubSpotObject>('POST', `${OBJECTS}/notes`, {
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: bodyHtml },
        associations: associationsFor(links, NOTE_TO_CONTACT, NOTE_TO_COMPANY),
      });
      return res.id;
    },

    async logCall(call, links) {
      const res = await request<HubSpotObject>('POST', `${OBJECTS}/calls`, {
        properties: {
          hs_timestamp: call.at,
          hs_call_title: call.title,
          hs_call_body: call.bodyHtml,
          hs_call_direction: call.direction ?? 'OUTBOUND',
          hs_call_status: call.status,
          hs_call_disposition: call.disposition,
          ...(call.durationMs === null ? {} : { hs_call_duration: String(call.durationMs) }),
          ...(call.fromNumber ? { hs_call_from_number: call.fromNumber } : {}),
          ...(call.toNumber ? { hs_call_to_number: call.toNumber } : {}),
          ...(call.ownerId ? { hubspot_owner_id: call.ownerId } : {}),
        },
        associations: associationsFor(links, CALL_TO_CONTACT, CALL_TO_COMPANY),
      });
      return res.id;
    },

    async logMessage(message, links) {
      const res = await request<HubSpotObject>('POST', `${OBJECTS}/communications`, {
        properties: {
          hs_timestamp: message.at,
          hs_communication_channel_type: message.channel,
          hs_communication_logged_from: 'CRM',
          hs_communication_body: message.bodyHtml,
          ...(message.ownerId ? { hubspot_owner_id: message.ownerId } : {}),
        },
        associations: associationsFor(links, COMMUNICATION_TO_CONTACT, COMMUNICATION_TO_COMPANY),
      });
      return res.id;
    },

    async createMeeting(meeting, links) {
      const res = await request<HubSpotObject>('POST', `${OBJECTS}/meetings`, {
        properties: {
          hs_timestamp: meeting.startAt,
          hs_meeting_start_time: meeting.startAt,
          hs_meeting_end_time: meeting.endAt,
          hs_meeting_title: meeting.title,
          hs_meeting_body: meeting.bodyHtml,
          hs_meeting_outcome: 'SCHEDULED',
          ...(meeting.joinUrl ? { hs_meeting_external_url: meeting.joinUrl } : {}),
          ...(meeting.location ? { hs_meeting_location: meeting.location } : {}),
          ...(meeting.ownerId ? { hubspot_owner_id: meeting.ownerId } : {}),
        },
        associations: associationsFor(links, MEETING_TO_CONTACT, MEETING_TO_COMPANY),
      });
      return res.id;
    },

    async createDeal(properties) {
      const res = await request<HubSpotObject>('POST', `${OBJECTS}/deals`, { properties });
      return res.id;
    },

    async searchTasks(filters, properties, after) {
      return search('tasks', filters, properties, 'hs_createdate', after);
    },

    async searchMeetings(filters, properties, after) {
      return search('meetings', filters, properties, 'hs_meeting_start_time', after);
    },

    async searchContacts(filterGroups, properties, limit) {
      const res = await request<{ results: HubSpotObject[] }>('POST', `${OBJECTS}/contacts/search`, {
        filterGroups: filterGroups.map((filters) => ({ filters })),
        properties,
        sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
        limit,
      });
      return res.results;
    },

    async searchRecords(type, query, properties, limit) {
      const res = await request<{ results: HubSpotObject[] }>('POST', `${OBJECTS}/${type}/search`, {
        ...(query ? { query } : {}),
        properties,
        sorts: [
          { propertyName: type === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate', direction: 'DESCENDING' },
        ],
        limit,
      });
      return res.results;
    },

    associatedIds,

    async batchAssociatedIds(from, ids, to) {
      const map = new Map<string, string[]>();
      const pages = await Promise.all(
        chunk([...new Set(ids)], BATCH_SIZE).map((group) =>
          request<{ results: { from: { id: string }; to: { toObjectId: number | string }[] }[] }>(
            'POST',
            `${ASSOCIATIONS}/${from}/${to}/batch/read`,
            { inputs: group.map((id) => ({ id })) }
          )
        )
      );
      for (const res of pages) {
        for (const row of res.results) {
          map.set(
            String(row.from.id),
            row.to.map((t) => String(t.toObjectId))
          );
        }
      }
      return map;
    },
  };
}

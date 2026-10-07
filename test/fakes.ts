// In-memory stand-ins for HubSpot and D1, shared by the workflow tests.

import type { Confirmation, ConfirmationStore, NewSentEmail, SentEmail, SentEmailStore } from '../src/lib/db.ts';
import {
  HubSpotApiError,
  type HubSpot,
  type HubSpotObject,
  type LoggedCall,
  type LoggedEmail,
  type LoggedMessage,
  type NewMeeting,
  type ObjectType,
  type RecordLinks,
  type SearchFilter,
} from '../src/lib/hubspot.ts';

export class FakeHubSpot implements HubSpot {
  objects = new Map<string, HubSpotObject>(); // key: `${type}/${id}`
  links = new Map<string, string[]>(); // key: `${from}/${id}/${to}`
  created: { properties: Record<string, string>; links: RecordLinks }[] = [];
  loggedEmails: { email: LoggedEmail; links: RecordLinks }[] = [];
  notes: { bodyHtml: string; links: RecordLinks }[] = [];
  calls: { call: LoggedCall; links: RecordLinks }[] = [];
  messages: { message: LoggedMessage; links: RecordLinks }[] = [];
  failNextLogMessage: Error | null = null;
  meetings: { meeting: NewMeeting; links: RecordLinks }[] = [];
  failNextCreateMeeting: Error | null = null;
  failNextLogCall: Error | null = null;
  failNextCreate = false;
  failNextLog: Error | null = null;
  private nextId = 900;

  // Every read, by method, and how many rounds of reads a page waited on:
  // reads started together (before any of them answers) share a round, like
  // requests in one Promise.all. Each read answers on a later turn of the
  // event loop, as a real request would.
  reads: string[] = [];
  waves = 0;
  private waveOpen = false;
  private async roundTrip(method: string) {
    this.reads.push(method);
    if (!this.waveOpen) {
      this.waveOpen = true;
      this.waves += 1;
      setImmediate(() => (this.waveOpen = false));
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  put(type: ObjectType, id: string, properties: Record<string, string | null>) {
    this.objects.set(`${type}/${id}`, { id, properties });
  }

  link(from: ObjectType, id: string, to: ObjectType, toId: string) {
    const key = `${from}/${id}/${to}`;
    this.links.set(key, [...(this.links.get(key) ?? []), toId]);
  }

  async getObject(type: ObjectType, id: string) {
    await this.roundTrip('getObject');
    const obj = this.objects.get(`${type}/${id}`);
    if (!obj) throw new Error(`no ${type}/${id}`);
    return structuredClone(obj);
  }

  // Like a unique-value property's lookup (?idProperty=): the one record
  // holding the value, or null.
  async getByUniqueValue(type: ObjectType, property: string, value: string) {
    await this.roundTrip('getByUniqueValue');
    const found = [...this.objects.entries()].find(
      ([key, obj]) => key.startsWith(`${type}/`) && obj.properties[property] === value
    );
    return found ? structuredClone(found[1]) : null;
  }

  async getWithAssociations(type: ObjectType, id: string, _properties: string[], to: ObjectType[]) {
    await this.roundTrip('getWithAssociations');
    const obj = this.objects.get(`${type}/${id}`);
    if (!obj) throw new Error(`no ${type}/${id}`);
    const associated = new Map(to.map((t) => [t, [...(this.links.get(`${type}/${id}/${t}`) ?? [])]]));
    return { object: structuredClone(obj), associated };
  }

  async updateObject(type: ObjectType, id: string, properties: Record<string, string>) {
    const obj = this.objects.get(`${type}/${id}`);
    if (!obj) throw new Error(`no ${type}/${id}`);
    Object.assign(obj.properties, properties);
  }

  async batchRead(type: ObjectType, ids: string[]) {
    await this.roundTrip('batchRead');
    return ids.flatMap((id) => {
      const obj = this.objects.get(`${type}/${id}`);
      return obj ? [structuredClone(obj)] : [];
    });
  }

  async createTask(properties: Record<string, string>, links: { contactId: string; companyId: string | null }) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('HubSpot 500');
    }
    const id = String(this.nextId++);
    this.put('tasks', id, properties);
    this.link('contacts', links.contactId, 'tasks', id);
    this.created.push({ properties, links });
    return id;
  }

  async logEmail(email: LoggedEmail, links: RecordLinks) {
    if (this.failNextLog) {
      const err = this.failNextLog;
      this.failNextLog = null;
      throw err;
    }
    this.loggedEmails.push({ email, links });
    return `email-${this.loggedEmails.length}`;
  }

  async createNote(bodyHtml: string, links: RecordLinks) {
    this.notes.push({ bodyHtml, links });
    return `note-${this.notes.length}`;
  }

  async logCall(call: LoggedCall, links: RecordLinks) {
    if (this.failNextLogCall) {
      const err = this.failNextLogCall;
      this.failNextLogCall = null;
      throw err;
    }
    this.calls.push({ call, links });
    const id = `call-${this.calls.length}`;
    this.put('calls', id, { hs_call_title: call.title, hs_call_body: call.bodyHtml });
    return id;
  }

  async logMessage(message: LoggedMessage, links: RecordLinks) {
    if (this.failNextLogMessage) {
      const err = this.failNextLogMessage;
      this.failNextLogMessage = null;
      throw err;
    }
    this.messages.push({ message, links });
    return `message-${this.messages.length}`;
  }

  // Like HubSpot: a meeting is on the contact's (and company's) timeline, so
  // it's linked both ways.
  async createMeeting(meeting: NewMeeting, links: RecordLinks) {
    if (this.failNextCreateMeeting) {
      const err = this.failNextCreateMeeting;
      this.failNextCreateMeeting = null;
      throw err;
    }
    const id = `meeting-${this.meetings.length + 1}`;
    this.meetings.push({ meeting, links });
    this.put('meetings', id, {
      hs_meeting_title: meeting.title,
      hs_meeting_body: meeting.bodyHtml,
      hs_meeting_start_time: meeting.startAt,
      hs_meeting_end_time: meeting.endAt,
      hs_meeting_outcome: 'SCHEDULED',
      hs_meeting_external_url: meeting.joinUrl,
      hs_meeting_location: meeting.location,
      hubspot_owner_id: meeting.ownerId,
    });
    this.link('meetings', id, 'contacts', links.contactId);
    this.link('contacts', links.contactId, 'meetings', id);
    if (links.companyId) this.link('meetings', id, 'companies', links.companyId);
    return id;
  }

  // upwork_job_id is a unique-value property: HubSpot refuses a second deal
  // with the same value, as it does here.
  dealsCreated = 0;
  async createDeal(properties: Record<string, string>) {
    await this.roundTrip('createDeal');
    const taken = [...this.objects.entries()].some(
      ([key, obj]) => key.startsWith('deals/') && obj.properties.upwork_job_id === properties.upwork_job_id
    );
    if (taken) {
      throw new HubSpotApiError(400, '{"category":"VALIDATION_ERROR","message":"already has that value"}', '/deals');
    }
    this.dealsCreated += 1;
    const id = `deal-${this.dealsCreated}`;
    this.put('deals', id, properties);
    return id;
  }

  // One page with every stored object of the type matching the filters.
  // GTE/LTE compare times (epoch ms, or ISO in the stored properties).
  private search(type: ObjectType, filters: SearchFilter[]) {
    const time = (v: string | null | undefined) => (v ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN);
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${type}/`))
      .map(([, obj]) => structuredClone(obj))
      .filter((t) =>
        filters.every((f) => {
          const value = t.properties[f.propertyName];
          if (f.operator === 'IN') return f.values.includes(value ?? '');
          if (f.operator === 'GTE') return time(value) >= time(f.value);
          if (f.operator === 'LTE') return time(value) <= time(f.value);
          return (value === f.value) === (f.operator === 'EQ');
        })
      );
  }

  async searchTasks(filters: SearchFilter[]) {
    await this.roundTrip('searchTasks');
    return { results: this.search('tasks', filters), after: null };
  }

  meetingSearches = 0;
  async searchMeetings(filters: SearchFilter[]) {
    await this.roundTrip('searchMeetings');
    this.meetingSearches += 1;
    const start = (m: HubSpotObject) => Date.parse(m.properties.hs_meeting_start_time ?? '');
    return { results: this.search('meetings', filters).sort((a, b) => start(a) - start(b)), after: null };
  }

  searches: SearchFilter[][][] = [];
  failNextSearch: Error | null = null;

  // Contacts whose phone or mobile digits end with one of the IN values, the
  // way HubSpot's searchable phone properties drop the country code.
  async searchContacts(filterGroups: SearchFilter[][]) {
    if (this.failNextSearch) {
      const err = this.failNextSearch;
      this.failNextSearch = null;
      throw err;
    }
    this.searches.push(filterGroups);
    const values = filterGroups.flatMap((g) => g.flatMap((f) => (f.operator === 'IN' ? f.values : [f.value])));
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith('contacts/'))
      .map(([, obj]) => structuredClone(obj))
      .filter((c) =>
        [c.properties.phone, c.properties.mobilephone].some((p) => {
          const digits = (p ?? '').replace(/\D/g, '');
          return digits && values.some((v) => digits.endsWith(v));
        })
      );
  }

  // Records whose name, email, domain or phone contains the query, as
  // HubSpot's free-text search matches them; every one without a query.
  async searchRecords(type: 'contacts' | 'companies', query: string | null, _properties: string[], limit: number) {
    await this.roundTrip('searchRecords');
    const q = query?.toLowerCase() ?? '';
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${type}/`))
      .map(([, obj]) => structuredClone(obj))
      .filter((r) =>
        ['firstname', 'lastname', 'email', 'name', 'domain', 'phone'].some((k) =>
          (r.properties[k] ?? '').toLowerCase().includes(q)
        )
      )
      .slice(0, limit);
  }

  async associatedIds(from: ObjectType, id: string, to: ObjectType) {
    await this.roundTrip('associatedIds');
    return this.links.get(`${from}/${id}/${to}`) ?? [];
  }

  async batchAssociatedIds(from: ObjectType, ids: string[], to: ObjectType) {
    await this.roundTrip('batchAssociatedIds');
    return new Map(ids.map((id) => [id, this.links.get(`${from}/${id}/${to}`) ?? []]));
  }
}

export class FakeStore implements ConfirmationStore {
  rows = new Map<string, Confirmation & { lock_until: number | null }>();

  async get(id: string) {
    const row = this.rows.get(id);
    if (!row) return null;
    const { lock_until: _lock, ...rest } = row;
    return { ...rest };
  }
  async create(r: { emailTaskId: string; contactId: string; companyId: string | null }) {
    if (this.rows.has(r.emailTaskId)) return;
    this.rows.set(r.emailTaskId, {
      email_task_id: r.emailTaskId,
      contact_id: r.contactId,
      company_id: r.companyId,
      completed_at: null,
      call_task_id: null,
      last_error: null,
      lock_until: null,
    });
  }
  async acquireLock(id: string, nowSec: number, ttlSec: number) {
    const row = this.rows.get(id)!;
    if (row.lock_until !== null && row.lock_until >= nowSec) return false;
    row.lock_until = nowSec + ttlSec;
    return true;
  }
  async releaseLock(id: string) {
    this.rows.get(id)!.lock_until = null;
  }
  async markCompleted(id: string, at: string) {
    this.rows.get(id)!.completed_at = at;
  }
  async setCallTask(id: string, callTaskId: string) {
    this.rows.get(id)!.call_task_id = callTaskId;
  }
  async setError(id: string, error: string | null) {
    this.rows.get(id)!.last_error = error;
  }
}

export class FakeSentStore implements SentEmailStore {
  rows = new Map<string, SentEmail & { lock_until: number | null; track_opens: number; track_clicks: number }>();
  links: { token: string; url: string; emailTaskId: string }[] = [];

  async get(id: string) {
    const row = this.rows.get(id);
    if (!row) return null;
    const { lock_until: _lock, track_opens: _o, track_clicks: _c, ...rest } = row;
    return { ...rest };
  }
  async beginSend(r: NewSentEmail, nowSec: number, ttlSec: number) {
    if (this.rows.has(r.emailTaskId)) return false;
    this.rows.set(r.emailTaskId, {
      email_task_id: r.emailTaskId,
      contact_id: r.contactId,
      company_id: r.companyId,
      from_email: r.fromEmail,
      to_email: r.toEmail,
      subject: r.subject,
      html: r.html,
      open_token: r.openToken,
      status: 'sending',
      gmail_message_id: null,
      logged_email_id: null,
      log_attempted_at: null,
      sent_at: null,
      lock_until: nowSec + ttlSec,
      track_opens: r.trackOpens ? 1 : 0,
      track_clicks: r.trackClicks ? 1 : 0,
    });
    this.links.push(...r.links.map((l) => ({ ...l, emailTaskId: r.emailTaskId })));
    return true;
  }
  async markSent(id: string, gmailMessageId: string, at: string) {
    Object.assign(this.rows.get(id)!, {
      status: 'sent',
      gmail_message_id: gmailMessageId,
      sent_at: at,
      lock_until: null,
    });
  }
  async markUnknownIfStale(id: string, nowSec: number) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'sending' || (row.lock_until ?? 0) >= nowSec) return false;
    Object.assign(row, { status: 'unknown', lock_until: null });
    return true;
  }
  async markSentManually(id: string, at: string) {
    const row = this.rows.get(id);
    if (row?.status === 'unknown') Object.assign(row, { status: 'sent', sent_at: at });
  }
  async discard(id: string, status: 'sending' | 'unknown') {
    if (this.rows.get(id)?.status !== status) return;
    this.rows.delete(id);
    this.links = this.links.filter((l) => l.emailTaskId !== id);
  }
  async setLoggedEmail(id: string, loggedEmailId: string) {
    this.rows.get(id)!.logged_email_id = loggedEmailId;
  }
  async markLogAttempted(id: string, at: string) {
    const row = this.rows.get(id)!;
    if (row.log_attempted_at !== null) return false;
    row.log_attempted_at = at;
    return true;
  }
  async clearLogAttempt(id: string) {
    const row = this.rows.get(id)!;
    if (row.logged_email_id === null) row.log_attempted_at = null;
  }
}

// HubSpot's CRM API over HTTP, answered from a FakeHubSpot's records, for
// tests that run the whole app (it builds its own HubSpot client from fetch).
// Requests matching `failing()` answer 500.
export function hubspotApi(hs: FakeHubSpot, failing: () => RegExp | null = () => null) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    if (failing()?.test(`${method} ${pathname}`)) return new Response('{"message":"boom"}', { status: 500 });
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    let m: RegExpMatchArray | null;
    if ((m = pathname.match(/^\/crm\/objects\/2026-09\/(\w+)\/search$/))) {
      const type = m[1];
      const {
        filterGroups = [],
        query,
        limit = 100,
      } = body as {
        filterGroups?: { filters: SearchFilter[] }[];
        query?: string;
        limit?: number;
      };
      const filters = filterGroups[0]?.filters ?? [];
      if (type === 'tasks') return Response.json(await hs.searchTasks(filters));
      if (type === 'meetings') return Response.json(await hs.searchMeetings(filters));
      if (type === 'contacts' && filterGroups.length) {
        return Response.json({ results: await hs.searchContacts(filterGroups.map((g) => g.filters)) });
      }
      return Response.json({
        results: await hs.searchRecords(type as 'contacts' | 'companies', query ?? null, [], limit),
      });
    }
    if ((m = pathname.match(/^\/crm\/associations\/2026-09\/(\w+)\/(\w+)\/batch\/read$/))) {
      const ids = (body.inputs as { id: string }[]).map((i) => i.id);
      const links = await hs.batchAssociatedIds(m[1] as ObjectType, ids, m[2] as ObjectType);
      return Response.json({
        results: [...links].map(([id, to]) => ({ from: { id }, to: to.map((toObjectId) => ({ toObjectId })) })),
      });
    }
    if ((m = pathname.match(/^\/crm\/objects\/2026-09\/(\w+)\/batch\/read$/))) {
      const ids = (body.inputs as { id: string }[]).map((i) => i.id);
      return Response.json({ results: await hs.batchRead(m[1] as ObjectType, ids) });
    }
    if ((m = pathname.match(/^\/crm\/objects\/2026-09\/(\w+)\/([^/]+)$/)) && searchParams.has('idProperty')) {
      const found = await hs.getByUniqueValue(m[1] as ObjectType, searchParams.get('idProperty')!, m[2]);
      return found ? Response.json(found) : new Response('{"message":"not found"}', { status: 404 });
    }
    if (pathname === '/crm/objects/2026-09/deals' && method === 'POST') {
      try {
        const id = await hs.createDeal((body as { properties: Record<string, string> }).properties);
        return Response.json({ id } satisfies Partial<HubSpotObject>);
      } catch (err) {
        if (err instanceof HubSpotApiError) return new Response(err.body, { status: err.status });
        throw err;
      }
    }
    if ((m = pathname.match(/^\/crm\/objects\/2026-09\/(\w+)\/(\w+)$/))) {
      const [, type, id] = m;
      if (method === 'PATCH') {
        await hs.updateObject(type as ObjectType, id, (body as { properties: Record<string, string> }).properties);
        return Response.json({});
      }
      const to = (searchParams.get('associations') ?? '').split(',').filter(Boolean);
      const { object, associated } = await hs.getWithAssociations(type as ObjectType, id, [], to as ObjectType[]);
      const associations = Object.fromEntries(
        [...associated].map(([t, ids]) => [t, { results: ids.map((i) => ({ id: i })) }])
      );
      return Response.json({ ...object, associations });
    }
    if ((m = pathname.match(/^\/crm\/objects\/2026-09\/(\w+)\/(\w+)\/associations\/(\w+)$/))) {
      const ids = await hs.associatedIds(m[1] as ObjectType, m[2], m[3] as ObjectType);
      return Response.json({ results: ids.map((toObjectId) => ({ toObjectId })) });
    }
    if ((m = pathname.match(/^\/crm\/objects\/2026-09\/(tasks|calls)$/)) && method === 'POST') {
      const { properties, associations } = body as {
        properties: Record<string, string>;
        associations: { to: { id: string } }[];
      };
      const id = `${m[1]}-${hs.objects.size + 1}`;
      hs.put(m[1] as ObjectType, id, properties);
      hs.link('contacts', associations[0].to.id, m[1] as ObjectType, id);
      return Response.json({ id } satisfies Partial<HubSpotObject>);
    }
    throw new Error(`no stand-in for ${method} ${url}`);
  };
}

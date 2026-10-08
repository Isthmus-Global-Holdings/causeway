// Contacts and companies on their own: a search list of each, and a page per
// record with its details, address, tasks and HubSpot history, and Call and
// Email (which open the contact's task: see workflows/records.ts).

import { html } from 'hono/html';
import { formatLocal } from '../lib/dates';
import type { RecentSend } from '../lib/db';
import { parseFitLabel } from '../lib/fit';
import type { HubSpotObject } from '../lib/hubspot';
import { formatPhone, toE164 } from '../lib/phone';
import type { MeetingRow } from '../workflows/meeting-queue';
import { companyName, contactName, firstPhone } from '../workflows/parties';
import { LIST_LIMIT, type ContactRecord, type ContactRow, type RecordTasks } from '../workflows/records';
import { historyCard, lastEmailCard, whatsappFields } from './calls';
import { address, companyLinks, contactLinks, facts, humanize, lifecycle, place, website } from './facts';
import { layout, recordUrl, type Html } from './layout';

function phone(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const e164 = toE164(raw);
  return e164 ? formatPhone(e164) : raw.trim();
}

function fitBadge(company: HubSpotObject | null): Html | '' {
  return company ? html`<span class="fit">${parseFitLabel(company.properties.description)}</span>` : '';
}

function searchForm(action: string, query: string | null, placeholder: string, label: string): Html {
  return html`<form method="get" action="${action}" class="search" role="search">
    <input type="search" name="q" value="${query ?? ''}" placeholder="${placeholder}" aria-label="${label}" />
    <button type="submit">Search</button>
    ${query ? html`<a href="${action}">Clear</a>` : ''}
  </form>`;
}

function listSummary(count: number, query: string | null, noun: string): string {
  const shown = query ? `${count} matching “${query}”` : `${count} most recently updated ${noun}`;
  return count >= LIST_LIMIT ? `${shown}. Showing the first ${LIST_LIMIT}: search to narrow it down.` : `${shown}.`;
}

export function contactsPage(rows: ContactRow[], query: string | null, actor: string): Html {
  return layout(
    'Contacts',
    actor,
    html`
      <div class="row">
        <h1>Contacts</h1>
        <p class="muted">${listSummary(rows.length, query, 'contacts')}</p>
      </div>
      ${searchForm('/contacts', query, 'Name, email, phone or company', 'Search contacts')}
      ${
        rows.length
          ? html`<table class="stacked">
              <thead><tr><th>Contact</th><th>Company</th><th>Phone</th><th>Lead status</th><th>Place</th><th></th></tr></thead>
              <tbody>${rows.map(
                ({ contact, company }) => html`<tr>
                  <td>
                    <div class="tight">
                      <a href="/contacts/${contact.id}" data-prefetch-hover><strong>${contactName(contact)}</strong></a>
                      <span class="muted">${[contact.properties.jobtitle, contact.properties.email].filter(Boolean).join(' · ')}</span>
                    </div>
                  </td>
                  <td data-label="Company">${company ? html`<a href="/companies/${company.id}" data-prefetch-hover>${companyName(company)}</a>` : ''}</td>
                  <td data-label="Phone" class="nowrap">${phone(contact.properties.phone) ?? phone(contact.properties.mobilephone) ?? ''}</td>
                  <td data-label="Lead status">${humanize(contact.properties.hs_lead_status) ?? ''}</td>
                  <td data-label="Place">${place(contact) ?? ''}</td>
                  <td class="row-actions"><div class="actions"><a class="button" href="/contacts/${contact.id}" data-prefetch-hover>Open</a></div></td>
                </tr>`
              )}</tbody>
            </table>`
          : html`<p class="muted">${query ? 'No contacts match that search.' : 'No contacts in HubSpot yet.'}</p>`
      }
    `,
    'contacts'
  );
}

export function companiesPage(companies: HubSpotObject[], query: string | null, actor: string): Html {
  return layout(
    'Companies',
    actor,
    html`
      <div class="row">
        <h1>Companies</h1>
        <p class="muted">${listSummary(companies.length, query, 'companies')}</p>
      </div>
      ${searchForm('/companies', query, 'Name, domain or phone', 'Search companies')}
      ${
        companies.length
          ? html`<table class="stacked">
              <thead><tr><th>Fit</th><th>Company</th><th>Phone</th><th>Industry</th><th>Place</th><th></th></tr></thead>
              <tbody>${companies.map((company) => {
                const fit = parseFitLabel(company.properties.description);
                return html`<tr class="${fit === 'DROP' ? 'drop' : ''}">
                  <td class="fit-cell"><span class="fit">${fit}</span></td>
                  <td>
                    <div class="tight">
                      <a href="/companies/${company.id}" data-prefetch-hover><strong>${companyName(company)}</strong></a>
                      ${company.properties.domain ? html`<span class="muted">${company.properties.domain}</span>` : ''}
                    </div>
                  </td>
                  <td data-label="Phone" class="nowrap">${phone(company.properties.phone) ?? ''}</td>
                  <td data-label="Industry">${humanize(company.properties.industry) ?? ''}</td>
                  <td data-label="Place">${place(company) ?? ''}</td>
                  <td class="row-actions"><div class="actions"><a class="button" href="/companies/${company.id}" data-prefetch-hover>Open</a></div></td>
                </tr>`;
              })}</tbody>
            </table>`
          : html`<p class="muted">${query ? 'No companies match that search.' : 'No companies in HubSpot yet.'}</p>`
      }
    `,
    'companies'
  );
}

const TASK_TYPE_LABELS: Record<string, string> = { CALL: 'Call', EMAIL: 'Email' };

// Where the app opens a task: a call's page (open or done: it keeps the
// recording and transcript), an email's draft while it's still to send.
function taskLink(task: HubSpotObject, open: boolean): Html | '' {
  const type = task.properties.hs_task_type;
  if (type === 'CALL') return html`<a class="button" href="/calls/${task.id}">${open ? 'Open' : 'Review'}</a>`;
  if (type === 'EMAIL' && open) return html`<a class="button" href="/tasks/${task.id}/draft">Draft</a>`;
  return '';
}

function taskRow(task: HubSpotObject, open: boolean, timeZone: string): Html {
  const p = task.properties;
  const at = Date.parse((open ? p.hs_timestamp : (p.hs_task_completion_date ?? p.hs_timestamp)) ?? '');
  return html`<li class="row">
    <div class="tight">
      <span><span class="fit">${TASK_TYPE_LABELS[p.hs_task_type ?? ''] ?? humanize(p.hs_task_type) ?? 'Task'}</span> ${p.hs_task_subject ?? 'Untitled task'}</span>
      <span class="muted">${Number.isFinite(at) ? `${open ? 'Due' : 'Done'} ${formatLocal(at, timeZone)}` : ''}${open && p.hs_task_status !== 'NOT_STARTED' ? ` · ${humanize(p.hs_task_status)}` : ''}</span>
    </div>
    ${taskLink(task, open)}
  </li>`;
}

function tasksCard(tasks: RecordTasks, timeZone: string): Html {
  return html`<div class="card">
    <h2>Tasks</h2>
    ${
      tasks.failed
        ? html`<p class="muted">Couldn't load the tasks from HubSpot. Reload to try again.</p>`
        : html`${
            tasks.open.length
              ? html`<ul class="records">${tasks.open.map((t) => taskRow(t, true, timeZone))}</ul>`
              : html`<p class="muted">No open tasks.</p>`
          }
          ${
            tasks.completed.length
              ? html`<details>
                  <summary class="muted">Completed (${tasks.completed.length}${tasks.completed.length >= 10 ? ', latest' : ''})</summary>
                  <ul class="records">${tasks.completed.map((t) => taskRow(t, false, timeZone))}</ul>
                </details>`
              : ''
          }`
    }
  </div>`;
}

function interviewsCard(meetings: MeetingRow[] | null, timeZone: string): Html | '' {
  if (meetings === null)
    return html`<div class="card"><h2>Interviews</h2><p class="muted">Couldn't load interviews from HubSpot. Reload to try again.</p></div>`;
  if (!meetings.length) return '';
  return html`<div class="card">
    <h2>Interviews</h2>
    <ul class="records">${meetings.map(
      (m) => html`<li class="row">
        <div class="tight">
          <span>${m.title} <span class="fit">${humanize(m.outcome)}</span></span>
          <span class="muted">${m.startAt === null ? 'No time set' : formatLocal(m.startAt, timeZone)}</span>
        </div>
        <a class="button" href="/meetings/${m.meetingId}">Open</a>
      </li>`
    )}</ul>
  </div>`;
}

// Call and Email: the contact's open task of that type, or a new one due now.
function actionsCard(
  contact: HubSpotObject,
  company: HubSpotObject | null,
  tasks: RecordTasks,
  portalId: string
): Html {
  const openOf = (type: string) => tasks.open.find((t) => t.properties.hs_task_type === type);
  const call = openOf('CALL');
  const email = openOf('EMAIL');
  const dialable = Boolean(firstPhone(contact, company));
  const whatsapp = whatsappFields(contact).length > 0;
  const hasEmail = Boolean(contact.properties.email?.trim());
  return html`<div class="card">
    <form method="post" action="/contacts/${contact.id}/call" class="stack tight">
      <button type="submit" class="primary wide" ${dialable ? '' : 'disabled'}>Call</button>
      <span class="muted">${
        !dialable
          ? 'No number the app can dial. Add one to the contact or company in HubSpot.'
          : call
            ? 'Opens their open call task.'
            : 'Creates a call task due now and opens it.'
      }</span>
    </form>
    ${
      whatsapp
        ? html`<form method="post" action="/contacts/${contact.id}/call" class="stack tight">
            <input type="hidden" name="then" value="whatsapp" />
            <button type="submit" class="wide">WhatsApp</button>
            <span class="muted">${call ? 'Opens their open call task' : 'Creates a call task due now and opens it'}, at its WhatsApp button. Log the message there.</span>
          </form>`
        : ''
    }
    <form method="post" action="/contacts/${contact.id}/email" class="stack tight">
      <button type="submit" class="wide" ${hasEmail ? '' : 'disabled'}>Email</button>
      <span class="muted">${
        !hasEmail
          ? 'No email address in HubSpot.'
          : email
            ? 'Opens their open email task to draft and send.'
            : 'Creates an email task and opens its draft.'
      }</span>
    </form>
    <a href="${recordUrl(portalId, '0-1', contact.id)}" target="_blank" rel="noopener">Open in HubSpot</a>
  </div>`;
}

function companyFacts(company: HubSpotObject, portalId: string): Html {
  const co = company.properties;
  return html`${facts([
    ['Company', companyLinks(portalId, company)],
    ['Fit', fitBadge(company)],
    ['Website', website(company)],
    ['Phone', phone(co.phone)],
    ['Industry', humanize(co.industry)],
    ['Employees', co.numberofemployees],
    ['Address', address(company)],
  ])}
  ${co.description?.trim() ? html`<pre class="muted">${co.description.trim()}</pre>` : ''}`;
}

export interface ContactPageState {
  record: ContactRecord;
  lastEmail: RecentSend | null;
  portalId: string;
  timeZone: string;
  now: number;
}

export function contactPage(state: ContactPageState, actor: string): Html {
  const { contact, company, tasks, meetings, context } = state.record;
  const c = contact.properties;
  const name = contactName(contact);
  const company_ = companyName(company);
  return layout(
    name,
    actor,
    html`
      <p><a href="/contacts">← Contacts</a></p>
      <div class="tight">
        <h1>${name}</h1>
        <p class="muted">${c.jobtitle ?? ''}${c.jobtitle && company_ ? ' · ' : ''}${company ? html`<a href="/companies/${company.id}">${company_}</a>` : ''}</p>
      </div>
      <div class="with-aside">
        <div class="stack">
          <div class="card">
            <h2>Contact</h2>
            ${facts([
              ['Contact', contactLinks(state.portalId, contact)],
              ['Title', c.jobtitle],
              ['Email', c.email],
              ['Phone', phone(c.phone)],
              ['Mobile', phone(c.mobilephone)],
              ['Lead status', humanize(c.hs_lead_status)],
              ['Lifecycle', lifecycle(c.lifecyclestage)],
              ['Address', address(contact)],
            ])}
          </div>
          <div class="card">
            <h2>Company</h2>
            ${company ? companyFacts(company, state.portalId) : html`<p class="muted">No company in HubSpot.</p>`}
          </div>
          ${historyCard({ context, timeZone: state.timeZone, now: state.now })}
        </div>
        <div class="stack first-on-phone">
          ${actionsCard(contact, company, tasks, state.portalId)}
          ${tasksCard(tasks, state.timeZone)}
          ${interviewsCard(meetings, state.timeZone)}
          <div class="card">
            <h2>Last email from this app</h2>
            ${lastEmailCard(state.lastEmail, state.timeZone)}
          </div>
        </div>
      </div>
    `,
    'contacts'
  );
}

export interface CompanyPageState {
  company: HubSpotObject;
  contacts: HubSpotObject[];
  tasks: RecordTasks;
  portalId: string;
  timeZone: string;
}

export function companyPage(state: CompanyPageState, actor: string): Html {
  const { company, contacts } = state;
  return layout(
    companyName(company) ?? 'Company',
    actor,
    html`
      <p><a href="/companies">← Companies</a></p>
      <div class="tight">
        <h1>${companyName(company)} ${fitBadge(company)}</h1>
        <p class="muted">${[humanize(company.properties.industry), place(company)].filter(Boolean).join(' · ')}</p>
      </div>
      <div class="with-aside">
        <div class="stack">
          <div class="card">
            <h2>Company</h2>
            ${companyFacts(company, state.portalId)}
          </div>
          <div class="card">
            <h2>Contacts (${contacts.length})</h2>
            ${
              contacts.length
                ? html`<table class="stacked">
                    <thead><tr><th>Contact</th><th>Phone</th><th>Lead status</th><th></th></tr></thead>
                    <tbody>${contacts.map((contact) => {
                      const p = contact.properties;
                      const dialable = Boolean(firstPhone(contact, company));
                      const hidden = html`<input type="hidden" name="company_id" value="${company.id}" />`;
                      return html`<tr>
                        <td>
                          <div class="tight">
                            <a href="/contacts/${contact.id}" data-prefetch-hover><strong>${contactName(contact)}</strong></a>
                            <span class="muted">${[p.jobtitle, p.email].filter(Boolean).join(' · ')}</span>
                          </div>
                        </td>
                        <td data-label="Phone" class="nowrap">${phone(p.phone) ?? phone(p.mobilephone) ?? ''}</td>
                        <td data-label="Lead status">${humanize(p.hs_lead_status) ?? ''}</td>
                        <td class="row-actions">
                          <div class="actions">
                            <form method="post" action="/contacts/${contact.id}/call">${hidden}<button type="submit" class="primary" ${dialable ? '' : 'disabled'}>Call</button></form>
                            <form method="post" action="/contacts/${contact.id}/email">${hidden}<button type="submit" ${p.email?.trim() ? '' : 'disabled'}>Email</button></form>
                          </div>
                        </td>
                      </tr>`;
                    })}</tbody>
                  </table>
                  <p class="muted">Call and Email open the contact’s open task of that kind, or create one due now.</p>`
                : html`<p class="muted">No contacts on this company in HubSpot. Add one there to call or email from the app.</p>`
            }
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <a href="${recordUrl(state.portalId, '0-2', company.id)}" target="_blank" rel="noopener">Open in HubSpot</a>
          </div>
          ${tasksCard(state.tasks, state.timeZone)}
        </div>
      </div>
    `,
    'companies'
  );
}

import { Hono, type Context } from 'hono';
import { openContactTask } from '../actions/records';
import { loadAppSettings } from '../lib/app-settings';
import { latestSendToContact } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import type { AppEnv } from '../types';
import { companiesPage, companyPage, contactPage, contactsPage } from '../views/records';
import type { TaskType } from '../workflows/parties';
import { loadCompanyRecord, loadContactRecord, searchCompanyList, searchContactList } from '../workflows/records';

export const recordsRoute = new Hono<AppEnv>();

// A search typed into the list page, or null for the most recent records.
function searchQuery(c: Context<AppEnv>): string | null {
  return c.req.query('q')?.trim().slice(0, 100) || null;
}

// GET /contacts — search contacts, or the most recently updated.
recordsRoute.get('/contacts', async (c) => {
  const query = searchQuery(c);
  const rows = await searchContactList(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), query);
  return c.html(contactsPage(rows, query, c.get('actor')));
});

// GET /contacts/:id — the contact's details and address, their company,
// tasks, interviews and HubSpot history, and Call and Email.
recordsRoute.get('/contacts/:id', async (c) => {
  const contactId = c.req.param('id');
  const [record, settings, lastEmail] = await Promise.all([
    loadContactRecord(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), contactId),
    loadAppSettings(c.env),
    latestSendToContact(c.env.DB, contactId),
  ]);
  return c.html(
    contactPage(
      { record, lastEmail, portalId: c.env.HUBSPOT_PORTAL_ID, timeZone: settings.timeZone, now: Date.now() },
      c.get('actor')
    )
  );
});

// POST /contacts/:id/call and /contacts/:id/email — the contact's open task
// of that type, or a new one due now, opened on its page.
async function openTask(c: Context<AppEnv>, type: TaskType) {
  const form = await c.req.parseBody();
  const companyId = typeof form.company_id === 'string' && form.company_id ? form.company_id : null;
  const { taskId } = await openContactTask(c, c.req.param('id') ?? '', type, companyId);
  // WhatsApp lands on the call page's numbers, where its button is.
  const at = type === 'CALL' && form.then === 'whatsapp' ? '#numbers' : '';
  return c.redirect(type === 'CALL' ? `/calls/${taskId}${at}` : `/tasks/${taskId}/draft`, 303);
}

recordsRoute.post('/contacts/:id/call', (c) => openTask(c, 'CALL'));
recordsRoute.post('/contacts/:id/email', (c) => openTask(c, 'EMAIL'));

// GET /companies — search companies, or the most recently updated.
recordsRoute.get('/companies', async (c) => {
  const query = searchQuery(c);
  const companies = await searchCompanyList(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), query);
  return c.html(companiesPage(companies, query, c.get('actor')));
});

// GET /companies/:id — the company's details and address, its contacts (each
// with Call and Email) and its tasks.
recordsRoute.get('/companies/:id', async (c) => {
  const [record, settings] = await Promise.all([
    loadCompanyRecord(createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN), c.req.param('id')),
    loadAppSettings(c.env),
  ]);
  return c.html(
    companyPage({ ...record, portalId: c.env.HUBSPOT_PORTAL_ID, timeZone: settings.timeZone }, c.get('actor'))
  );
});

// Fills the test CRM (isthmus-test) with made-up prospects to work through:
// companies with a Fit line, their contacts, EMAIL and CALL tasks, and an
// interview. Never touches the live account.
//
//   node scripts/seed-test-crm.mjs
//
// Reads HUBSPOT_ACCESS_TOKEN and HUBSPOT_PORTAL_ID from .dev.vars.test, and
// refuses to run unless HubSpot says the token belongs to that portal and it's
// a developer test account. Companies are imported with the HubSpot CLI
// (`hs`), which must be signed in to the test account too (`hs account list`).
//
// Safe to re-run: companies are found by name and contacts by email, and a
// contact that already has tasks (or a meeting) gets no new ones. To start
// over, delete the records in HubSpot and run it again.
//
// Domains are example.com subdomains, reserved and never a real company's.
// Emails go to plus-addresses of the connected Gmail account, so anything the
// app sends in a test lands in the rep's own inbox. Phone numbers are 555-01xx,
// which are never assigned.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INBOX = 'isthmusglobalholdings';
const DAY = 24 * 60 * 60 * 1000;

const PROSPECTS = [
  {
    company: {
      name: 'Red Mesa Freight (TEST)',
      domain: 'redmesa-freight.example.com',
      industry: 'TRANSPORTATION_TRUCKING_RAILROAD',
      numberofemployees: '40',
      city: 'Grand Junction',
      state: 'CO',
      description:
        'Fit: STRONG - small, family-owned, owner-run asset carrier.\nWorld: how trucking companies handle quoting and dispatch.\nPedestal: you still run the trucks and the office out of one yard in Grand Junction.',
    },
    contact: { firstname: 'Dana', lastname: 'Ruiz', jobtitle: 'Owner', phone: '+13855550101' },
    tasks: [{ type: 'EMAIL', subject: 'Intro email', due: 0 }],
  },
  {
    company: {
      name: 'Juniper Line Logistics (TEST)',
      domain: 'juniperline.example.com',
      industry: 'LOGISTICS_AND_SUPPLY_CHAIN',
      numberofemployees: '120',
      city: 'Boise',
      state: 'ID',
      description: 'Fit: GOOD - regional LTL, dispatcher-heavy',
    },
    contact: { firstname: 'Marcus', lastname: 'Hale', jobtitle: 'Operations Manager', phone: '+13855550102' },
    tasks: [
      {
        type: 'EMAIL',
        subject: 'Intro email',
        due: 0,
        body: 'Subject: How you schedule loads today<br><br>Hi Marcus,<br><br>A test draft, ready to send.<br><br>Thanks',
      },
    ],
  },
  {
    company: {
      name: 'Cottonwood Haulers (TEST)',
      domain: 'cottonwood-haulers.example.com',
      industry: 'TRANSPORTATION_TRUCKING_RAILROAD',
      numberofemployees: '15',
      city: 'Ogden',
      state: 'UT',
      description: 'Fit: moderate - owner-operators, mostly brokered loads',
    },
    contact: { firstname: 'Priya', lastname: 'Natarajan', jobtitle: 'Dispatcher', phone: '+13855550103' },
    tasks: [{ type: 'EMAIL', subject: 'Intro email', due: 0 }],
  },
  {
    company: {
      name: 'Basin Ridge Transport (TEST)',
      domain: 'basinridge.example.com',
      industry: 'TRANSPORTATION_TRUCKING_RAILROAD',
      numberofemployees: '60',
      city: 'Casper',
      state: 'WY',
      description:
        'Fit: STRONG - asset carrier, owner still dispatches.\nWorld: how trucking companies handle quoting and dispatch.\nPedestal: you still dispatch the trucks yourself, so you see every load from quote to delivery.',
    },
    contact: { firstname: 'Tom', lastname: 'Becker', jobtitle: 'President', phone: '+13855550104' },
    tasks: [{ type: 'CALL', subject: 'Follow-up call', due: 0 }],
  },
  {
    company: {
      name: 'Silver Sage Carriers (TEST)',
      domain: 'silversage.example.com',
      industry: 'TRANSPORTATION_TRUCKING_RAILROAD',
      numberofemployees: '25',
      city: 'Pocatello',
      state: 'ID',
      description: 'Fit: GOOD - family fleet, second generation',
    },
    contact: { firstname: 'Elena', lastname: 'Ortiz', jobtitle: 'General Manager', phone: '+13855550105' },
    tasks: [{ type: 'CALL', subject: 'Follow-up call', due: 1 }],
    meeting: { title: 'Interview: Elena Ortiz', inDays: 1 },
  },
  {
    company: {
      name: 'Great Plains Express (TEST)',
      domain: 'greatplains-express.example.com',
      industry: 'TRANSPORTATION_TRUCKING_RAILROAD',
      numberofemployees: '900',
      city: 'Omaha',
      state: 'NE',
      description: 'Fit: POOR - national carrier, procurement-led. Recommend: drop',
    },
    contact: { firstname: 'Kyle', lastname: 'Brandt', jobtitle: 'VP Procurement', phone: '+13855550106' },
    tasks: [{ type: 'EMAIL', subject: 'Intro email', due: 0 }],
  },
];

// HubSpot-defined association type ids.
const ASSOC = {
  contactToCompany: 1, // primary company
  taskToContact: 204,
  taskToCompany: 192,
  meetingToContact: 200,
  meetingToCompany: 188,
};

function readDevVars(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`No ${path}. See README → "Test CRM".`);
    process.exit(1);
  }
  const vars = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return vars;
}

const vars = readDevVars('.dev.vars.test');
const token = vars.HUBSPOT_ACCESS_TOKEN;
const portalId = vars.HUBSPOT_PORTAL_ID;
if (!token || !portalId) {
  console.error('.dev.vars.test needs HUBSPOT_ACCESS_TOKEN and HUBSPOT_PORTAL_ID.');
  process.exit(1);
}

// Search allows about 5 requests a second; wait and retry when it says so.
async function hs(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.hubapi.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    return parse(method, path, res);
  }
}

async function parse(method, path, res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const account = await hs('GET', '/account-info/v3/details');
if (String(account.portalId) !== portalId || account.accountType !== 'DEVELOPER_TEST') {
  console.error(
    `Refusing to seed: the token is for portal ${account.portalId} (${account.accountType}), ` +
      `not the test account ${portalId}.`
  );
  process.exit(1);
}

async function findOne(object, propertyName, value) {
  const found = await hs('POST', `/crm/objects/2026-09/${object}/search`, {
    filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
    limit: 1,
  });
  return found.results[0] ?? null;
}

// The app's token can read companies but not create them (it has no
// companies.write scope, and the live install shouldn't get one just for
// this), so missing companies go in through a CRM import run by the HubSpot
// CLI, signed in to the test account. Imports finish in the background: wait
// until search finds them all.
async function importCompanies(companies) {
  const columns = Object.keys(companies[0]);
  const cell = (v) => `"${String(v).replaceAll('"', '""')}"`;
  const dir = mkdtempSync(join(tmpdir(), 'seed-test-crm-'));
  writeFileSync(
    join(dir, 'companies.csv'),
    [columns.map(cell).join(','), ...companies.map((c) => columns.map((k) => cell(c[k])).join(','))].join('\n')
  );
  const schema = join(dir, 'import.json');
  writeFileSync(
    schema,
    JSON.stringify({
      name: 'hubspot-automations test companies',
      files: [
        {
          fileName: 'companies.csv',
          fileFormat: 'CSV',
          fileImportPage: {
            hasHeader: true,
            columnMappings: columns.map((k) => ({ columnObjectTypeId: '0-2', columnName: k, propertyName: k })),
          },
        },
      ],
    })
  );
  const run = spawnSync(
    'hs',
    ['test-account', 'import-data', '--account', portalId, '--file-path', schema, '--skip-confirm'],
    // The CLI looks for the CSV next to where it runs, not next to the schema.
    { stdio: 'inherit', cwd: dir }
  );
  if (run.status !== 0) {
    console.error('The HubSpot CLI import failed (is `hs` signed in to the test account? `hs account list`).');
    process.exit(1);
  }
  for (let i = 0; i < 30; i++) {
    const found = await hs('POST', '/crm/objects/2026-09/companies/search', {
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'IN', values: companies.map((c) => c.name) }] }],
      limit: companies.length,
    });
    if (found.total >= companies.length) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error('The company import is taking longer than 90s. Check it in HubSpot, then run this again.');
  process.exit(1);
}

const missing = [];
for (const p of PROSPECTS) {
  if (!(await findOne('companies', 'name', p.company.name))) missing.push(p.company);
}
if (missing.length) await importCompanies(missing);

async function upsert(object, key, properties, associations = []) {
  const existing = await findOne(object, key, properties[key]);
  if (existing) return { id: existing.id, created: false };
  const made = await hs('POST', `/crm/objects/2026-09/${object}`, { properties, associations });
  return { id: made.id, created: true };
}

async function hasAssociated(fromObject, fromId, toObject) {
  const res = await hs('GET', `/crm/objects/2026-09/${fromObject}/${fromId}/associations/${toObject}?limit=1`);
  return res.results.length > 0;
}

const to = (id, typeId) => ({
  to: { id },
  types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
});

// Tasks are due at 9:00 (this machine's time) today or a later day; the app
// only cares about the calendar day in the rep's time zone.
const startOfToday = new Date();
startOfToday.setHours(9, 0, 0, 0);

for (const p of PROSPECTS) {
  const company = {
    id: (await findOne('companies', 'name', p.company.name)).id,
    created: missing.includes(p.company),
  };
  const slug = p.company.domain.split('.')[0];
  const contact = await upsert(
    'contacts',
    'email',
    { ...p.contact, email: `${INBOX}+${slug}@gmail.com`, lifecyclestage: 'lead' },
    [to(company.id, ASSOC.contactToCompany)]
  );
  const links = [to(contact.id, ASSOC.taskToContact), to(company.id, ASSOC.taskToCompany)];

  let made = 0;
  if (!(await hasAssociated('contacts', contact.id, 'tasks'))) {
    for (const t of p.tasks) {
      await hs('POST', '/crm/objects/2026-09/tasks', {
        properties: {
          hs_task_type: t.type,
          hs_task_status: 'NOT_STARTED',
          hs_task_subject: `${t.subject}: ${p.contact.firstname} ${p.contact.lastname}`,
          hs_task_body: t.body ?? '',
          hs_timestamp: String(startOfToday.getTime() + t.due * DAY),
        },
        associations: links,
      });
      made += 1;
    }
  }

  if (p.meeting && !(await hasAssociated('contacts', contact.id, 'meetings'))) {
    const start = startOfToday.getTime() + p.meeting.inDays * DAY + 6 * 60 * 60 * 1000;
    await hs('POST', '/crm/objects/2026-09/meetings', {
      properties: {
        hs_meeting_title: p.meeting.title,
        hs_meeting_start_time: String(start),
        hs_meeting_end_time: String(start + 30 * 60 * 1000),
        hs_meeting_location: 'Phone call',
        hs_timestamp: String(start),
      },
      associations: [to(contact.id, ASSOC.meetingToContact), to(company.id, ASSOC.meetingToCompany)],
    });
    made += 1;
  }

  console.log(
    `${p.company.name}: company ${company.created ? 'created' : 'found'}, ` +
      `contact ${contact.created ? 'created' : 'found'}, ${made} new task(s)/meeting(s)`
  );
}

console.log(`Done. https://app-na2.hubspot.com/tasks/${portalId}/view/all`);

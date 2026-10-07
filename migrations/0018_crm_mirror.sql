-- A copy of the CRM in D1: contacts, companies, tasks, meetings, and the notes,
-- calls and emails on their timelines. Kept current from HubSpot (webhooks,
-- and a cron that pulls whatever changed since its last run), so pages can
-- read here instead of HubSpot, and so the data is still here if the account
-- goes.
--
-- Every record's `id` is HubSpot's, so the ids already in call_logs,
-- meeting_logs and the rest match without a lookup. A record made once
-- HubSpot is gone gets an id from the app (a UUID, never all digits, so it
-- can't collide with one of HubSpot's).
--
-- The columns are the fields the app reads, filters or sorts on. `properties`
-- holds everything HubSpot returned for the record, as JSON, so a field the
-- app starts using later is already here, and nothing is lost on the way out.
-- The sync writes both from the same response.
--
-- Times are ISO 8601 in UTC, always written by toISOString(), so they sort as
-- text. `hs_updated_at` is HubSpot's last-modified time (lastmodifieddate on
-- contacts, hs_lastmodifieddate on everything else, the same split
-- searchRecords sorts by): an update is only applied when it's newer than the
-- row, so a late webhook or an overlapping pull can't put an older version
-- back. A record deleted or merged away in
-- HubSpot keeps its row, with `archived_at` set.
--
-- No foreign keys: a task can arrive before its contact does, and the copy
-- only has to be consistent once the sync catches up.

CREATE TABLE IF NOT EXISTS crm_contacts (
  id             TEXT PRIMARY KEY,
  first_name     TEXT,
  last_name      TEXT,
  email          TEXT,                  -- lowercased
  job_title      TEXT,
  phone          TEXT,                  -- as entered in HubSpot; dialling normalises it
  mobile_phone   TEXT,
  lead_status    TEXT,                  -- hs_lead_status
  lifecycle_stage TEXT,
  address        TEXT,
  city           TEXT,
  state          TEXT,
  zip            TEXT,
  country        TEXT,
  owner_id       TEXT,                  -- hubspot_owner_id
  properties     TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT,                  -- createdate
  hs_updated_at  TEXT,                  -- lastmodifieddate (contacts don't use hs_lastmodifieddate)
  synced_at      TEXT NOT NULL,
  archived_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON crm_contacts(email);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_updated ON crm_contacts(hs_updated_at);

CREATE TABLE IF NOT EXISTS crm_companies (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  domain         TEXT,                  -- lowercased
  description    TEXT,                  -- holds the "Fit: …" line
  fit_label      TEXT,                  -- parseFitLabel(description), so queues can sort in SQL
  phone          TEXT,
  industry       TEXT,
  employees      INTEGER,               -- numberofemployees
  address        TEXT,
  address2       TEXT,
  city           TEXT,
  state          TEXT,
  zip            TEXT,
  country        TEXT,
  owner_id       TEXT,
  properties     TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT,
  hs_updated_at  TEXT,
  synced_at      TEXT NOT NULL,
  archived_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_crm_companies_domain ON crm_companies(domain);
CREATE INDEX IF NOT EXISTS idx_crm_companies_updated ON crm_companies(hs_updated_at);

CREATE TABLE IF NOT EXISTS crm_tasks (
  id             TEXT PRIMARY KEY,
  type           TEXT,                  -- hs_task_type: 'EMAIL' | 'CALL' | 'TODO'
  status         TEXT,                  -- hs_task_status: NOT_STARTED | IN_PROGRESS | WAITING | COMPLETED | DEFERRED
  subject        TEXT,
  body_html      TEXT,                  -- hs_task_body: an EMAIL task's draft lives here
  due_at         TEXT,                  -- hs_timestamp
  completed_at   TEXT,                  -- hs_task_completion_date
  owner_id       TEXT,
  properties     TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT,                  -- hs_createdate
  hs_updated_at  TEXT,
  synced_at      TEXT NOT NULL,
  archived_at    TEXT
);
-- The email and call queues: open tasks of one type, by due date.
CREATE INDEX IF NOT EXISTS idx_crm_tasks_queue ON crm_tasks(type, status, due_at);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_updated ON crm_tasks(hs_updated_at);

CREATE TABLE IF NOT EXISTS crm_meetings (
  id                  TEXT PRIMARY KEY,
  title               TEXT,             -- hs_meeting_title
  start_at            TEXT,             -- hs_meeting_start_time
  end_at              TEXT,             -- hs_meeting_end_time
  outcome             TEXT,             -- hs_meeting_outcome; NULL means scheduled
  join_url            TEXT,             -- hs_meeting_external_url
  location            TEXT,             -- hs_meeting_location
  body_html           TEXT,             -- hs_meeting_body, shown to attendees
  internal_notes_html TEXT,             -- hs_internal_meeting_notes
  owner_id            TEXT,
  properties          TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT,
  hs_updated_at       TEXT,
  synced_at           TEXT NOT NULL,
  archived_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_crm_meetings_start ON crm_meetings(start_at);
CREATE INDEX IF NOT EXISTS idx_crm_meetings_updated ON crm_meetings(hs_updated_at);

-- Notes, calls and emails in one table, since the pages show them as one
-- timeline. The call and email columns are NULL on the kinds they don't apply to.
CREATE TABLE IF NOT EXISTS crm_activities (
  id             TEXT NOT NULL,
  kind           TEXT NOT NULL,         -- 'note' | 'call' | 'email' (HubSpot's ids are only unique per type)
  at             TEXT,                  -- hs_timestamp
  title          TEXT,                  -- hs_call_title, hs_email_subject; NULL for a note
  body_html      TEXT,                  -- hs_note_body, hs_call_body, hs_email_html
  body_text      TEXT,                  -- hs_email_text; for the others, the body as text
  direction      TEXT,                  -- hs_call_direction, hs_email_direction
  status         TEXT,                  -- hs_call_status, hs_email_status
  call_outcome   TEXT,                  -- hs_call_disposition: a call outcome GUID
  duration_ms    INTEGER,               -- hs_call_duration
  from_number    TEXT,                  -- hs_call_from_number
  to_number      TEXT,                  -- hs_call_to_number
  owner_id       TEXT,
  properties     TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT,
  hs_updated_at  TEXT,
  synced_at      TEXT NOT NULL,
  archived_at    TEXT,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_at ON crm_activities(at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_updated ON crm_activities(kind, hs_updated_at);

-- HubSpot's associations, one row per link, stored one way: from the task,
-- meeting, activity or contact to the contact or company it's on. A contact's
-- company is a 'contact' → 'company' row; `is_primary` marks the one HubSpot
-- calls primary (the first company, where the app shows one).
--
-- from_type: 'contact' | 'task' | 'meeting' | 'note' | 'call' | 'email'
-- to_type:   'contact' | 'company'
CREATE TABLE IF NOT EXISTS crm_links (
  from_type   TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_type     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (from_type, from_id, to_type, to_id)
);
-- Everything on a contact or company: its tasks, meetings, timeline, people.
CREATE INDEX IF NOT EXISTS idx_crm_links_to ON crm_links(to_type, to_id, from_type);

-- HubSpot users, so an owner id still has a name once HubSpot is gone.
CREATE TABLE IF NOT EXISTS crm_owners (
  id          TEXT PRIMARY KEY,         -- hubspot_owner_id
  email       TEXT,
  first_name  TEXT,
  last_name   TEXT,
  synced_at   TEXT NOT NULL,
  archived_at TEXT
);

-- Where the cron's pull got to for each type. Each run asks HubSpot's search
-- for records modified at or after `modified_since` (lastmodifieddate for
-- contacts, hs_lastmodifieddate for the rest), pages through them, and moves
-- it to the newest it saw. A run that fails keeps the old
-- value, so the next run covers the same window again. `full_sync_at` is set
-- when a type has been copied in full once; until then the pull starts from
-- the beginning.
CREATE TABLE IF NOT EXISTS crm_sync_state (
  object_type     TEXT PRIMARY KEY,     -- 'contacts' | 'companies' | 'tasks' | 'meetings' | 'notes' | 'calls' | 'emails' | 'owners'
  modified_since  TEXT,
  full_sync_at    TEXT,
  last_run_at     TEXT,
  last_error      TEXT
);

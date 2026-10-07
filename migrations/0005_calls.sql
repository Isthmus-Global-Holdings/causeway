-- One row per click-to-call. Twilio rings the rep's phone first; when the rep
-- answers and presses 1, it dials the prospect. Each Twilio webhook writes
-- only its own columns, so the order the webhooks arrive in doesn't matter.
CREATE TABLE IF NOT EXISTS dials (
  id                    TEXT PRIMARY KEY,    -- random token, in every webhook URL for this call
  task_id               TEXT NOT NULL,       -- the HubSpot CALL task
  contact_id            TEXT NOT NULL,
  contact_label         TEXT NOT NULL,       -- read to the rep before connecting
  to_number             TEXT NOT NULL,       -- prospect, E.164
  from_number           TEXT NOT NULL,       -- the Twilio number, caller ID on both legs
  rep_number            TEXT NOT NULL,
  started_sec           INTEGER NOT NULL,    -- unix seconds
  rep_call_sid          TEXT,
  rep_status            TEXT,                -- final status of the rep's leg; NULL while it's live
  connected_at          TEXT,                -- the rep pressed 1
  prospect_call_sid     TEXT,
  prospect_status       TEXT,                -- final status of the prospect's leg
  prospect_duration_sec INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dials_task ON dials(task_id, started_sec);

-- One row per CALL task whose outcome the rep logged. Like sent_confirmations,
-- each HubSpot write is recorded as it lands, so a retry resumes. The form's
-- values are stored with the row: the first submission sticks.
CREATE TABLE IF NOT EXISTS call_logs (
  call_task_id     TEXT PRIMARY KEY,
  contact_id       TEXT NOT NULL,
  company_id       TEXT,
  owner_id         TEXT,                   -- the CALL task's HubSpot owner: the caller, and the follow-up's owner
  title            TEXT NOT NULL,          -- hs_call_title
  outcome          TEXT NOT NULL,          -- see CALL_OUTCOMES in workflows/call-logged.ts
  notes            TEXT NOT NULL,
  twilio_status    TEXT,                   -- prospect leg's final status; NULL if dialled outside the app
  duration_sec     INTEGER,
  from_number      TEXT,
  to_number        TEXT,
  next_type        TEXT,                   -- 'CALL' | 'EMAIL' | NULL for no follow-up
  next_subject     TEXT,
  next_due         TEXT,                   -- ISO instant
  log_attempted_at TEXT,                   -- same marker as sent_emails: a missing log beats a duplicate
  logged_call_id   TEXT,                   -- step 1 done: call on the contact's timeline
  completed_at     TEXT,                   -- step 2 done: CALL task set to COMPLETED
  next_task_id     TEXT,                   -- step 3 done: follow-up task created
  lead_status_at   TEXT,                   -- step 4 done: contact's Lead Status moved forward (or left as it was)
  lock_until       INTEGER,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

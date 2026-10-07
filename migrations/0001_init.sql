-- One row per EMAIL task a rep has confirmed as sent. Each step of the
-- "email sent" batch records its result here, so a double-click or a retry
-- after a HubSpot error resumes where it stopped instead of repeating writes.
CREATE TABLE IF NOT EXISTS sent_confirmations (
  email_task_id TEXT PRIMARY KEY,          -- HubSpot ids are strings in the API
  contact_id    TEXT NOT NULL,
  company_id    TEXT,                      -- a contact may have no company
  completed_at  TEXT,                      -- step 1 done: EMAIL task set to COMPLETED
  call_task_id  TEXT,                      -- step 2 done: follow-up CALL task created
  lock_until    INTEGER,                   -- unix seconds; blocks two concurrent runs
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every write the app makes to HubSpot, and who asked for it.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,               -- rep email from Cloudflare Access
  workflow    TEXT NOT NULL,               -- 'draft-email' | 'email-sent'
  task_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL,               -- 'success' | 'failed'
  error       TEXT,
  detail_json TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_task_id ON audit_log(task_id);

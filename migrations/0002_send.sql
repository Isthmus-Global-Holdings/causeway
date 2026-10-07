-- App settings edited on /settings: email signature, Claude model and effort,
-- and the Google connection (refresh token stored encrypted, see lib/secretbox.ts).
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per EMAIL task sent through Gmail. `status` is the guard against
-- sending twice: a row stuck in 'sending' after its lock expires means we
-- can't know whether Gmail accepted it, so it becomes 'unknown' and waits for
-- the rep to check their Sent folder instead of silently resending.
CREATE TABLE IF NOT EXISTS sent_emails (
  email_task_id    TEXT PRIMARY KEY,
  contact_id       TEXT NOT NULL,
  company_id       TEXT,
  from_email       TEXT NOT NULL,
  to_email         TEXT NOT NULL,
  subject          TEXT NOT NULL,
  html             TEXT NOT NULL,          -- what the recipient sees, without the tracking pixel/links
  open_token       TEXT NOT NULL UNIQUE,   -- tracking pixel id
  status           TEXT NOT NULL,          -- 'sending' | 'sent' | 'unknown'
  lock_until       INTEGER,
  gmail_message_id TEXT,
  logged_email_id  TEXT,                   -- HubSpot email engagement on the contact
  sent_at          TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Each link in a sent email is rewritten to /t/c/<token>, which redirects here.
CREATE TABLE IF NOT EXISTS tracked_links (
  token         TEXT PRIMARY KEY,
  email_task_id TEXT NOT NULL,
  url           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracking_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email_task_id TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- 'open' | 'click'
  url           TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tracking_events_task ON tracking_events(email_task_id, created_at);

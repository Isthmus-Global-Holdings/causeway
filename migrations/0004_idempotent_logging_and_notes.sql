-- Written just before the app asks HubSpot to log a sent email. If HubSpot
-- created the entry but its response was lost, a retry finds the marker with
-- no logged_email_id and skips logging again: a possibly missing log beats a
-- duplicate one. A definite HubSpot rejection (4xx) clears it so the retry
-- can log.
ALTER TABLE sent_emails ADD COLUMN log_attempted_at TEXT;

-- One row per HubSpot note the tracking routes have claimed: the first open
-- of an email, and the first click of each link. The claim is taken before
-- the note is written and released if HubSpot fails, so a later event
-- retries instead of the note being lost for good.
CREATE TABLE IF NOT EXISTS tracking_notes (
  email_task_id TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- 'open' | 'click'
  url_key       TEXT NOT NULL,             -- the link for clicks, '' for opens (NULLs never collide in a key)
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (email_task_id, kind, url_key)
);

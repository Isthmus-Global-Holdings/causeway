-- One row per interview outcome the rep logged. Keyed by the meeting and the
-- start time the rep saw, so an interview that was rescheduled can be logged
-- again once the new time comes round. Like call_logs, each HubSpot write is
-- recorded as it lands, so a retry resumes, and the form's values stick from
-- the first submission.
CREATE TABLE IF NOT EXISTS meeting_logs (
  log_id              TEXT PRIMARY KEY,      -- "<meeting id>@<start, epoch ms>"
  meeting_id          TEXT NOT NULL,
  contact_id          TEXT NOT NULL,
  company_id          TEXT,
  owner_id            TEXT,                  -- the meeting's HubSpot owner, and the follow-up's
  outcome             TEXT NOT NULL,         -- COMPLETED | NO_SHOW | CANCELED | RESCHEDULED
  notes               TEXT NOT NULL,
  internal_notes_html TEXT NOT NULL,         -- hs_internal_meeting_notes to write: what was there, plus the notes
  new_start           TEXT,                  -- ISO; RESCHEDULED only
  new_end             TEXT,
  next_type           TEXT,                  -- 'CALL' | 'EMAIL' | NULL for no follow-up
  next_subject        TEXT,
  next_due            TEXT,                  -- ISO instant
  outcome_at          TEXT,                  -- step 1 done: outcome, notes (and new time) on the meeting
  next_task_id        TEXT,                  -- step 2 done: follow-up task created
  lead_status_at      TEXT,                  -- step 3 done: contact's Lead Status moved forward (or left as it was)
  lock_until          INTEGER,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_meeting_logs_meeting ON meeting_logs(meeting_id);

-- One row per interview the rep booked from a call task. Keyed by the task and
-- the start time, so a double-click or a retry books one meeting, and booking
-- a second, different time is still possible.
CREATE TABLE IF NOT EXISTS meeting_bookings (
  booking_id  TEXT PRIMARY KEY,              -- "<call task id>@<start, epoch ms>"
  task_id     TEXT NOT NULL,
  contact_id  TEXT NOT NULL,
  company_id  TEXT,
  owner_id    TEXT,
  title       TEXT NOT NULL,
  start_at    TEXT NOT NULL,                 -- ISO
  end_at      TEXT NOT NULL,
  join_url    TEXT,
  meeting_id  TEXT,                          -- done: the meeting in HubSpot
  lock_until  INTEGER,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_meeting_bookings_task ON meeting_bookings(task_id);

-- Logging a call can also book the interview it set up: the time is stored
-- with the rest of the form, and the booking is step 5.
ALTER TABLE call_logs ADD COLUMN book_start TEXT;        -- ISO; NULL when no interview was booked
ALTER TABLE call_logs ADD COLUMN book_title TEXT;
ALTER TABLE call_logs ADD COLUMN book_minutes INTEGER;
ALTER TABLE call_logs ADD COLUMN book_join_url TEXT;
ALTER TABLE call_logs ADD COLUMN booked_meeting_id TEXT; -- step 5 done

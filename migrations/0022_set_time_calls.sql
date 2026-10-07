-- A follow-up call at the time the contact asked to be called (lib/set-time.ts):
-- the logged call's form gave a time, so the task gets a HubSpot reminder.
ALTER TABLE call_logs ADD COLUMN next_set_time INTEGER NOT NULL DEFAULT 0;

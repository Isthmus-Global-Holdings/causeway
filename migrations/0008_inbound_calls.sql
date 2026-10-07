-- One row per call to the Twilio number. Twilio rings the rep's phone; the
-- rep hears who's calling and presses 1 to take it. Otherwise the caller can
-- leave a voicemail. Each webhook writes only its own columns, like dials.
CREATE TABLE IF NOT EXISTS inbound_calls (
  id                     TEXT PRIMARY KEY,   -- random token, in every webhook URL for this call
  call_sid               TEXT NOT NULL UNIQUE, -- the caller's leg; a repeated webhook finds the same row
  from_number            TEXT NOT NULL,      -- the caller, as Twilio reports it
  to_number              TEXT NOT NULL,      -- the Twilio number they called
  rep_number             TEXT,               -- the phone rung; NULL if none was set up (straight to voicemail)
  started_sec            INTEGER NOT NULL,   -- unix seconds
  contact_id             TEXT,               -- the HubSpot contact with this number, if any
  company_id             TEXT,
  owner_id               TEXT,               -- the contact's owner: shown on the logged call
  contact_label          TEXT,               -- read to the rep before connecting
  record                 INTEGER NOT NULL DEFAULT 0, -- recording was on (Settings) when the call came in
  answered_at            TEXT,               -- the rep pressed 1
  talk_sec               INTEGER,            -- how long the rep and caller were connected
  voicemail              INTEGER NOT NULL DEFAULT 0, -- the caller was offered voicemail
  status                 TEXT,               -- final status of the caller's leg; NULL while it's live
  ended_sec              INTEGER,
  recording_sid          TEXT,               -- the call's recording, or the voicemail
  recording_duration_sec INTEGER,
  recording_channels     INTEGER,
  transcript_status      TEXT,               -- NULL | 'transcribing' | 'done' | 'failed'
  transcript_started_sec INTEGER,
  transcript_json        TEXT,
  summary                TEXT,
  transcript_error       TEXT,
  log_attempted_at       TEXT,               -- same marker as call_logs: a missing log beats a duplicate
  logged_call_id         TEXT,               -- the call on the contact's HubSpot timeline
  transcript_synced_at   TEXT                -- the HubSpot call's notes include the transcript
);
CREATE INDEX IF NOT EXISTS idx_inbound_calls_started ON inbound_calls(started_sec);

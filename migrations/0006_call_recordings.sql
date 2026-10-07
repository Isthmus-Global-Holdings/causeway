-- Call recording and transcription. A recorded dial gets Twilio's recording
-- (one channel per side: the rep, then the prospect), a transcript split into
-- turns, and a short summary. The audio stays on Twilio; the app streams it
-- to the rep through an Access-protected route.
ALTER TABLE dials ADD COLUMN record INTEGER NOT NULL DEFAULT 0;   -- recording was on when this call started
ALTER TABLE dials ADD COLUMN recording_sid TEXT;
ALTER TABLE dials ADD COLUMN recording_duration_sec INTEGER;
ALTER TABLE dials ADD COLUMN recording_channels INTEGER;          -- 2 when each side has its own channel
ALTER TABLE dials ADD COLUMN transcript_status TEXT;              -- NULL | 'transcribing' | 'done' | 'failed'
ALTER TABLE dials ADD COLUMN transcript_started_sec INTEGER;      -- claims the work, so one run transcribes at a time
ALTER TABLE dials ADD COLUMN transcript_json TEXT;                -- [{"speaker":"rep"|"prospect"|"call","start":0.4,"text":"..."}]
ALTER TABLE dials ADD COLUMN summary TEXT;                        -- a few bullet lines, one per line
ALTER TABLE dials ADD COLUMN transcript_error TEXT;

-- Which dial a logged call was for, so a transcript that finishes after the
-- rep logged the call can still be written onto that HubSpot call.
ALTER TABLE call_logs ADD COLUMN dial_id TEXT;
ALTER TABLE call_logs ADD COLUMN transcript_synced_at TEXT;       -- the HubSpot call's notes include the transcript
CREATE INDEX IF NOT EXISTS idx_call_logs_dial ON call_logs(dial_id);

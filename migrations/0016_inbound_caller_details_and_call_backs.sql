-- What Twilio's webhook says about someone calling the Twilio number: where
-- their number is registered (sent free with every call), and the caller ID
-- name (sent only when Caller Name Lookup is on for the number in Twilio,
-- which Twilio bills per call). NULL when Twilio sent nothing.
ALTER TABLE inbound_calls ADD COLUMN from_city TEXT;
ALTER TABLE inbound_calls ADD COLUMN from_state TEXT;
ALTER TABLE inbound_calls ADD COLUMN from_country TEXT;
ALTER TABLE inbound_calls ADD COLUMN caller_name TEXT;
-- The other calls from the same number, on an inbound call's page.
CREATE INDEX IF NOT EXISTS idx_inbound_calls_from ON inbound_calls(from_number, started_sec);

-- A call back to someone who rang the Twilio number, from its Inbound page, is
-- a dial with subject 'inbound' and task_id the inbound call's id. contact_id
-- is '' when the caller isn't in HubSpot. A call back to a contact logs itself
-- on them once Twilio reports how it went, once, like an inbound call.
ALTER TABLE dials ADD COLUMN log_attempted_at TEXT;     -- a missing log beats a duplicate
ALTER TABLE dials ADD COLUMN logged_call_id TEXT;       -- the call on the contact's HubSpot timeline
ALTER TABLE dials ADD COLUMN transcript_synced_at TEXT; -- the HubSpot call's notes include the transcript

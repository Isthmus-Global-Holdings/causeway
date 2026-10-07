-- How the rep is on the call: 'phone' (Twilio rings their phone and they
-- press 1) or 'browser' (they talk through the call page, with Twilio's Voice
-- SDK, and the browser starts the call itself).
ALTER TABLE dials ADD COLUMN mode TEXT NOT NULL DEFAULT 'phone';
-- The TwiML App's status callback names a browser call by its CallSid only.
CREATE INDEX IF NOT EXISTS idx_dials_rep_call_sid ON dials(rep_call_sid);

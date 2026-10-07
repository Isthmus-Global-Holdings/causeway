-- Past calls (the Calls page's second tab) lists every call, newest first: the
-- dials, the calls to the Twilio number (already indexed by started_sec), and
-- the calls the rep logged without dialling from the app (call_logs with no
-- dial_id).
CREATE INDEX IF NOT EXISTS idx_dials_started ON dials(started_sec);
CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs(created_at);

-- "Waiting on a call back": a missed call or voicemail stays there until the
-- number is dialled from the app, calls in again and is answered, or the rep
-- dismisses it (a wrong number, a robocall). Dismissing sets this on every
-- unanswered call from the number up to then.
ALTER TABLE inbound_calls ADD COLUMN callback_dismissed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_dials_to ON dials(to_number, started_sec);

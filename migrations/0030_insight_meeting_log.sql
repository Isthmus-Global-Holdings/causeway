-- The interview log a reading was made with (meeting_logs.log_id), for a
-- row of subject 'meeting': a newer log (the rep logging the interview, or
-- logging it again) is a reason to read the call again, by identity rather
-- than by comparing times to the second. NULL: no log yet, or a call task's.
ALTER TABLE call_insights ADD COLUMN meeting_log_id TEXT;

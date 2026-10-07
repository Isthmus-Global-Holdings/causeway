-- When the rep's leg ended. Twilio reports each leg separately and in no set
-- order, so the call page waits briefly after this for the prospect's leg
-- (its status and length) before showing the log form.
ALTER TABLE dials ADD COLUMN rep_ended_sec INTEGER;

-- An interview booked with a calendar invite: moving or canceling it in the
-- app moves or cancels the invite too, so the contact isn't left holding the
-- old time. The event is found when the log is first submitted and stored
-- with it; calendar_at records that the invite was updated.
ALTER TABLE meeting_logs ADD COLUMN calendar_event_id TEXT;
ALTER TABLE meeting_logs ADD COLUMN calendar_at TEXT;

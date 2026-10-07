-- Booking an interview can also send the contact a Google Calendar invite
-- (with a Google Meet link unless the rep gave one), from the connected Google
-- account. The event's id is derived from the booking, so a retry finds the
-- invite already sent rather than sending a second.
ALTER TABLE meeting_bookings ADD COLUMN invite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meeting_bookings ADD COLUMN invitee_email TEXT;
ALTER TABLE meeting_bookings ADD COLUMN calendar_event_id TEXT;  -- done: the invite went out

ALTER TABLE call_logs ADD COLUMN book_invite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_logs ADD COLUMN book_invitee_email TEXT;
ALTER TABLE call_logs ADD COLUMN book_calendar_event_id TEXT;

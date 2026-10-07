-- An interview can be a phone call instead of a video call: the rep calls the
-- contact at the number picked from HubSpot when it was booked, and the invite
-- says so instead of carrying a Google Meet link. NULL means a video call.
ALTER TABLE meeting_bookings ADD COLUMN phone TEXT;
ALTER TABLE call_logs ADD COLUMN book_phone TEXT;

-- An EMAIL follow-up can be created with its draft already written from a
-- template (a missed interview, the last try after one). The draft is stored
-- with the log on its first submission, so a retry writes the same one.
ALTER TABLE meeting_logs ADD COLUMN next_body TEXT;
ALTER TABLE call_logs ADD COLUMN next_body TEXT;

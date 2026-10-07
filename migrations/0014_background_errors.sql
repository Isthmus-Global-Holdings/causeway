-- The HubSpot steps after a call is logged or an email is sent now run after
-- the page has answered. A step that fails there has no page to show its
-- error on, so the error is kept here for the "didn't finish" notice (GET
-- /unfinished), and cleared once a later run finishes the steps.
ALTER TABLE call_logs ADD COLUMN last_error TEXT;
ALTER TABLE sent_confirmations ADD COLUMN last_error TEXT;

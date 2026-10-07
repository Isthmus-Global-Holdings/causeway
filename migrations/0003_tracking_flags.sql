-- Whether each email was sent with open/click tracking, so the queue page can
-- show "off" rather than a misleading 0. NULL for sends made before this existed.
ALTER TABLE sent_emails ADD COLUMN track_opens INTEGER;
ALTER TABLE sent_emails ADD COLUMN track_clicks INTEGER;

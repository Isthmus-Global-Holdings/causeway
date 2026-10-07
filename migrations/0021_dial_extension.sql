-- The extension typed after the number in HubSpot ("385-255-7051 x12"), keyed
-- in by Twilio once the line answers. NULL for a number without one.
ALTER TABLE dials ADD COLUMN to_extension TEXT;

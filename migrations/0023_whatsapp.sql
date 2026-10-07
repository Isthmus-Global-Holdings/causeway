-- A CALL task's outcome can be a WhatsApp call or a WhatsApp message, made
-- from the rep's own WhatsApp (click-to-chat, lib/whatsapp.ts), not a phone
-- call. A message goes on the contact's timeline as a HubSpot communication
-- (channel WHATS_APP) instead of a call: logged_message_id is its step 1,
-- with the same log_attempted_at marker as logged_call_id.
ALTER TABLE call_logs ADD COLUMN channel TEXT NOT NULL DEFAULT 'phone'; -- 'phone' | 'whatsapp_call' | 'whatsapp_message'
ALTER TABLE call_logs ADD COLUMN logged_message_id TEXT;

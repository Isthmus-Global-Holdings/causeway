-- Call or Email on a contact's page opens their open task of that type, or
-- creates one. The lock stops a double click from creating two: the second
-- click waits for the first to finish. A task HubSpot created but the app
-- never heard back about is found on the contact on the next click, so
-- nothing else needs remembering.
CREATE TABLE IF NOT EXISTS contact_task_locks (
  contact_id TEXT NOT NULL,
  type       TEXT NOT NULL,     -- 'CALL' | 'EMAIL'
  lock_until INTEGER NOT NULL,  -- epoch seconds
  PRIMARY KEY (contact_id, type)
);

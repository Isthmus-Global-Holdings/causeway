-- Drop, logging a call and dialling each check a CALL task, then write: Drop
-- reads D1 and writes HubSpot, the others read HubSpot and write D1. Each
-- holds the task's lock from its check to its write, so none acts on what
-- another is changing. A lock left by a stopped run expires.
CREATE TABLE IF NOT EXISTS task_locks (
  task_id    TEXT PRIMARY KEY,
  lock_until INTEGER NOT NULL  -- epoch seconds
);

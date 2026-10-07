-- What a dial was started from: a CALL task (the Calls page) or an interview
-- (a HubSpot meeting, the Interviews page). task_id holds that record's id
-- either way; HubSpot's tasks and meetings share one id space.
ALTER TABLE dials ADD COLUMN subject TEXT NOT NULL DEFAULT 'task'; -- 'task' | 'meeting'

-- A call or interview the rep marked as a real conversation: they talked
-- about their work, and the rep learned something. The counter is of people
-- (distinct contact_id), toward 100. D1 only: marking again replaces the row.
CREATE TABLE IF NOT EXISTS conversations (
  kind       TEXT NOT NULL,   -- 'call' (call_logs.call_task_id) | 'interview' (the meeting id)
  ref_id     TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  who        TEXT NOT NULL,   -- "Dallas Peery at Wanship Transportation", for the list
  learned    TEXT,            -- one line, in the rep's words; NULL: the notes' first line stands in
  at         TEXT NOT NULL,   -- ISO: when the call or interview was logged
  marked_at  TEXT NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);

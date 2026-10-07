-- Coaching, second version (lib/call-insight.ts): rules that read the
-- transcript turn by turn (the phone tree, who answered, what the front desk
-- did), calls left out of coaching, and room for the readings that come
-- after the rules: Jev's tags, and reviews by the rep or by Claude.

-- The phone menu before a person answered, and the digit it gave for them.
ALTER TABLE call_insights ADD COLUMN phone_tree_sec INTEGER;
ALTER TABLE call_insights ADD COLUMN phone_tree_digit TEXT;
-- From when the person they called for came on to the end of the call.
ALTER TABLE call_insights ADD COLUMN talk_sec INTEGER;
-- 1: left out of coaching (a test call). Kept when the call is read again.
ALTER TABLE call_insights ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
-- The RULES_VERSION it was read with: an older one is read again.
ALTER TABLE call_insights ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 1;
-- Jev (TypeSafe): its raw answers, the model that gave them, and failures.
ALTER TABLE call_insights ADD COLUMN jev_json TEXT;
ALTER TABLE call_insights ADD COLUMN jev_model TEXT;
ALTER TABLE call_insights ADD COLUMN jev_error TEXT;
ALTER TABLE call_insights ADD COLUMN jev_attempts INTEGER NOT NULL DEFAULT 0;
-- JSON list of the tags nothing was sure of.
ALTER TABLE call_insights ADD COLUMN unsure TEXT NOT NULL DEFAULT '[]';
-- 0–1: whether they described their own work; 0–3: how far they opened up.
ALTER TABLE call_insights ADD COLUMN talked_about_world REAL;
ALTER TABLE call_insights ADD COLUMN opened_up REAL;
-- The transcript line with their objection.
ALTER TABLE call_insights ADD COLUMN objection_line TEXT;
-- JSON: tag → { by: 'rules' | 'jev' | 'claude' | 'rep', p }, who decided each.
ALTER TABLE call_insights ADD COLUMN sources TEXT NOT NULL DEFAULT '{}';

-- A review of one call, by the rep (through the connector) or by Claude
-- (the button). The rep's wins over Claude's, and both over Jev and the rules.
CREATE TABLE IF NOT EXISTS call_reviews (
  call_task_id TEXT NOT NULL,
  reviewer     TEXT NOT NULL,           -- 'rep' | 'claude'
  corrections  TEXT NOT NULL DEFAULT '{}', -- JSON: tag → value
  what_worked  TEXT,
  adjust       TEXT,
  model        TEXT,                    -- Claude's model, for a Claude review
  usage        TEXT,                    -- JSON: Claude's token usage
  reviewed_at  TEXT NOT NULL,
  PRIMARY KEY (call_task_id, reviewer)
);

-- "Review all with Claude": each call queued, drained by the cron a few at a
-- time, never reviewed twice.
CREATE TABLE IF NOT EXISTS claude_review_jobs (
  call_task_id TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'running' | 'done' | 'failed'
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  queued_at    TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_claude_review_jobs_status ON claude_review_jobs(status, queued_at);

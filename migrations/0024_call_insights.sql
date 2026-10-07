-- Coaching (lib/call-insight.ts, lib/coaching.ts): what happened on each call
-- the rep logged from a CALL task, read from its transcript and summary when
-- it was recorded, else from the rep's notes, outcome and length. One row per
-- logged call, rewritten (never added to) when a better source arrives: a
-- transcript that finishes after the call was logged. D1 only: nothing here
-- is written to HubSpot, so extracting again is always safe.
CREATE TABLE IF NOT EXISTS call_insights (
  call_task_id        TEXT PRIMARY KEY,   -- the call_logs row it reads
  contact_id          TEXT NOT NULL,
  company_id          TEXT,
  dial_id             TEXT,
  label               TEXT NOT NULL,      -- who the call was with, for the pages
  at_sec              INTEGER NOT NULL,   -- when the call was made (the dial's start, else when it was logged)
  contact_tz          TEXT,               -- IANA zone from the contact's (or company's) state; NULL when unknown
  outcome             TEXT NOT NULL,      -- the rep's logged outcome (CALL_OUTCOMES)
  duration_sec        INTEGER,
  gate                TEXT NOT NULL,      -- who answered: 'owner' | 'gatekeeper' | 'voicemail' | 'no_answer' | 'wrong_number'
  gatekeeper_result   TEXT,               -- 'put_through' | 'sent_to_voicemail' | 'not_available' | 'took_message' | 'refused'
  gatekeeper_name     TEXT,               -- "Carmen", when the call says
  reached             INTEGER NOT NULL,   -- 1: spoke with the person they called for (a connect)
  stage               TEXT NOT NULL,      -- how far it got: see STAGES in lib/call-insight.ts
  objection           TEXT,               -- the objection, in their words
  objection_kind      TEXT,               -- see OBJECTIONS in lib/call-insight.ts
  got_past_objection  INTEGER NOT NULL DEFAULT 0,
  next_step           INTEGER NOT NULL DEFAULT 0, -- a concrete next step was agreed
  next_step_text      TEXT,
  opening             TEXT,               -- the rep's opening line to the person
  gatekeeper_line     TEXT,               -- what the rep said to the front desk
  what_worked         TEXT,
  adjust              TEXT,               -- one thing to do differently
  prospect_talk_share REAL,               -- transcript only: the prospect's share of the words
  rep_questions       INTEGER,            -- transcript only: questions the rep asked
  you_focus           REAL,               -- transcript only: the rep's "you/your" over "you" + "we/our/us"
  source              TEXT NOT NULL,      -- what it was read from: 'transcript' | 'notes' | 'outcome'
  ai                  INTEGER NOT NULL DEFAULT 0, -- 1: Workers AI read it; 0: the rules alone
  error               TEXT,               -- why Workers AI didn't, when it should have
  extracted_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_insights_contact ON call_insights(contact_id, at_sec);
CREATE INDEX IF NOT EXISTS idx_call_insights_company ON call_insights(company_id, at_sec);
CREATE INDEX IF NOT EXISTS idx_call_insights_at ON call_insights(at_sec);

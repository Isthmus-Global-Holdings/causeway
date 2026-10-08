-- Coaching, third version (lib/call-insight.ts, lib/call-timeline.ts): each
-- call drawn as a timeline, the Mom Test judgments, and interview dials read
-- with the same rules.

-- What the row reads: a CALL task's logged call ('task') or an interview's
-- recorded dial ('meeting'). As with dials.subject, call_task_id then holds
-- the meeting id (HubSpot's tasks and meetings share one id space), and so
-- does call_reviews.call_task_id for its reviews.
ALTER TABLE call_insights ADD COLUMN subject TEXT NOT NULL DEFAULT 'task';

-- The call drawn to scale (JSON, a Timeline from lib/call-timeline.ts): its
-- phases (phone menu, front desk, hold, them), who spoke when, and the marks
-- (the opening, the objection, the next step). NULL until the call is read by
-- these rules, or when there's nothing to draw (no transcript and no length).
ALTER TABLE call_insights ADD COLUMN timeline_json TEXT;

-- The Mom Test, on a call that reached them: 1/0, NULL when nothing could
-- say. The rules give a first pass from the transcript; a review
-- (call_reviews) settles them.
ALTER TABLE call_insights ADD COLUMN asked_last_time INTEGER; -- asked about a specific past instance
ALTER TABLE call_insights ADD COLUMN pitched INTEGER; -- described the idea or the product
ALTER TABLE call_insights ADD COLUMN longest_story_sec INTEGER; -- their longest uninterrupted turn
ALTER TABLE call_insights ADD COLUMN fluff_caught INTEGER; -- brought "usually" / "I would" back to a past instance
ALTER TABLE call_insights ADD COLUMN commitment TEXT; -- 'time' | 'intro' | 'money': what they gave up

CREATE INDEX IF NOT EXISTS idx_call_insights_subject_at ON call_insights(subject, at_sec);

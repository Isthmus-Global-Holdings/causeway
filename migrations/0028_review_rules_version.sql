-- Which rules a review answered to (REVIEW_RULES_VERSION in
-- lib/call-insight.ts): bumped when review_call gains tags, so a call
-- reviewed under older rules comes back to calls_to_review for the new
-- ones. Reviews from before this are 0: all of them come back.
ALTER TABLE call_reviews ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 0;

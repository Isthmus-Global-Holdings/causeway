-- The call a review is of. An interview's page can be dialled again, and the
-- new call is read on its own: the earlier call's review isn't laid over it,
-- and the new call comes back to calls_to_review. NULL (a review from before
-- this, or of a call logged by hand) applies to the call whatever its dial.
ALTER TABLE call_reviews ADD COLUMN dial_id TEXT;

-- Who called a canceled interview off: they did (they told the rep ahead, a
-- reply, unlike a no-show) or the rep did. D1 only: HubSpot's outcome is
-- CANCELED either way. Coaching counts their cancels as replies and leaves
-- the rep's out of the held rate; theirs gets a follow-up email drafted that
-- offers another time. NULL on everything but CANCELED, and on cancels logged
-- before this, which coaching reads as theirs.
ALTER TABLE meeting_logs ADD COLUMN canceled_by TEXT; -- 'them' | 'rep'

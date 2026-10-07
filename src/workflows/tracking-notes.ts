// A HubSpot note for the first open of an email, or the first click of a
// link, written at most once. The claim goes in before the note.
// - HubSpot definitely rejected it (4xx, e.g. rate limited): the claim is
//   released so a later event retries.
// - The outcome is unknown (network error, 5xx, lost response): the claim is
//   kept, because HubSpot may have created the note and a retry would
//   duplicate it. A possibly missing note beats a duplicate, the same rule as
//   the email log in send-email.ts.
// (Counting the events themselves is separate: that's tracking_events.)

import { claimTrackingNote, releaseTrackingNote, type NoteKey } from '../lib/db';
import { HubSpotApiError } from '../lib/hubspot';

export async function noteOnce(
  db: D1Database,
  key: NoteKey,
  writeNote: () => Promise<unknown>
): Promise<'written' | 'already-noted'> {
  if (!(await claimTrackingNote(db, key))) return 'already-noted';
  try {
    await writeNote();
    return 'written';
  } catch (err) {
    if (err instanceof HubSpotApiError && err.status >= 400 && err.status < 500) await releaseTrackingNote(db, key);
    throw err;
  }
}

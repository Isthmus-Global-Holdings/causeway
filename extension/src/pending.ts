// Pitches pasted but not yet logged (offline, signed out, Causeway down).
// The next press of the shortcut on that job logs it without pasting it
// again, and the panel offers to log them all. Kept in session storage: it
// outlives the service worker, not the browser.

import type { Pitch } from '../../src/lib/upwork';

const KEY = 'pendingPitches';

// What the panel's "Log them now" got back from the service worker.
export interface PendingResult {
  logged: number;
  left: number;
  why: string | null; // the first failure, in words
}

async function load(): Promise<Record<string, Pitch>> {
  const stored = (await chrome.storage.session.get(KEY)) as Record<string, unknown>;
  const value = stored[KEY];
  return value && typeof value === 'object' ? (value as Record<string, Pitch>) : {};
}

export async function pendingPitches(): Promise<Pitch[]> {
  return Object.values(await load());
}

export async function pendingPitch(jobId: string): Promise<Pitch | null> {
  return (await load())[jobId] ?? null;
}

export async function setPending(pitch: Pitch): Promise<void> {
  await chrome.storage.session.set({ [KEY]: { ...(await load()), [pitch.jobId]: pitch } });
}

export async function clearPending(jobId: string): Promise<void> {
  const all = await load();
  delete all[jobId];
  await chrome.storage.session.set({ [KEY]: all });
}

// Talking to Causeway as the rep: the Access session (signing in to Causeway
// with Google) rides along as a cookie.

import type { Pitch } from '../../src/lib/upwork';

export type CausewayStatus = 'signed-in' | 'signed-out' | 'unreachable';

// A signed-out request is sent to Access's sign-in page. /unfinished is the
// app's lightest page: D1 only, no HubSpot.
export async function causewayStatus(workerUrl: string): Promise<CausewayStatus> {
  try {
    const res = await fetch(`${workerUrl}/unfinished`, { credentials: 'include', redirect: 'manual' });
    if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) return 'signed-out';
    return res.ok ? 'signed-in' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export type LogOutcome =
  | { kind: 'logged'; created: boolean; dealUrl: string }
  | { kind: 'signed-out' }
  | { kind: 'offline' }
  | { kind: 'failed'; why: string };

interface PitchAnswer {
  dealUrl?: string;
  created?: boolean;
  error?: string;
}

// Null when it isn't JSON (the status then says what happened).
async function answer(res: Response): Promise<PitchAnswer | null> {
  try {
    return (await res.json()) as PitchAnswer;
  } catch {
    return null;
  }
}

// POST /pitches: the job's deal, made or found. Safe to repeat.
export async function postPitch(workerUrl: string, pitch: Pitch): Promise<LogOutcome> {
  let res: Response;
  try {
    res = await fetch(`${workerUrl}/pitches`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pitch),
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.type === 'opaqueredirect' || res.status === 401) return { kind: 'signed-out' };
  const body = await answer(res);
  if (res.ok && body?.dealUrl) return { kind: 'logged', created: body.created === true, dealUrl: body.dealUrl };
  const why =
    res.status === 403
      ? 'Causeway refused the extension. It’s running code from before /pitches (restart it from the current code), or PITCH_EXTENSION_ID in wrangler.jsonc doesn’t match this extension’s ID.'
      : (body?.error ?? `Causeway answered ${res.status}.`);
  return { kind: 'failed', why };
}

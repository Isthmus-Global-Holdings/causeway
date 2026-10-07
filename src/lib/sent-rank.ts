// The order of "Sent from this app": the people worth calling now on top.
// Someone who clicked a link in the email, then someone who opened it, and
// hasn't been called since. Within each, the most recent first; everything
// else keeps its order (newest sent first). No I/O here.

export type Heat = 'clicked' | 'opened' | null;

export interface RankableSend {
  status: string;
  track_opens: number | null; // 0 = open tracking was off
  track_clicks: number | null;
  opens: number;
  clicks: number;
  last_event_at: string | null; // SQLite UTC, sorts as text
  last_open_at: string | null;
  called_at: string | null; // a call logged to the contact since the send
}

export function heat(s: RankableSend): Heat {
  if (s.status !== 'sent' || s.called_at !== null) return null;
  if (s.track_clicks !== 0 && s.clicks > 0) return 'clicked';
  if (s.track_opens !== 0 && s.opens > 0) return 'opened';
  return null;
}

export function rankSends<T extends RankableSend>(sends: T[]): T[] {
  const tier = (s: T) => {
    const h = heat(s);
    return h === 'clicked' ? 0 : h === 'opened' ? 1 : 2;
  };
  const lastSeen = (s: T) => (heat(s) === 'opened' ? s.last_open_at : s.last_event_at) ?? '';
  return sends
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const byTier = tier(a.s) - tier(b.s);
      if (byTier) return byTier;
      if (tier(a.s) < 2) {
        const byRecent = lastSeen(b.s).localeCompare(lastSeen(a.s));
        if (byRecent) return byRecent;
      }
      return a.i - b.i;
    })
    .map(({ s }) => s);
}

// The order the rep works through today's calls or emails. It's saved when
// the Calls or Queue page shows (lib/db.ts), so logging a call or sending an
// email can go straight to the next one without searching HubSpot again.
// No I/O here.

export interface WorkPlan {
  date: string; // YYYY-MM-DD in the rep's time zone
  // Best first; `drafted` means something only for emails. `at` (epoch ms):
  // a call at a set time, which is next from then on and skipped before.
  items: { id: string; drafted: boolean; at?: number }[];
}

export function parsePlan(value: string | null | undefined): WorkPlan | null {
  if (!value) return null;
  try {
    const plan = JSON.parse(value) as Partial<WorkPlan>;
    if (typeof plan.date !== 'string' || !Array.isArray(plan.items)) return null;
    const items = plan.items.filter(
      (i): i is WorkPlan['items'][number] =>
        typeof i?.id === 'string' && typeof i.drafted === 'boolean' && (i.at === undefined || typeof i.at === 'number')
    );
    return { date: plan.date, items };
  } catch {
    return null;
  }
}

// The next item in today's plan that isn't `current` and isn't `done`. A plan
// from an earlier day is stale: the rep reopens the list instead. Emails
// follow the queue's Next up (pickNextUp in lib/fit.ts): one still to draft
// comes before one that's ready to send. A call at a set time comes first
// once it's `now` (`at`), and not before.
export function nextInPlan(
  plan: WorkPlan | null,
  today: string,
  current: string,
  done: Set<string>,
  opts: { undraftedFirst?: boolean; now?: number } = {}
): WorkPlan['items'][number] | null {
  if (!plan || plan.date !== today) return null;
  const now = opts.now ?? Number.POSITIVE_INFINITY; // only call plans hold set times
  const open = plan.items.filter((i) => i.id !== current && !done.has(i.id) && (i.at === undefined || i.at <= now));
  return (
    open.find((i) => i.at !== undefined) ??
    (opts.undraftedFirst ? open.find((i) => !i.drafted) : undefined) ??
    open[0] ??
    null
  );
}

// Adds a call at a set time made after the plan was saved (a follow-up logged
// for later today, or a call moved to a time today), so logging another call
// goes to it once its time comes. Set-time calls stay first, soonest first,
// which is the order nextInPlan picks them in. A plan from another day is
// left alone: the queue rebuilds it.
export function withSetTimeCall(plan: WorkPlan | null, today: string, id: string, at: number): WorkPlan | null {
  if (!plan || plan.date !== today) return plan;
  const items = plan.items.filter((i) => i.id !== id);
  const after = items.findIndex((i) => i.at === undefined || i.at > at);
  items.splice(after === -1 ? items.length : after, 0, { id, drafted: false, at });
  return { ...plan, items };
}

export function withoutItem(plan: WorkPlan, id: string): WorkPlan {
  return { ...plan, items: plan.items.filter((i) => i.id !== id) };
}

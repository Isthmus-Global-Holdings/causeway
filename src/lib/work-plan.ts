// The order the rep works through today's calls or emails. It's saved when
// the Calls or Queue page shows (lib/db.ts), so logging a call or sending an
// email can go straight to the next one without searching HubSpot again.
// No I/O here.

export interface WorkPlan {
  date: string; // YYYY-MM-DD in the rep's time zone
  // Best first; `drafted` means something only for emails. `at` (epoch ms):
  // a call at a set time, which is next from then on and skipped before.
  // `company` and `contact`: who it is, for the call page's list of today's
  // calls, so it never reads HubSpot for them.
  items: { id: string; drafted: boolean; at?: number; company?: string; contact?: string }[];
}

const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';

export function parsePlan(value: string | null | undefined): WorkPlan | null {
  if (!value) return null;
  try {
    const plan = JSON.parse(value) as Partial<WorkPlan>;
    if (typeof plan.date !== 'string' || !Array.isArray(plan.items)) return null;
    const items = plan.items.filter(
      (i): i is WorkPlan['items'][number] =>
        typeof i?.id === 'string' &&
        typeof i.drafted === 'boolean' &&
        (i.at === undefined || typeof i.at === 'number') &&
        optionalString(i.company) &&
        optionalString(i.contact)
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
// which is the order nextInPlan picks them in. It keeps who it is from its own
// entry, or from `sameAs`'s (the call a follow-up came from). A plan from
// another day is left alone: the queue rebuilds it.
export function withSetTimeCall(
  plan: WorkPlan | null,
  today: string,
  id: string,
  at: number,
  sameAs: string = id
): WorkPlan | null {
  if (!plan || plan.date !== today) return plan;
  const from = plan.items.find((i) => i.id === id) ?? plan.items.find((i) => i.id === sameAs);
  const who = {
    ...(from?.company !== undefined ? { company: from.company } : {}),
    ...(from?.contact !== undefined ? { contact: from.contact } : {}),
  };
  const items = plan.items.filter((i) => i.id !== id);
  const after = items.findIndex((i) => i.at === undefined || i.at > at);
  items.splice(after === -1 ? items.length : after, 0, { id, drafted: false, at, ...who });
  return { ...plan, items };
}

export function withoutItem(plan: WorkPlan, id: string): WorkPlan {
  return { ...plan, items: plan.items.filter((i) => i.id !== id) };
}

export type PlanItemState = 'done' | 'current' | 'next' | 'open';

export interface PlanProgress {
  items: (WorkPlan['items'][number] & { state: PlanItemState })[];
  left: number; // not done, the current one included
  done: number;
}

// Today's plan as the call page lists it beside the call: what's done, the
// one open now, the one logging it goes to (nextInPlan), and the rest. A
// plan from another day is no list. `current` may not be in it (a call opened
// from a contact): then it's only the list.
export function planProgress(
  plan: WorkPlan | null,
  today: string,
  current: string,
  done: Set<string>,
  opts: { now?: number } = {}
): PlanProgress | null {
  if (!plan || plan.date !== today) return null;
  const next = nextInPlan(plan, today, current, done, opts)?.id ?? null;
  const items = plan.items.map((i) => ({
    ...i,
    state: (i.id === current ? 'current' : done.has(i.id) ? 'done' : i.id === next ? 'next' : 'open') as PlanItemState,
  }));
  const doneCount = items.filter((i) => i.state === 'done').length;
  return { items, left: items.length - doneCount, done: doneCount };
}

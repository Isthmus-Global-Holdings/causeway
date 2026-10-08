// Timezone math with Intl only: Workers have full ICU data, and this keeps the
// module free of date libraries.

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(epochMs: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

// Offset of `timeZone` from UTC at the given instant, in ms (Panama: -5h).
function offsetMs(epochMs: number, timeZone: string): number {
  const p = localParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

// hs_timestamp comes back as an ISO string; older records may hold epoch ms.
export function parseHubSpotTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export interface TimeOfDay {
  hour: number;
  minute: number;
}

// A time of day as the rep types it: "4pm", "4 PM", "4:30pm", "4:30 p.m.",
// or 24-hour "16:30" (what the connector sends). A bare "4" or "4:30" could
// be morning or afternoon, so it needs its am or pm.
export function parseTime(value: string): TimeOfDay | null {
  const text = value.trim().toLowerCase();
  const h24 = /^(\d{2}):(\d{2})$/.exec(text);
  if (h24) {
    const hour = Number(h24[1]);
    const minute = Number(h24[2]);
    return hour < 24 && minute < 60 ? { hour, minute } : null;
  }
  const h12 = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*(?:m\.?)?$/.exec(text);
  if (!h12) return null;
  const hour = Number(h12[1]);
  const minute = Number(h12[2] ?? '0');
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return { hour: (hour % 12) + (h12[3] === 'p' ? 12 : 0), minute };
}

// The same shapes, for a time field's pattern attribute, so the browser asks
// for the am or pm before the form is sent. parseTime still has the last word
// (it also checks the hour and minutes are on the clock).
export const TIME_PATTERN = String.raw`\s*(\d{1,2}(:\d{2})?\s*[AaPp]\.?\s*([Mm]\.?)?|\d{2}:\d{2})\s*`;

// An IANA time zone this runtime knows, e.g. "America/Denver".
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

// A time of day as the contact said it: "call me at 2pm" in their zone, when
// `timeZone` is given, else in the rep's. It's turned into an instant once
// (saidAt), and from then on everything is shown in the rep's zone.
export interface SaidTime extends TimeOfDay {
  timeZone?: string;
}

// A typed time and the zone it was said in: a form's "<field>_tz" select, or
// the connector's time_zone. A blank zone is the rep's own. Null when the
// time doesn't parse or the zone isn't one.
export function parseSaidTime(text: string, zone?: string | null): SaidTime | null {
  const time = parseTime(text);
  const tz = zone?.trim() ?? '';
  if (!time || (tz && !isTimeZone(tz))) return null;
  return tz ? { ...time, timeZone: tz } : time;
}

// Local wall-clock time of an instant, e.g. to reuse a task's due time.
export function timeOfDay(epochMs: number, timeZone: string): TimeOfDay {
  const p = localParts(epochMs, timeZone);
  return { hour: p.hour, minute: p.minute };
}

// "Fri, Sep 25, 2:30 PM" in `timeZone`, for due times on the pages.
export function formatLocal(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

// "2:30 PM" in `timeZone`.
export function formatClock(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(epochMs));
}

// "Fri, Sep 25" in `timeZone`, for a day with no time that matters.
export function formatDay(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(
    new Date(epochMs)
  );
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// The local calendar date of an instant, as "YYYY-MM-DD" (what <input type=date> uses).
export function localDate(epochMs: number, timeZone: string): string {
  const p = localParts(epochMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function isDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

// "YYYY-MM-DD" plus a number of days. Date.UTC normalises day overflow, so
// the 31st + 1 rolls into next month/year.
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// The instant at `at` local time on `date` ("YYYY-MM-DD") in `timeZone`.
export function localDateAt(date: string, timeZone: string, at: TimeOfDay): number {
  const [y, m, d] = date.split('-').map(Number);
  const wallClock = Date.UTC(y, m - 1, d, at.hour, at.minute);
  // First guess uses the offset at the wall-clock time; re-check once at the
  // result so a DST change between the two instants doesn't shift the hour.
  const guess = wallClock - offsetMs(wallClock, timeZone);
  return wallClock - offsetMs(guess, timeZone);
}

// The instant a said time names on `date` ("YYYY-MM-DD", their date when
// it's in their zone), in the zone it was said in, else `timeZone` (the rep's).
export function saidAt(date: string, time: SaidTime, timeZone: string): number {
  return localDateAt(date, time.timeZone ?? timeZone, time);
}

// The instant at `at` local time on the calendar day after `nowMs`'s local
// date in `timeZone`.
export function nextCalendarDayAt(nowMs: number, timeZone: string, at: TimeOfDay): number {
  return localDateAt(addDays(localDate(nowMs, timeZone), 1), timeZone, at);
}

// The instant on `date` ("YYYY-MM-DD") at `dueMs`'s local time of day, else at
// `fallback`: a task moved to another day keeps the hour it was due at.
export function sameTimeOn(date: string, dueMs: number | null, timeZone: string, fallback: TimeOfDay): number {
  return localDateAt(date, timeZone, dueMs === null ? fallback : timeOfDay(dueMs, timeZone));
}

// The first instant of a local date. Where the clocks spring forward at
// midnight (Havana, Santiago), midnight never happens and localDateAt lands in
// the previous day's last hour: the day starts at the jump instead, which is
// midnight at the offset in force before it.
function startOfDay(date: string, timeZone: string): number {
  const midnight = localDateAt(date, timeZone, { hour: 0, minute: 0 });
  if (localDate(midnight, timeZone) === date) return midnight;
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - offsetMs(midnight, timeZone);
}

// The local calendar day `nowMs` falls on in `timeZone`, as the instants it
// starts and ends at (end exclusive). A DST day is 23 or 25 hours long.
export function dayBounds(nowMs: number, timeZone: string): { startMs: number; endMs: number } {
  const today = localDate(nowMs, timeZone);
  return { startMs: startOfDay(today, timeZone), endMs: startOfDay(addDays(today, 1), timeZone) };
}

// When an upcoming `eventMs` is, from `nowMs`, the way you'd say it in a
// message: "today at 2:30 PM", "tomorrow at 10:00 AM", "on Friday at 9:00 AM"
// within the coming week, else "on Oct 14 at 9:00 AM".
export function saidAhead(eventMs: number, nowMs: number, timeZone: string): string {
  const day = localDate(eventMs, timeZone);
  const today = localDate(nowMs, timeZone);
  const at = formatClock(eventMs, timeZone);
  if (day === today) return `today at ${at}`;
  if (day === addDays(today, 1)) return `tomorrow at ${at}`;
  const format =
    day <= addDays(today, 6) && day > today
      ? { weekday: 'long' as const }
      : { month: 'short' as const, day: 'numeric' as const };
  return `on ${new Intl.DateTimeFormat('en-US', { timeZone, ...format }).format(new Date(eventMs))} at ${at}`;
}

// When `eventMs` was, from `nowMs`, the way you'd say it in an email: "today",
// "yesterday", "on Friday" within the past week, else "on Sep 18".
export function saidWhen(eventMs: number, nowMs: number, timeZone: string): string {
  const day = localDate(eventMs, timeZone);
  const today = localDate(nowMs, timeZone);
  if (day === today) return 'today';
  if (addDays(day, 1) === today) return 'yesterday';
  const format =
    addDays(day, 6) >= today ? { weekday: 'long' as const } : { month: 'short' as const, day: 'numeric' as const };
  return `on ${new Intl.DateTimeFormat('en-US', { timeZone, ...format }).format(new Date(eventMs))}`;
}

// How long ago `eventMs` was, by the rep's calendar days, for a list of what
// happened: "today", "yesterday", "3 days ago", "2 weeks ago", "5 months ago".
export function ago(eventMs: number, nowMs: number, timeZone: string): string {
  const days = Math.round(
    (Date.parse(`${localDate(nowMs, timeZone)}T00:00:00Z`) - Date.parse(`${localDate(eventMs, timeZone)}T00:00:00Z`)) /
      86_400_000
  );
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

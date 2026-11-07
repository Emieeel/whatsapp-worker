// Date helpers. A "day" is a plain `YYYY-MM-DD` string in the configured timezone,
// which keeps comparisons, SQL and week arithmetic free of timezone surprises.

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Calendar day (`YYYY-MM-DD`) of `date` in `timeZone`. */
export function dayKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes since local midnight of `date` in `timeZone`. */
export function minutesOfDay(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return Number(p.hour) * 60 + Number(p.minute);
}

/** Offset of `timeZone` from UTC at `date`, in ms (e.g. +3600000 for CET). */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const local = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return local - Math.floor(date.getTime() / 1000) * 1000;
}

/** Unix seconds for a wall-clock time on `day` in `timeZone` (handles summer/winter time). */
export function zonedTimeToUnix(day: string, hour: number, minute: number, second: number, timeZone: string): number {
  const wall = Date.parse(`${day}T00:00:00Z`) + ((hour * 60 + minute) * 60 + second) * 1000;
  let utc = wall;
  for (let i = 0; i < 3; i++) utc = wall - offsetMs(new Date(utc), timeZone);
  return Math.floor(utc / 1000);
}

function toUtcDate(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

export function addDays(day: string, n: number): string {
  const d = toUtcDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(day: string): number {
  return (toUtcDate(day).getUTCDay() + 6) % 7;
}

export function isSunday(day: string): boolean {
  return weekdayIndex(day) === 6;
}

/** Monday of the (ISO) week containing `day`. */
export function weekStart(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

/** All days from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const nlLong = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const nlDayMonth = new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', day: 'numeric', month: 'long' });
const nlWeekdayShort = new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', weekday: 'short' });

/** "vrijdag 6 november" */
export function formatDayLong(day: string): string {
  return nlLong.format(toUtcDate(day));
}

/** "6 november" */
export function formatDayMonth(day: string): string {
  return nlDayMonth.format(toUtcDate(day));
}

/** "vr" */
export function formatWeekdayShort(day: string): string {
  return nlWeekdayShort.format(toUtcDate(day)).replace('.', '');
}

/**
 * Turn a year-less month/day (as printed by some games) into a full date, picking the
 * year that puts it closest to `referenceDay`. Returns null for impossible dates.
 */
export function resolveMonthDay(month: number, dayOfMonth: number, referenceDay: string): string | null {
  const refYear = Number(referenceDay.slice(0, 4));
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const year of [refYear - 1, refYear, refYear + 1]) {
    const d = new Date(Date.UTC(year, month - 1, dayOfMonth, 12));
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== dayOfMonth) return null;
    const iso = d.toISOString().slice(0, 10);
    const distance = Math.abs(d.getTime() - toUtcDate(referenceDay).getTime());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = iso;
    }
  }
  return best;
}

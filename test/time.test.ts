import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayKey,
  formatDayLong,
  formatWeekdayShort,
  isSunday,
  minutesOfDay,
  resolveMonthDay,
  weekStart,
} from '../src/time.js';

const TZ = 'Europe/Amsterdam';

describe('time helpers', () => {
  it('uses the Amsterdam calendar day (winter and summer time)', () => {
    expect(dayKey(new Date('2026-11-05T22:59:00Z'), TZ)).toBe('2026-11-05');
    expect(dayKey(new Date('2026-11-05T23:01:00Z'), TZ)).toBe('2026-11-06'); // 00:01 CET
    expect(dayKey(new Date('2026-07-01T22:30:00Z'), TZ)).toBe('2026-07-02'); // 00:30 CEST
  });

  it('computes minutes since local midnight', () => {
    expect(minutesOfDay(new Date('2026-11-06T21:00:00Z'), TZ)).toBe(22 * 60);
  });

  it('does week arithmetic on plain dates', () => {
    expect(weekStart('2026-11-08')).toBe('2026-11-02'); // Sunday -> Monday
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
    expect(isSunday('2026-11-08')).toBe(true);
    expect(isSunday('2026-11-06')).toBe(false);
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30'); // across DST change
  });

  it('resolves year-less dates to the nearest year', () => {
    expect(resolveMonthDay(11, 6, '2026-11-06')).toBe('2026-11-06');
    expect(resolveMonthDay(12, 31, '2027-01-01')).toBe('2026-12-31');
    expect(resolveMonthDay(1, 1, '2026-12-31')).toBe('2027-01-01');
    expect(resolveMonthDay(2, 30, '2026-02-01')).toBeNull();
  });

  it('formats Dutch dates', () => {
    expect(formatDayLong('2026-11-06')).toBe('vrijdag 6 november');
    expect(formatWeekdayShort('2026-11-02')).toBe('ma');
  });
});

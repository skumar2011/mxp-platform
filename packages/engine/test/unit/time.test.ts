import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, eachDay, isValidTimezone, localDate, periodOf, previousPeriod, zonedToIso } from '../../src/index';

describe('periods', () => {
  it('monthly periods cover the calendar month, including leap February', () => {
    expect(periodOf('2026-10-10', 'MONTHLY')).toEqual({ type: 'MONTHLY', key: '2026-10', start: '2026-10-01', end: '2026-10-31' });
    expect(periodOf('2028-02-10', 'MONTHLY').end).toBe('2028-02-29');
    expect(periodOf('2026-02-10', 'MONTHLY').end).toBe('2026-02-28');
  });

  it('quarterly and daily periods', () => {
    expect(periodOf('2026-11-15', 'QUARTERLY')).toMatchObject({ key: '2026-Q4', start: '2026-10-01', end: '2026-12-31' });
    expect(periodOf('2026-02-01', 'QUARTERLY')).toMatchObject({ key: '2026-Q1', end: '2026-03-31' });
    expect(periodOf('2026-10-10', 'DAILY')).toMatchObject({ key: '2026-10-10', start: '2026-10-10', end: '2026-10-10' });
  });

  it('weekly periods run Monday to Sunday and use ISO week numbers across year ends', () => {
    expect(periodOf('2026-10-10', 'WEEKLY')).toMatchObject({ key: '2026-W41', start: '2026-10-05', end: '2026-10-11' });
    // 1 Jan 2027 is a Friday and belongs to ISO week 53 of 2026
    expect(periodOf('2027-01-01', 'WEEKLY')).toMatchObject({ key: '2026-W53', start: '2026-12-28', end: '2027-01-03' });
  });

  it('campaign periods are the campaign window', () => {
    expect(periodOf('2026-10-10', 'CAMPAIGN', { code: 'FEST', start: '2026-09-01', end: '2026-11-30' })).toEqual({ type: 'CAMPAIGN', key: 'C:FEST', start: '2026-09-01', end: '2026-11-30' });
    expect(() => periodOf('2026-10-10', 'CAMPAIGN')).toThrow(/campaign/i);
  });

  it('finds the previous period', () => {
    expect(previousPeriod(periodOf('2026-01-15', 'MONTHLY'))!.key).toBe('2025-12');
    expect(previousPeriod(periodOf('2026-10-10', 'CAMPAIGN', { code: 'X', start: '2026-10-01', end: '2026-10-31' }))).toBeNull();
  });
});

describe('dates and time zones', () => {
  it('assigns an instant to the local calendar day of the rule time zone', () => {
    // 19:00 UTC on 30 Sep is already 1 Oct in India (UTC+5:30)
    expect(localDate('2026-09-30T19:00:00Z', 'Asia/Kolkata')).toBe('2026-10-01');
    expect(localDate('2026-09-30T18:29:00Z', 'Asia/Kolkata')).toBe('2026-09-30');
    expect(localDate('2026-09-30T19:00:00Z', 'UTC')).toBe('2026-09-30');
    expect(localDate('2026-10-01T03:00:00Z', 'America/Los_Angeles')).toBe('2026-09-30');
  });

  it('converts a local wall-clock time to a UTC instant and back', () => {
    expect(zonedToIso('2026-10-01', '00:00', 'Asia/Kolkata')).toBe('2026-09-30T18:30:00.000Z');
    expect(localDate(zonedToIso('2026-10-01', '00:30', 'Asia/Kolkata'), 'Asia/Kolkata')).toBe('2026-10-01');
  });

  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(eachDay('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('validates time zone names', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });

  it('rejects invalid timestamps', () => {
    expect(() => localDate('not a date', 'UTC')).toThrow(/Invalid timestamp/);
  });
});

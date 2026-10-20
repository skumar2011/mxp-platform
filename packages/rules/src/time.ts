/**
 * Calendar helpers. Business dates are 'YYYY-MM-DD' strings in the rule's timezone.
 * Uses only Intl, so it runs unchanged in Node and in browsers.
 */
export type CalendarWindow = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

export interface Period {
  key: string;
  /** Inclusive local dates. */
  start: string;
  end: string;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  date: string;
  /** "HH:mm" */
  time: string;
  hour: number;
  /** 1 = Monday ... 7 = Sunday */
  dow: number;
  dom: number;
}

export function localParts(iso: string, tz: string): LocalParts {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${iso}`);
  const p: Record<string, string> = {};
  for (const part of dtf(tz).formatToParts(d)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${p.hour}:${p.minute}`, hour: Number(p.hour), dow: dow(date), dom: Number(p.day) };
}

const parse = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
};
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function dow(date: string): number {
  const d = parse(date).getUTCDay();
  return d === 0 ? 7 : d;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
}

export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isoWeek(date: string): { year: number; week: number } {
  const d = parse(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7) };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function periodOf(date: string, type: CalendarWindow): Period {
  const [y, m] = date.split('-').map(Number);
  switch (type) {
    case 'DAY':
      return { key: date, start: date, end: date };
    case 'WEEK': {
      const start = addDays(date, -(dow(date) - 1));
      const { year, week } = isoWeek(date);
      return { key: `${year}-W${pad(week)}`, start, end: addDays(start, 6) };
    }
    case 'MONTH':
      return { key: `${y}-${pad(m)}`, start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` };
    case 'QUARTER': {
      const q = Math.floor((m - 1) / 3) + 1;
      const sm = (q - 1) * 3 + 1;
      const em = sm + 2;
      return { key: `${y}-Q${q}`, start: `${y}-${pad(sm)}-01`, end: `${y}-${pad(em)}-${pad(lastDayOfMonth(y, em))}` };
    }
    case 'YEAR':
      return { key: `${y}`, start: `${y}-01-01`, end: `${y}-12-31` };
  }
}

export function previousPeriod(p: Period, type: CalendarWindow): Period {
  return periodOf(addDays(p.start, -1), type);
}

export function nextPeriod(p: Period, type: CalendarWindow): Period {
  return periodOf(addDays(p.end, 1), type);
}

/** Minutes since midnight for "HH:mm". */
export function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Inclusive start, exclusive end; a range whose end is before its start wraps past midnight (22:00-06:00). */
export function timeInRange(t: string, from: string, to: string): boolean {
  const x = minutesOf(t), a = minutesOf(from), b = minutesOf(to);
  if ([x, a, b].some(Number.isNaN)) return false;
  if (a === b) return true;
  return a < b ? x >= a && x < b : x >= a || x < b;
}

/** Converts a local wall-clock date and "HH:mm" in a timezone to a UTC ISO instant. */
export function zonedToIso(date: string, hhmm: string, tz: string): string {
  const [h, mi] = hhmm.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = dtf(tz).formatToParts(new Date(guess));
    const get = (t: string) => Number(p.find((x) => x.type === t)!.value);
    const seen = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    const diff = target - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess).toISOString();
}

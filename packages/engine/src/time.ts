import { MxpError } from './util';

export type PeriodType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'CAMPAIGN';

export interface Period {
  type: PeriodType;
  key: string;
  /** Inclusive local dates, YYYY-MM-DD. */
  start: string;
  end: string;
}

export interface CampaignWindow {
  code: string;
  start: string;
  end: string;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
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
  hour: number;
  dayOfWeek: number; // 1 = Monday ... 7 = Sunday
  dayOfMonth: number;
}

export function localParts(iso: string, tz: string): LocalParts {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new MxpError('INVALID_TIMESTAMP', `Invalid timestamp: ${iso}`);
  const p: Record<string, string> = {};
  for (const part of dtf(tz).formatToParts(d)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, hour: Number(p.hour), dayOfWeek: dow(date), dayOfMonth: Number(p.day) };
}

export function localDate(iso: string, tz: string): string {
  return localParts(iso, tz).date;
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

/** 1 = Monday ... 7 = Sunday. */
export function dow(date: string): number {
  const d = parse(date).getUTCDay();
  return d === 0 ? 7 : d;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isoWeek(date: string): { year: number; week: number } {
  const d = parse(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this ISO week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export function periodOf(date: string, type: PeriodType, campaign?: CampaignWindow | null): Period {
  const [y, m] = date.split('-').map(Number);
  switch (type) {
    case 'DAILY':
      return { type, key: date, start: date, end: date };
    case 'WEEKLY': {
      const start = addDays(date, -(dow(date) - 1));
      const { year, week } = isoWeek(date);
      return { type, key: `${year}-W${String(week).padStart(2, '0')}`, start, end: addDays(start, 6) };
    }
    case 'MONTHLY': {
      const mm = String(m).padStart(2, '0');
      return {
        type,
        key: `${y}-${mm}`,
        start: `${y}-${mm}-01`,
        end: `${y}-${mm}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}`,
      };
    }
    case 'QUARTERLY': {
      const q = Math.floor((m - 1) / 3) + 1;
      const sm = (q - 1) * 3 + 1;
      const em = sm + 2;
      return {
        type,
        key: `${y}-Q${q}`,
        start: `${y}-${String(sm).padStart(2, '0')}-01`,
        end: `${y}-${String(em).padStart(2, '0')}-${String(lastDayOfMonth(y, em)).padStart(2, '0')}`,
      };
    }
    case 'CAMPAIGN': {
      if (!campaign) throw new MxpError('NO_CAMPAIGN', 'CAMPAIGN period requires a campaign');
      return { type, key: `C:${campaign.code}`, start: campaign.start, end: campaign.end };
    }
  }
}

/** Period immediately before the given one (used for opening balances and period-over-period rules). */
export function previousPeriod(p: Period): Period | null {
  if (p.type === 'CAMPAIGN') return null;
  return periodOf(addDays(p.start, -1), p.type);
}

/** Converts a local wall-clock date and time ("HH:mm") in a timezone to a UTC ISO instant. */
export function zonedToIso(date: string, hhmm: string, tz: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  const target = Date.UTC(y, mo - 1, d, h, m);
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

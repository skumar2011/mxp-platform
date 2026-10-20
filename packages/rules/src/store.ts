/**
 * State the engine keeps between events. The engine talks to a tiny key-value
 * interface so any host can persist it (memory, SQLite, PostgreSQL, Redis).
 *
 * Keys:
 *   w|<rule>|<subject>|<window>   WindowState   accumulators, breaches, awards for one window
 *   r|<rule>|<subject>            RollingState  day buckets for ROLLING_DAYS windows
 *   l|<rule>|<subject>            LifetimeState lifetime caps, award count, streaks
 *   x|<rule>|<subject>|<eventId>  IndexEntry    idempotency and reversal lookup
 *
 * Hosts with an async database can pre-load keys into a MemoryStateStore, run
 * the engine, then persist `store.dirty()`.
 */
import type { Family } from './schema';

export interface Contribution {
  eventId: string;
  day: string;
  at: string;
  /** Measured amount (1 for counts). */
  amount: number;
  /** COUNT_DISTINCT key. */
  key?: string;
}

export type WindowOutcome = 'IN_PROGRESS' | 'GOAL_MET' | 'BREACHED' | 'COMPLIANT' | 'MISSED' | 'NO_ACTIVITY' | 'CLOSED';

export interface WindowState {
  key: string;
  ruleCode: string;
  ruleVersion: number;
  family: Family;
  subjectKey: string;
  customerId: string;
  accountId?: string | null;
  settingId?: string | null;
  settingVersion?: number | null;
  windowKey: string;
  windowStart: string;
  windowEnd: string;
  /** The window is closed by close() on or after this date. */
  closeAfter: string;
  status: 'OPEN' | 'CLOSED';
  outcome: WindowOutcome;
  value: number;
  target: number | null;
  activity: number;
  matched: number;
  contributions: Record<string, Contribution>;
  breaches: number;
  firstBreachAt?: string | null;
  warned: boolean;
  nudged: string[];
  achievedTier: number;
  /** slot -> points currently held (tier:1, event:<id>, compliance). */
  awards: Record<string, number>;
  points: number;
  /** Parameter values used for this window (customer limit, targets...). */
  params: Record<string, unknown>;
  updatedAt: string;
}

export interface RollingState {
  key: string;
  contributions: Record<string, Contribution>;
}

export interface LifetimeState {
  key: string;
  points: number;
  awards: number;
  streak?: { current: number; best: number; last: string | null; run: number };
}

export interface IndexEntry {
  key: string;
  windowKey: string;
  cKey: string;
}

export interface StateStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  /** OPEN window states whose closeAfter is before `date` (YYYY-MM-DD). */
  dueWindows(date: string): WindowState[];
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export class MemoryStateStore implements StateStore {
  private map = new Map<string, unknown>();
  private touched = new Set<string>();

  constructor(initial?: Record<string, unknown>) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.map.set(k, clone(v));
  }

  get<T>(key: string): T | undefined {
    return clone(this.map.get(key) as T | undefined);
  }

  set(key: string, value: unknown): void {
    this.map.set(key, clone(value));
    this.touched.add(key);
  }

  dueWindows(date: string): WindowState[] {
    const out: WindowState[] = [];
    for (const [k, v] of this.map) if (k.startsWith('w|') && (v as WindowState).status === 'OPEN' && (v as WindowState).closeAfter < date) out.push(clone(v as WindowState));
    return out;
  }

  windows(): WindowState[] {
    return [...this.map.entries()].filter(([k]) => k.startsWith('w|')).map(([, v]) => clone(v as WindowState));
  }

  lifetimes(): LifetimeState[] {
    return [...this.map.entries()].filter(([k]) => k.startsWith('l|')).map(([, v]) => clone(v as LifetimeState));
  }

  /** Keys written since construction or the last clearDirty(). */
  dirty(): [string, unknown][] {
    return [...this.touched].map((k) => [k, clone(this.map.get(k))]);
  }

  clearDirty() {
    this.touched.clear();
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }
}

/** Write buffer: reads fall through to the store, writes stay local until commit(). Used for dry runs. */
export class Overlay implements StateStore {
  private writes = new Map<string, unknown>();
  constructor(private base: StateStore) {}
  get<T>(key: string): T | undefined {
    return this.writes.has(key) ? clone(this.writes.get(key) as T) : this.base.get<T>(key);
  }
  set(key: string, value: unknown): void {
    this.writes.set(key, clone(value));
  }
  dueWindows(date: string): WindowState[] {
    const base = this.base.dueWindows(date).filter((w) => !this.writes.has(w.key));
    const local = [...this.writes.values()].filter(
      (v): v is WindowState => !!v && typeof v === 'object' && (v as WindowState).key?.startsWith('w|') && (v as WindowState).status === 'OPEN' && (v as WindowState).closeAfter < date,
    );
    return [...base, ...local.map(clone)];
  }
  commit(): void {
    for (const [k, v] of this.writes) this.base.set(k, v);
    this.writes.clear();
  }
}

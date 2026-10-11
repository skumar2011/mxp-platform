import { createHash, randomUUID } from 'node:crypto';

export const uid = (): string => randomUUID();

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Deterministic JSON (sorted keys) so hashes are stable across processes. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    }
    return out;
  }
  return v;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t);
  }
  set(t: Date | string) {
    this.t = new Date(t);
  }
}

export class MxpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// ---------- Money (minor units) --------------------------------------
export const MINOR = 100;

export function toMinor(v: number | string): number {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
  if (!Number.isFinite(n)) throw new MxpError('INVALID_AMOUNT', `Invalid amount: ${v}`);
  return Math.round(n * MINOR);
}

export function fromMinor(n: number): number {
  return n / MINOR;
}

export function fmtInr(minor: number): string {
  const v = minor / MINOR;
  return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@mxp/rules';

export const uid = (): string => randomUUID();
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const hashJson = (v: unknown): string => sha256(canonicalJson(v));

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
  constructor(readonly code: string, message: string, readonly status = 400, readonly details?: unknown) {
    super(message);
  }
}

export interface Actor {
  username: string;
  roles: string[];
}
export const SYSTEM: Actor = { username: 'system', roles: ['SYSTEM_ADMIN'] };

export const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
export const parseJson = <T = unknown>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ---------- passwords and permissions ----------
const N = 16384;
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString('hex')}$${scryptSync(password, salt, 32, { N }).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length, { N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const ROLES = ['RULE_MAKER', 'RULE_APPROVER', 'QA_ENGINEER', 'OPERATIONS', 'AUDITOR', 'SYSTEM_ADMIN'] as const;

/** Maker-checker is enforced by identity: the approver of a version can never be its author. */
export const PERMISSIONS: Record<string, string[]> = {
  'rules:read': [...ROLES],
  'rules:write': ['RULE_MAKER', 'SYSTEM_ADMIN'],
  'templates:write': ['RULE_MAKER', 'SYSTEM_ADMIN'],
  'rules:approve': ['RULE_APPROVER'],
  'rules:activate': ['RULE_MAKER', 'RULE_APPROVER', 'OPERATIONS', 'SYSTEM_ADMIN'],
  'customers:read': [...ROLES],
  'customers:write': ['OPERATIONS', 'QA_ENGINEER', 'SYSTEM_ADMIN'],
  'events:write': ['OPERATIONS', 'QA_ENGINEER', 'SYSTEM_ADMIN'],
  'ops:run': ['OPERATIONS', 'QA_ENGINEER', 'SYSTEM_ADMIN'],
  'tests:write': ['QA_ENGINEER', 'RULE_MAKER', 'SYSTEM_ADMIN'],
  'audit:read': ['AUDITOR', 'SYSTEM_ADMIN', 'RULE_APPROVER'],
  'users:admin': ['SYSTEM_ADMIN'],
};
export const can = (roles: string[], p: string) => !!PERMISSIONS[p]?.some((r) => roles.includes(r));
export const permissionsFor = (roles: string[]) => Object.keys(PERMISSIONS).filter((p) => can(roles, p));

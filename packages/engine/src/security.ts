import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;

/** scrypt password hash: "scrypt$N$salt$hash" (all parameters stored for future upgrades). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length, { N: Number(n) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const ROLES = ['RULE_MAKER', 'RULE_APPROVER', 'QA_ENGINEER', 'OPERATIONS', 'AUDITOR', 'SYSTEM_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** Permission model. SYSTEM_ADMIN manages users and configuration but cannot approve its own rules (maker-checker is by identity). */
export const PERMISSIONS: Record<string, Role[]> = {
  'rules:read': ['RULE_MAKER', 'RULE_APPROVER', 'QA_ENGINEER', 'OPERATIONS', 'AUDITOR', 'SYSTEM_ADMIN'],
  'rules:write': ['RULE_MAKER', 'SYSTEM_ADMIN'],
  'rules:approve': ['RULE_APPROVER'],
  'rules:activate': ['RULE_APPROVER', 'OPERATIONS', 'SYSTEM_ADMIN'],
  'campaigns:write': ['RULE_MAKER', 'SYSTEM_ADMIN'],
  'simulate': ['RULE_MAKER', 'QA_ENGINEER', 'RULE_APPROVER', 'SYSTEM_ADMIN'],
  'testcases:write': ['QA_ENGINEER', 'RULE_MAKER', 'SYSTEM_ADMIN'],
  'ops:read': ['OPERATIONS', 'AUDITOR', 'SYSTEM_ADMIN', 'RULE_APPROVER', 'RULE_MAKER', 'QA_ENGINEER'],
  'ops:write': ['OPERATIONS', 'SYSTEM_ADMIN'],
  'adjust:request': ['OPERATIONS', 'SYSTEM_ADMIN'],
  'adjust:approve': ['RULE_APPROVER'],
  'audit:read': ['AUDITOR', 'SYSTEM_ADMIN', 'RULE_APPROVER'],
  'customers:read': ['OPERATIONS', 'AUDITOR', 'SYSTEM_ADMIN', 'RULE_APPROVER', 'QA_ENGINEER', 'RULE_MAKER'],
  'export': ['OPERATIONS', 'AUDITOR', 'SYSTEM_ADMIN'],
  'users:admin': ['SYSTEM_ADMIN'],
};

export function can(roles: string[], permission: string): boolean {
  const allowed = PERMISSIONS[permission];
  return !!allowed && roles.some((r) => (allowed as string[]).includes(r));
}

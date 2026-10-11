import { describe, expect, it } from 'vitest';
import { FixedClock, MxpError, PERMISSIONS, ROLES, can, canonicalJson, fmtInr, fromMinor, hashPassword, sha256, toMinor, verifyPassword } from '../../src/index';

describe('money', () => {
  it('converts to integer minor units without floating point drift', () => {
    expect(toMinor(10000)).toBe(1_000_000);
    expect(toMinor('9,999.99')).toBe(999_999);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(19.99)).toBe(1999);
    expect(fromMinor(999_999)).toBe(9999.99);
    expect(() => toMinor('abc')).toThrow(MxpError);
    expect(fmtInr(1_234_567)).toBe('₹12,345.67');
  });
});

describe('canonical json and hashing', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(sha256(canonicalJson({ x: 1, y: 2 }))).toBe(sha256(canonicalJson({ y: 2, x: 1 })));
  });
  it('ignores undefined properties', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('passwords', () => {
  it('hashes with a per-user salt and verifies', () => {
    const a = hashPassword('Correct-Horse-9');
    const b = hashPassword('Correct-Horse-9');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('Correct-Horse-9', a)).toBe(true);
    expect(verifyPassword('correct-horse-9', a)).toBe(false);
    expect(verifyPassword('anything', 'plaintext')).toBe(false);
  });
});

describe('RBAC and maker-checker permissions', () => {
  it('only the approver role can approve rules or adjustments', () => {
    for (const r of ROLES) expect(can([r], 'rules:approve')).toBe(r === 'RULE_APPROVER');
    for (const r of ROLES) expect(can([r], 'adjust:approve')).toBe(r === 'RULE_APPROVER');
  });
  it('makers can write rules but not approve them', () => {
    expect(can(['RULE_MAKER'], 'rules:write')).toBe(true);
    expect(can(['RULE_MAKER'], 'rules:approve')).toBe(false);
  });
  it('auditors can read audit and export but not change anything', () => {
    expect(can(['AUDITOR'], 'audit:read')).toBe(true);
    expect(can(['AUDITOR'], 'export')).toBe(true);
    for (const p of ['rules:write', 'rules:approve', 'rules:activate', 'ops:write', 'users:admin', 'simulate']) expect(can(['AUDITOR'], p)).toBe(false);
  });
  it('unknown permissions are denied, and no role is empty', () => {
    expect(can(['SYSTEM_ADMIN'], 'does:not:exist')).toBe(false);
    expect(can([], 'rules:read')).toBe(false);
    for (const [p, roles] of Object.entries(PERMISSIONS)) expect(roles.length, p).toBeGreaterThan(0);
  });
});

describe('FixedClock', () => {
  it('returns copies and can be moved', () => {
    const c = new FixedClock(new Date('2026-10-10T00:00:00Z'));
    const t = c.now();
    t.setFullYear(1999);
    expect(c.now().getUTCFullYear()).toBe(2026);
    c.set('2026-11-01T00:00:00Z');
    expect(c.now().toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

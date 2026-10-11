import { describe, expect, it } from 'vitest';
import { DEMO_PASSWORD, openDb, openSimStore } from '@mxp/engine';
import { loadConfig } from '../src/config';
import { toCsv } from '../src/util';
import { bootstrapProduction } from '../src/bootstrap';
import { buildApp } from '../src/app';
import { cardEvent, makeApp, NOW } from './helpers';

const login = (t: Awaited<ReturnType<typeof makeApp>>, username: string, password: string) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });

describe('authentication', () => {
  it('health and readiness are public; everything else needs a token', async () => {
    const t = await makeApp();
    expect((await t.call('GET', '/api/health')).json.status).toBe('ok');
    expect((await t.call('GET', '/api/ready')).json.status).toBe('ready');
    for (const url of ['/api/rules', '/api/dashboard', '/api/ledger', '/api/audit', '/api/admin/users', '/api/sim/cases']) {
      const r = await t.call('GET', url);
      expect(r.status, url).toBe(401);
      expect(r.json.error.code).toBe('UNAUTHENTICATED');
    }
    const bad = await t.app.inject({ method: 'GET', url: '/api/rules', headers: { authorization: 'Bearer not.a.token' } });
    expect(bad.statusCode).toBe(401);
  });

  it('a token signed with another secret is rejected', async () => {
    const t = await makeApp();
    const other = await makeApp();
    // different random secrets are not guaranteed, so sign explicitly with a wrong one
    const forged = other.app.jwt.sign({ sub: 'admin', name: 'x', roles: ['SYSTEM_ADMIN'] }, { key: 'a-different-secret-a-different-secret' } as any);
    const r = await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: `Bearer ${forged}` } });
    expect(r.statusCode).toBe(401);
  });

  it('login returns a token, the user and their permissions; the password hash is never exposed', async () => {
    const t = await makeApp();
    const r = await login(t, 'maker', DEMO_PASSWORD);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user).toMatchObject({ username: 'maker', roles: ['RULE_MAKER'] });
    expect(body.user.permissions).toContain('rules:write');
    expect(body.user.permissions).not.toContain('rules:approve');
    expect(r.body).not.toMatch(/scrypt/);
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.json().user.username).toBe('maker');
    const users = await t.call('GET', '/api/admin/users', 'admin');
    expect(JSON.stringify(users.json)).not.toMatch(/password|scrypt/i);
  });

  it('gives the same answer for an unknown user and a wrong password, and audits both', async () => {
    const t = await makeApp();
    const a = await login(t, 'nobody', 'Whatever-1234');
    const b = await login(t, 'maker', 'Wrong-password-1');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
    expect(t.db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'LOGIN_FAILED'")).toBe(2);
  });

  it('locks the account after five failed attempts, even for the right password, until an administrator unlocks it', async () => {
    const t = await makeApp({ rateLimitMax: 100000 });
    for (let i = 0; i < 5; i++) expect((await login(t, 'qa', 'Bad-password-1')).statusCode).toBe(401);
    const locked = await login(t, 'qa', DEMO_PASSWORD);
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.code).toBe('LOCKED');
    const unlock = await t.call('PATCH', '/api/admin/users/qa', 'admin', { unlock: true });
    expect(unlock.status).toBe(200);
    expect((await login(t, 'qa', DEMO_PASSWORD)).statusCode).toBe(200);
  });

  it('login is rate limited per client', async () => {
    const t = await makeApp();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login(t, 'nobody', 'x')).statusCode;
    expect(last).toBe(429);
  });

  it('a disabled user cannot sign in', async () => {
    const t = await makeApp();
    expect((await t.call('PATCH', '/api/admin/users/ops', 'admin', { active: false })).status).toBe(200);
    expect((await login(t, 'ops', DEMO_PASSWORD)).statusCode).toBe(401);
  });
});

describe('authorisation matrix', () => {
  const cases: [string, string, string, number][] = [
    // [method, url, user, expected status]
    ['GET', '/api/rules', 'auditor', 200],
    ['GET', '/api/admin/users', 'maker', 403],
    ['GET', '/api/admin/users', 'admin', 200],
    ['POST', '/api/admin/users', 'ops', 403],
    ['GET', '/api/audit', 'maker', 403],
    ['GET', '/api/audit', 'auditor', 200],
    ['GET', '/api/audit/export.csv', 'ops', 403],
    ['GET', '/api/audit/export.csv', 'auditor', 200],
    ['GET', '/api/ledger/export.csv', 'maker', 403],
    ['GET', '/api/ledger/export.csv', 'ops', 200],
    ['POST', '/api/ingest', 'maker', 403],
    ['POST', '/api/ops/process', 'qa', 403],
    ['POST', '/api/ops/process', 'ops', 200],
    ['POST', '/api/ops/reconcile', 'auditor', 403],
    ['POST', '/api/adjustments', 'maker', 403],
    ['GET', '/api/sim/cases', 'auditor', 403],
    ['GET', '/api/sim/cases', 'qa', 200],
    ['POST', '/api/campaigns', 'qa', 403],
    ['PUT', '/api/admin/config', 'maker', 403],
  ];
  for (const [method, url, user, status] of cases) {
    it(`${user} ${method} ${url} -> ${status}`, async () => {
      const t = await makeApp();
      const body = method === 'POST' || method === 'PUT' ? {} : undefined;
      const r = await t.call(method as any, url, user, body);
      if (status === 403) expect(r.status).toBe(403);
      else expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
    });
  }

  it('maker-checker also applies to adjustments: the requester cannot decide', async () => {
    const t = await makeApp();
    const adj = await t.call('POST', '/api/adjustments', 'ops', { customerRef: 'CUST-1001', points: 100, reason: 'Goodwill for a delayed statement' });
    expect(adj.status).toBe(201);
    const id = adj.json.adjustment_id;
    expect((await t.call('POST', `/api/adjustments/${id}/decide`, 'ops', { approve: true })).status).toBe(403);
    expect((await t.call('POST', `/api/adjustments/${id}/decide`, 'checker', { approve: true, note: 'ok' })).json.status).toBe('APPROVED');
    expect((await t.call('GET', '/api/customers/CUST-1001', 'ops')).json.xp.balance).toBe(1150);
  });
});

describe('API keys for source systems', () => {
  it('a key is shown once, stored hashed, bound to one source system, and can be revoked', async () => {
    const t = await makeApp();
    const created = await t.call('POST', '/api/admin/clients', 'admin', { sourceSystem: 'CARDS' });
    expect(created.status).toBe(201);
    const key = created.json.apiKey as string;
    expect(key).toMatch(/^mxp_/);
    expect(t.db.value('SELECT COUNT(*) FROM api_client WHERE key_hash = ?', key)).toBe(0); // only the hash is stored
    expect(JSON.stringify((await t.call('GET', '/api/admin/clients', 'admin')).json)).not.toContain(key);

    const ok = await t.call('POST', '/api/ingest', null, { events: [cardEvent('K-1', 3000, '2026-10-05T10:00:00+05:30')] }, { 'x-api-key': key });
    expect(ok.status).toBe(202);
    expect(ok.json.summary.accepted).toBe(1);

    const wrongSource = await t.call('POST', '/api/ingest', null, { events: [cardEvent('K-2', 3000, '2026-10-05T10:00:00+05:30', {}, 'UPI')] }, { 'x-api-key': key });
    expect(wrongSource.status).toBe(422);
    expect(wrongSource.json.results[0].errors[0].code).toBe('SOURCE_MISMATCH');

    expect((await t.call('POST', '/api/ingest', null, { events: [cardEvent('K-3', 1, '2026-10-05T10:00:00+05:30')] }, { 'x-api-key': 'mxp_wrong' })).status).toBe(401);
    // the key does not open any other endpoint
    expect((await t.call('GET', '/api/rules', null, undefined, { 'x-api-key': key })).status).toBe(401);

    await t.call('DELETE', `/api/admin/clients/${created.json.clientId}`, 'admin');
    expect((await t.call('POST', '/api/ingest', null, { events: [cardEvent('K-4', 1, '2026-10-05T10:00:00+05:30')] }, { 'x-api-key': key })).status).toBe(401);
    expect(t.db.value("SELECT COUNT(*) FROM audit_log WHERE action IN ('API_CLIENT_CREATE','API_CLIENT_REVOKE')")).toBe(2);
  });

  it('ingest validates the request size and shape', async () => {
    const t = await makeApp();
    expect((await t.call('POST', '/api/ingest', 'ops', { events: [] })).status).toBe(422);
    expect((await t.call('POST', '/api/ingest', 'ops', { events: Array.from({ length: 1001 }, () => ({})) })).status).toBe(422);
    const r = await t.call('POST', '/api/ingest', 'ops', { events: [{ nonsense: true }] });
    expect(r.status).toBe(422);
    expect(r.json.summary.rejected).toBe(1);
  });
});

describe('API behaviour', () => {
  it('sends security headers and never caches API responses', async () => {
    const t = await makeApp();
    const r = await t.call('GET', '/api/rules', 'maker');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['strict-transport-security']).toBeUndefined(); // only in production
  });

  it('uses one error shape and does not leak internals', async () => {
    const t = await makeApp();
    const notFound = await t.call('GET', '/api/rules/NOPE', 'maker');
    expect(notFound.status).toBe(404);
    expect(notFound.json).toEqual({ error: { code: 'NOT_FOUND', message: 'Rule NOPE not found.' } });
    const unknown = await t.call('GET', '/api/does-not-exist', 'maker');
    expect(unknown.json.error.code).toBe('NOT_FOUND');
    const invalid = await t.call('POST', '/api/rules', 'maker', { code: 'x' });
    expect(invalid.status).toBe(422);
    expect(invalid.json.error.code).toBe('VALIDATION');
    expect(invalid.json.error.details.length).toBeGreaterThan(0);
    expect(invalid.text).not.toMatch(/at .*\.ts|node_modules|SQLITE/);
  });

  it('SQL metacharacters in filters are treated as data', async () => {
    const t = await makeApp();
    const r = await t.call('GET', `/api/ledger?customerRef=${encodeURIComponent("' OR 1=1 --")}`, 'ops');
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(0);
    const q = await t.call('GET', `/api/customers?q=${encodeURIComponent("%'; DROP TABLE xp_ledger; --")}`, 'ops');
    expect(q.status).toBe(200);
    expect(t.db.value('SELECT COUNT(*) FROM xp_ledger')).toBeGreaterThan(0);
  });

  it('exports are audited and protected against spreadsheet formula injection', async () => {
    const t = await makeApp();
    const r = await t.call('GET', '/api/ledger/export.csv', 'ops');
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.text.split('\n')[0]).toContain('ledgerId,createdAt,customerRef');
    expect(r.text.split('\n').length).toBeGreaterThan(10);
    expect(t.db.get<any>("SELECT actor FROM audit_log WHERE action = 'EXPORT' ORDER BY audit_id DESC")!.actor).toBe('ops');
    expect(toCsv(['a'], [{ a: '=HYPERLINK("http://evil")' }, { a: '+1+1' }, { a: '@SUM(A1)' }, { a: -5 }, { a: 'plain, with comma' }])).toBe(
      `a\n"'=HYPERLINK(""http://evil"")"\n'+1+1\n'@SUM(A1)\n-5\n"plain, with comma"\n`,
    );
  });

  it('password changes enforce the policy and the current password', async () => {
    const t = await makeApp();
    expect((await t.call('POST', '/api/auth/password', 'maker', { current: DEMO_PASSWORD, password: 'short' })).status).toBe(422);
    expect((await t.call('POST', '/api/auth/password', 'maker', { current: DEMO_PASSWORD, password: 'alllowercaseletters' })).status).toBe(422);
    expect((await t.call('POST', '/api/auth/password', 'maker', { current: 'wrong', password: 'New-Passw0rd-123' })).status).toBe(401);
    expect((await t.call('POST', '/api/auth/password', 'maker', { current: DEMO_PASSWORD, password: 'New-Passw0rd-123' })).status).toBe(200);
    expect((await login(t, 'maker', DEMO_PASSWORD)).statusCode).toBe(401);
    expect((await login(t, 'maker', 'New-Passw0rd-123')).statusCode).toBe(200);
  });

  it('administrators cannot lock themselves out', async () => {
    const t = await makeApp();
    expect((await t.call('PATCH', '/api/admin/users/admin', 'admin', { active: false })).status).toBe(409);
    expect((await t.call('PATCH', '/api/admin/users/admin', 'admin', { roles: ['RULE_MAKER'] })).status).toBe(409);
  });

  it('engine configuration changes are validated and audited', async () => {
    const t = await makeApp();
    const cur = (await t.call('GET', '/api/admin/config', 'maker')).json.config;
    expect((await t.call('PUT', '/api/admin/config', 'admin', { ...cur, maxAttempts: 0 })).status).toBe(422);
    expect((await t.call('PUT', '/api/admin/config', 'admin', { ...cur, nudge: { ...cur.nudge, defaultChannel: 'SMS', approvedChannels: ['PUSH'] } })).status).toBe(422);
    expect((await t.call('PUT', '/api/admin/config', 'admin', { ...cur, maxAttempts: 3 })).status).toBe(200);
    expect(t.db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'CONFIG_UPDATE'")).toBe(1);
  });
});

describe('environment configuration', () => {
  it('refuses to start in prod or staging without a strong JWT secret', () => {
    expect(() => loadConfig({ MXP_ENV: 'prod' } as any)).toThrow(/MXP_JWT_SECRET is required/);
    expect(() => loadConfig({ MXP_ENV: 'staging' } as any)).toThrow(/MXP_JWT_SECRET is required/);
    expect(() => loadConfig({ MXP_ENV: 'prod', MXP_JWT_SECRET: 'too-short' } as any)).toThrow(/at least 24/);
    expect(loadConfig({ MXP_ENV: 'prod', MXP_JWT_SECRET: 'x'.repeat(32) } as any)).toMatchObject({ env: 'prod', seedIfEmpty: false, worker: true });
  });
  it('dev is convenient, test and prod are not seeded, and the worker can be split out', () => {
    expect(loadConfig({} as any)).toMatchObject({ env: 'dev', seedIfEmpty: true, port: 4000, host: '127.0.0.1' });
    expect(loadConfig({ MXP_ENV: 'test' } as any).seedIfEmpty).toBe(false);
    expect(loadConfig({ MXP_WORKER: '0' } as any).worker).toBe(false);
  });

  it('a production bootstrap contains reference data and one administrator, and no demo users or data', async () => {
    const db = openDb(':memory:');
    bootstrapProduction(db, { now: () => NOW }, 'Initial-Admin-Passw0rd');
    expect(() => bootstrapProduction(openDb(':memory:'), { now: () => NOW }, 'short')).toThrow(/at least 12/);
    expect(db.all<any>('SELECT username FROM app_user')).toEqual([{ username: 'admin' }]);
    expect(db.value('SELECT COUNT(*) FROM customer')).toBe(0);
    expect(db.value('SELECT COUNT(*) FROM rule')).toBe(0);
    expect(db.value('SELECT COUNT(*) FROM channel_ref')).toBeGreaterThan(0);
    const { app } = await buildApp({ db, sim: openSimStore(':memory:'), cfg: { env: 'prod', worker: false, jwtSecret: 'p'.repeat(32), webDist: '/nonexistent' } });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'Initial-Admin-Passw0rd' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['strict-transport-security']).toContain('max-age');
    const demo = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'maker', password: DEMO_PASSWORD } });
    expect(demo.statusCode).toBe(401);
  });
});

describe('static web apps', () => {
  it('serves both built apps with the right cache headers (regression: @fastify/static setHeaders)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dist = mkdtempSync(join(tmpdir(), 'mxp-web-'));
    mkdirSync(join(dist, 'assets')); mkdirSync(join(dist, 'testing'));
    writeFileSync(join(dist, 'index.html'), '<html>admin</html>');
    writeFileSync(join(dist, 'testing', 'index.html'), '<html>testing</html>');
    writeFileSync(join(dist, 'assets', 'app-abc.js'), 'console.log(1)');
    const { app } = await buildApp({ db: openDb(':memory:'), sim: openSimStore(':memory:'), cfg: { env: 'test', worker: false, jwtSecret: 'x'.repeat(32), webDist: dist } });
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('admin');
    expect(root.headers['cache-control']).toBe('no-cache');
    expect((await app.inject({ method: 'GET', url: '/rules/anything' })).body).toContain('admin'); // SPA fallback
    expect((await app.inject({ method: 'GET', url: '/testing/' })).body).toContain('testing');
    expect((await app.inject({ method: 'GET', url: '/testing/matrix' })).body).toContain('testing');
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });
});

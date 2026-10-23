import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FixedClock, Mxp, seed } from '@mxp/platform';
import { buildApp } from '../src/app';

let app: FastifyInstance;
const tokens: Record<string, string> = {};

const call = async (user: string | null, method: string, url: string, body?: unknown) => {
  const r = await app.inject({ method: method as any, url: `/api${url}`, payload: body as any, headers: user ? { authorization: `Bearer ${tokens[user]}` } : {} });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

beforeAll(async () => {
  const mx = Mxp.open(':memory:', new FixedClock(new Date('2026-10-14T06:30:00.000Z')));
  seed(mx);
  ({ app } = await buildApp({ mx, cfg: { env: 'test', jwtSecret: 'test-secret-test-secret-123', webDist: '/nonexistent', rateLimitMax: 10000 }, logger: false }));
  for (const u of ['maker', 'checker', 'qa', 'ops', 'auditor']) {
    const r = await call(null, 'POST', '/auth/login', { username: u, password: 'Mxp@Demo1' });
    tokens[u] = r.body.token;
  }
});
afterAll(() => app.close());

describe('API', () => {
  it('requires authentication and rejects bad passwords', async () => {
    expect((await call(null, 'GET', '/rules')).status).toBe(401);
    expect((await call(null, 'POST', '/auth/login', { username: 'maker', password: 'nope' })).status).toBe(401);
    expect((await call(null, 'GET', '/health')).body.env).toBe('test');
  });

  it('serves the catalogue, segment comparison and the current pack', async () => {
    const t = await call('auditor', 'GET', '/templates');
    expect(t.body).toHaveLength(16);
    const seg = await call('auditor', 'GET', '/segments/overview');
    const mass = seg.body.find((s: any) => s.segment_code === 'MASS');
    const aff = seg.body.find((s: any) => s.segment_code === 'AFFLUENT');
    expect(mass.controls.find((c: any) => c.code === 'DSL_MASS').customerParams.limit.default).toBe(3000);
    expect(aff.controls.find((c: any) => c.code === 'DSL_AFFLUENT').customerParams.limit.default).toBe(200000);
    expect(mass.missions.find((m: any) => m.featured).code).toBe('UPI_STREAK_MASS');
    expect(aff.missions.find((m: any) => m.featured).code).toBe('RD_STREAK_AFFLUENT');
    const pack = await call('auditor', 'GET', '/packs/current');
    expect(pack.body.kind).toBe('RulePack');
    expect((await call('auditor', 'POST', '/packs/validate', { pack: pack.body })).body.ok).toBe(true);
  });

  it('creates a draft and activates it (simplified lifecycle)', async () => {
    const tpl = (await call('maker', 'GET', '/templates/DAILY_SPEND_LIMIT')).body.definition;
    const rule = {
      kind: 'Rule', code: 'DSL_SENIOR', template: 'DAILY_SPEND_LIMIT', name: 'Daily spend limit (Senior)', segments: ['SENIOR'],
      params: { channels: ['CARD_POS', 'UPI'], action: 'ALERT', warnAtPct: 80, points: 10, minActivity: 1 }, customerParams: { limit: { min: 500, max: 20000, step: 500, default: 5000 } },
    };
    expect(tpl.code).toBe('DAILY_SPEND_LIMIT');
    expect((await call('maker', 'POST', '/rules/validate', { rule })).body.ok).toBe(true);
    expect((await call('auditor', 'POST', '/rules', { rule })).status).toBe(403);
    const d = await call('maker', 'POST', '/rules', { rule });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('DRAFT');
    expect((await call('maker', 'POST', '/rules/DSL_SENIOR/versions/1/activate')).body.status).toBe('ACTIVE');
    const offers = (await call('ops', 'GET', '/customers/C1006/offers')).body;
    expect(offers.some((o: any) => o.code === 'DSL_SENIOR')).toBe(true);
  });

  it('lets a customer set a control, then checks and processes events', async () => {
    const s = await call('ops', 'PUT', '/customers/C1006/controls/DSL_SENIOR', { values: { limit: 2000 } });
    expect(s.status).toBe(200);
    expect((await call('ops', 'PUT', '/customers/C1006/controls/DSL_SENIOR', { values: { limit: 100000 } })).status).toBe(422);
    const ev = { customerId: 'C1006', accountId: 'C1006-SA', type: 'TRANSACTION', timestamp: '2026-10-14T05:00:00.000Z', amount: 2500, dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', category: 'HEALTH', product_family: 'SAVINGS' };
    const chk = await call('ops', 'POST', '/controls/check', ev);
    expect(chk.body.decision).toBe('ALERT');
    const r = await call('ops', 'POST', '/events', { ...ev, sourceSystem: 'TEST', sourceEventId: 'api-1' });
    expect(r.body.status).toBe('PROCESSED');
    expect(r.body.evaluations.find((e: any) => e.ruleCode === 'DSL_SENIOR').outcome).toBe('BREACH');
    expect((await call('auditor', 'GET', '/breaches?customerId=C1006')).body.length).toBeGreaterThan(0);
  });

  it('stores test scenarios and runs', async () => {
    const list = (await call('qa', 'GET', '/test-scenarios')).body;
    expect(list.length).toBeGreaterThan(5);
    const run = await call('qa', 'POST', '/test-runs', { kind: 'SUITE', packSource: 'CURRENT', passed: 1, failed: 0, results: [{ scenarioId: list[0].scenario_id, passed: true }] });
    expect(run.body.runId).toBeTruthy();
  });

  it('exposes the audit trail to auditors only', async () => {
    expect((await call('ops', 'GET', '/audit')).status).toBe(403);
    expect((await call('auditor', 'GET', '/audit/verify')).body.ok).toBe(true);
  });
});

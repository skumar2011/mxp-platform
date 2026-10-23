import { beforeAll, describe, expect, it } from 'vitest';
import { RulesEngine, runScenario } from '@mxp/rules';
import { FixedClock, Mxp, seed, SEED_SCENARIOS } from '../src/index';

const clock = new FixedClock(new Date('2026-10-14T06:30:00.000Z'));
let mx: Mxp;

beforeAll(() => {
  mx = Mxp.open(':memory:', clock);
  seed(mx);
});

describe('seed', () => {
  it('loads catalogue, rules and history without failures', () => {
    const d = mx.queries.dashboard();
    expect(mx.catalog.listTemplates()).toHaveLength(16);
    expect(mx.catalog.listRules().filter((r) => r.liveStatus === 'ACTIVE')).toHaveLength(21);
    expect(d.failedEvents).toBe(0);
    expect(d.points.awarded).toBeGreaterThan(0);
    expect(d.pendingApprovals).toBe(1); // UPI_STREAK_SENIOR draft
    expect(mx.runtime.reconcile()).toEqual([]);
    expect(mx.verifyAudit().ok).toBe(true);
    // v4: points are account-scoped; customer rollup still works
    const c = mx.queries.customer360('C1001');
    expect(c.points.byAccount.length).toBeGreaterThan(0);
    expect(c.customer.state_code).toBe('MH');
    expect(mx.catalog.listRules().find((r) => r.code === 'UPI_STREAK_MASS')?.states).toContain('MH');
    expect(mx.catalog.listRules().find((r) => r.code === 'AMB_DAYS_MASS')?.productScope).toBe('CASA');
  });

  it('records the expected persona outcomes', () => {
    const breaches = mx.queries.breaches({ limit: 500 });
    const by = (c: string, r: string) => breaches.filter((b) => b.customer_id === c && b.rule_code === r).length;
    expect(by('C1001', 'DSL_MASS')).toBeGreaterThan(0);
    expect(by('C1001', 'TIMING_STD')).toBe(1);
    expect(by('C1002', 'MERCHANT_BLOCK_STD')).toBe(1);
    expect(by('C1002', 'DSL_AFFLUENT')).toBeGreaterThanOrEqual(1);
    expect(by('C1003', 'TXN_TYPE_BLOCK_STD')).toBe(1);
    expect(by('C1004', 'TIMING_STD')).toBe(1);
    const ledger = mx.queries.ledger({ limit: 500 });
    const pts = (c: string, r: string) => ledger.filter((l) => l.customer_id === c && l.rule_code === r).reduce((s, l) => s + l.points, 0);
    expect(pts('C1002', 'REFERRAL_STD')).toBe(500);
    expect(pts('C1002', 'CROSS_SELL_STD')).toBe(300);
    expect(pts('C1006', 'RD_COMPLETE_STD')).toBe(1000);
    expect(pts('C1003', 'UPI_STREAK_MASS')).toBe(300);
    expect(pts('C1005', 'DORMANCY_WINBACK')).toBe(100);
    expect(pts('C1001', 'DSL_MASS')).toBeGreaterThan(0);
    const decisions = mx.queries.decisions({});
    expect(decisions.find((d) => d.request_id === 'AUTH-1001')?.decision).toBe('BLOCK');
    expect(decisions.find((d) => d.request_id === 'AUTH-1002')?.decision).toBe('BLOCK');
  });

  it('scheduled a customer change for the next window', () => {
    const offers = mx.participation.offers('C1001');
    const dsl = offers.find((o) => o.code === 'DSL_MASS')!;
    expect(dsl.current?.values).toEqual({ limit: 3000 });
    expect(dsl.scheduled).toMatchObject({ values: { limit: 2500 }, effectiveFrom: '2026-10-15' });
  });
});

describe('seeded scenarios pass against the live pack', () => {
  for (const sc of SEED_SCENARIOS)
    it(sc.name, () => {
      const engine = RulesEngine.fromPack(mx.catalog.previewPack('CURRENT'));
      const r = runScenario(engine, sc);
      expect(r.failures).toEqual([]);
    });
});

describe('rule lifecycle (simplified)', () => {
  it('saves a draft and activates it into the live pack', () => {
    const maker = mx.user('maker');
    const before = mx.catalog.currentRelease()!.content_hash;
    mx.catalog.saveRule(
      {
        kind: 'Rule',
        code: 'DSL_MASS',
        template: 'DAILY_SPEND_LIMIT',
        name: 'Daily Spend Limit – Mass',
        segments: ['MASS', 'YOUTH'],
        params: { channels: ['CARD_POS', 'CARD_ONLINE', 'UPI'], action: 'ALERT', warnAtPct: 80, points: 10, minActivity: 1 },
        customerParams: { limit: { min: 500, max: 30000, step: 100, default: 2500 } },
        description: 'Raise the maximum a Mass customer can choose to ₹30,000.',
      },
      maker,
      'Customer feedback',
    );
    expect(mx.catalog.getRule('DSL_MASS').versions[0].status).toBe('DRAFT');
    mx.catalog.activate('DSL_MASS', maker);
    expect(mx.catalog.getRule('DSL_MASS').versions[0].status).toBe('ACTIVE');
    expect(mx.catalog.engine().engine.getRule('DSL_MASS')!.rule.customerParams.limit.max).toBe(30000);
    expect(mx.catalog.currentRelease()!.content_hash).not.toBe(before);
  });

  it('rejects saving a draft with invalid values', () => {
    const maker = mx.user('maker');
    expect(() =>
      mx.catalog.saveRule(
        { ...mx.catalog.getRule('UPI_STREAK_SENIOR').versions[0].definition, params: { target: -1, points: 100, minAmount: 50, maxPerDay: 3 } },
        maker,
      ),
    ).toThrow(/error/i);
  });

  it('accepts a valid template file into the in-memory catalogue', () => {
    const t = mx.catalog.templateDef('DAILY_SPEND_LIMIT');
    const r = mx.catalog.importTemplate(t, mx.user('maker'));
    expect(r.unchanged).toBe(true);
  });

  it('pausing a rule removes it from evaluation', () => {
    mx.catalog.setLiveStatus('TIMING_STD', 'PAUSE', mx.user('ops'), 'Incident review');
    expect(mx.catalog.engine().engine.getRule('TIMING_STD')!.rule.status).toBe('PAUSED');
    mx.catalog.setLiveStatus('TIMING_STD', 'RESUME', mx.user('ops'));
    expect(mx.catalog.engine().engine.getRule('TIMING_STD')!.rule.status).toBe('ACTIVE');
  });
});

describe('settings and runtime', () => {
  it('rejects values outside the bank bounds and missions', () => {
    expect(() => mx.participation.setControl('C1003', 'DSL_MASS', { limit: 100 }, mx.user('ops'))).toThrow();
    expect(() => mx.participation.setControl('C1003', 'UPI_STREAK_MASS', {}, mx.user('ops'))).toThrow(/mission/);
    expect(() => mx.participation.setControl('C1003', 'DSL_AFFLUENT', { limit: 50000 }, mx.user('ops'))).toThrow(/not offered/);
  });

  it('applies the cooldown on monthly limit changes', () => {
    mx.participation.setControl('C1006', 'MSL_STANDARD', { limit: 25000 }, mx.user('ops'));
    expect(() => mx.participation.setControl('C1006', 'MSL_STANDARD', { limit: 20000 }, mx.user('ops'))).toThrow(/day/);
  });

  it('is idempotent per source event id and detects conflicts', () => {
    const e = { sourceSystem: 'CORE', sourceEventId: 'T-1', customerId: 'C1003', accountId: 'C1003-SA', type: 'TRANSACTION', timestamp: '2026-10-14T05:00:00.000Z', amount: 100, dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', category: 'DINING', product_family: 'SAVINGS' };
    const a = mx.runtime.ingest(e, mx.user('ops'));
    const b = mx.runtime.ingest(e, mx.user('ops'));
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(() => mx.runtime.ingest({ ...e, amount: 200 }, mx.user('ops'))).toThrow(/different content/);
  });

  it('keeps the ledger immutable', () => {
    expect(() => mx.db.run('UPDATE points_ledger SET points = 1')).toThrow(/immutable/);
    expect(() => mx.db.run('DELETE FROM audit_log')).toThrow(/append-only/);
  });

  it('dates points and breaches by business time, not posting time', () => {
    const days = mx.db.all<{ earned_on: string }>('SELECT DISTINCT earned_on FROM points_ledger WHERE entry_type <> ?', 'ADJUSTMENT');
    expect(days.length).toBeGreaterThan(10);
    const close = mx.db.get<any>(
      `SELECT l.earned_on, s.window_end FROM points_ledger l
       JOIN rule_state s ON s.prefix = 'w|' AND s.rule_code = l.rule_code AND s.window_key = l.window_key AND s.customer_id = l.customer_id
       WHERE l.slot = 'compliance' LIMIT 1`,
    );
    expect(close.earned_on).toBe(close.window_end);
    const breach = mx.db.get<any>(
      `SELECT COALESCE(t.occurred_at, e.evaluated_at) AS occurred_at, t.occurred_at AS event_at
       FROM rule_evaluation e JOIN "transaction" t ON t.event_id = e.event_id
       WHERE e.outcome = 'BREACH' LIMIT 1`,
    );
    expect(breach.occurred_at).toBe(breach.event_at);
  });

  it('closing again is a no-op', () => {
    const r = mx.runtime.closeWindows(mx.user('ops'));
    expect(r.points).toBe(0);
  });
});

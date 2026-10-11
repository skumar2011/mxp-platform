import { beforeEach, describe, expect, it } from 'vitest';
import { runScenario, type DbRuleSource, type RuleDefinitionInput, type SimInput, type SimScenario, type SimStep, type SimTxnStep } from '../../src/index';
import { rulesOnlyDb } from '../helpers';
import type { Db } from '../../src/index';

/**
 * Reward policy tests: tier modes, caps, budgets, frequency, conflict groups, balance gap policy and order independence.
 * Definitions are variations of the shipped sample rules, supplied inline so nothing in the rule store is touched.
 */
let source: DbRuleSource;
let db: Db;
beforeEach(() => {
  const env = rulesOnlyDb();
  source = env.source;
  db = env.db;
});

const TZ = 'Asia/Kolkata';
const baseDef = (code: string): any => structuredClone(source.rule(code)!.def);
const card = (id: string, at: string, amount: number, extra: Partial<SimTxnStep> = {}): SimTxnStep => ({
  kind: 'TXN', id, at, type: 'PURCHASE', channel: 'CARD_ONLINE', amount, accountRef: 'CC-1', category: 'SHOPPING', ...extra,
});
const scenario = (steps: SimStep[], over: Partial<SimScenario> = {}): SimScenario => ({
  timezone: TZ,
  customer: { status: 'ACTIVE', kycStatus: 'FULL', nudgeConsent: true },
  accounts: [{ ref: 'CC-1', productCode: 'CC_GOLD' }, { ref: 'SA-1', productCode: 'SAV_REGULAR', openedOn: '2020-01-01' }],
  steps,
  asOf: '2026-10-10',
  ...over,
});
const runDefs = (defs: Record<string, any>, sc: SimScenario, expected?: SimInput['expected']) => {
  const res = runScenario(source, { rules: Object.entries(defs).map(([ruleCode, definition]) => ({ ruleCode, definition })), scenario: sc, expected });
  expect(res.error, JSON.stringify(res.error)).toBeUndefined();
  expect(res.ok).toBe(true);
  if (expected) expect(res.checks.filter((c) => !c.pass), JSON.stringify(res.checks.filter((c) => !c.pass))).toEqual([]);
  return res;
};
const cardRule = (over: Partial<RuleDefinitionInput> = {}) => ({ ...baseDef('CARD_SPEND_10K'), ...over });

describe('tiers', () => {
  const steps = [card('a', '2026-10-02', 26000)];
  it('CUMULATIVE pays every tier reached', () => {
    runDefs({ T: cardRule() }, scenario(steps), { totalPoints: 700, awards: 2 });
  });
  it('HIGHEST_ONLY pays only the best tier and upgrades without double paying', () => {
    const def = cardRule({ tierMode: 'HIGHEST_ONLY' });
    runDefs({ T: def }, scenario(steps), { totalPoints: 400 });
    // reaching tier 1 first and tier 2 later nets to the tier 2 value, not the sum
    const res = runDefs({ T: def }, scenario([card('a', '2026-10-02', 12000), card('b', '2026-10-03', 14000)]), { totalPoints: 400, noDuplicateAwards: true });
    expect(res.final!.reversals).toBeGreaterThanOrEqual(0);
  });
  it('the greater-than operator needs the metric to exceed the threshold', () => {
    const def = cardRule({ metric: { type: 'SUM', operator: 'GT' } });
    runDefs({ T: def }, scenario([card('a', '2026-10-02', 10000)]), { totalPoints: 0 });
    runDefs({ T: def }, scenario([card('a', '2026-10-02', 10001)]), { totalPoints: 300 });
  });
});

describe('caps, budgets and frequency', () => {
  it('a per-period cap trims the reward instead of dropping it', () => {
    const res = runDefs({ T: cardRule({ limits: { frequency: 'RECURRING', capPointsPerPeriod: 500 } as any }) }, scenario([card('a', '2026-10-02', 26000)]), { totalPoints: 500 });
    expect(res.final!.ledger.reduce((a, l) => a + l.points, 0)).toBe(500);
    const ev = res.steps.flatMap((s) => s.evaluations);
    expect(ev.some((e) => e.reasonCode?.includes('CAP') || e.outcome === 'CAPPED')).toBe(true);
  });

  it('a lifetime cap spans periods', () => {
    const def = cardRule({ limits: { frequency: 'RECURRING', capPointsLifetime: 500 } as any });
    runDefs({ T: def }, scenario([card('a', '2026-08-05', 11000), card('b', '2026-09-05', 11000), card('c', '2026-10-05', 11000)]), { totalPoints: 500 });
  });

  it('frequency ONCE rewards a single period only', () => {
    const def = cardRule({ limits: { frequency: 'ONCE' } as any });
    runDefs({ T: def }, scenario([card('a', '2026-08-05', 11000), card('b', '2026-09-05', 11000), card('c', '2026-10-05', 11000)]), { totalPoints: 300 });
  });

  it('maxOccurrences limits how many periods are rewarded', () => {
    const def = cardRule({ limits: { frequency: 'RECURRING', maxOccurrences: 2 } as any });
    runDefs({ T: def }, scenario([card('a', '2026-08-05', 11000), card('b', '2026-09-05', 11000), card('c', '2026-10-05', 11000)]), { totalPoints: 600 });
  });

  it('the campaign budget stops rewards when it is exhausted', () => {
    db.run("UPDATE campaign SET points_budget = 500 WHERE campaign_code = 'MXP_ALWAYS_ON'");
    const res = runDefs({ T: cardRule() }, scenario([card('a', '2026-10-02', 26000)]));
    expect(res.final!.totalPoints).toBeLessThanOrEqual(500);
    expect(res.final!.totalPoints).toBeGreaterThan(0);
  });
});

describe('conflict groups', () => {
  let rich: any;
  let plain: any;
  beforeEach(() => {
    rich = cardRule({ name: 'Rich card goal', tiers: [{ label: 't', threshold: 10000, points: 500 }], conflict: { group: 'CARD_PROMO', policy: 'EXCLUSIVE_HIGHEST_POINTS' } as any });
    plain = cardRule({ name: 'Plain card goal', tiers: [{ label: 't', threshold: 10000, points: 200 }], conflict: { group: 'CARD_PROMO', policy: 'EXCLUSIVE_HIGHEST_POINTS' } as any });
  });
  const steps = [card('a', '2026-10-02', 11000)];

  it('EXCLUSIVE_HIGHEST_POINTS rewards only the richest rule in the group', () => {
    const res = runDefs({ RICH: rich, PLAIN: plain }, scenario(steps), { pointsByRule: { RICH: 500, PLAIN: 0 }, totalPoints: 500 });
    const blocked = res.steps.flatMap((s) => s.evaluations).find((e) => e.ruleCode === 'PLAIN' && e.outcome === 'SUPPRESSED');
    expect(blocked?.reasonText).toMatch(/Exclusive group "CARD_PROMO"/);
  });

  it('EXCLUSIVE_PRIORITY rewards the rule with the higher priority number, whatever it pays', () => {
    const a = { ...rich, conflict: { group: 'G', policy: 'EXCLUSIVE_PRIORITY' }, priority: 100 };
    const b = { ...plain, conflict: { group: 'G', policy: 'EXCLUSIVE_PRIORITY' }, priority: 300 };
    runDefs({ A: a, B: b }, scenario(steps), { pointsByRule: { A: 0, B: 200 } });
  });

  it('a cumulative rule is never held back by another rule', () => {
    runDefs({ RICH: { ...rich, conflict: { group: null, policy: 'CUMULATIVE' } }, PLAIN: { ...plain, conflict: { group: null, policy: 'CUMULATIVE' } } }, scenario(steps), { totalPoints: 700 });
  });
});

describe('balance gap policy', () => {
  const sav = () => baseDef('SAV_AVG_BAL_50K');
  const balances: SimStep[] = [
    { kind: 'BALANCE', account: 'SA-1', date: '2026-09-01', toDate: '2026-09-10', balance: 60000 },
    // 11 - 14 September missing
    { kind: 'BALANCE', account: 'SA-1', date: '2026-09-15', toDate: '2026-09-30', balance: 60000 },
  ];
  it('without carry-forward a missing day means DATA_UNAVAILABLE and no reward', () => {
    const res = runDefs({ S: sav() }, scenario(balances), { totalPoints: 0 });
    const status = res.final!.progress.find((p) => p.periodKey.includes('2026-09'))?.status;
    expect(status).toBe('DATA_UNAVAILABLE');
  });
  it('with carry-forward the last known balance fills the gap and the reward is paid', () => {
    runDefs({ S: { ...sav(), balancePolicy: { gapFill: 'CARRY_FORWARD' } } }, scenario(balances), { totalPoints: 500 });
  });
});

describe('order independence', () => {
  const rule = () => ({ T: cardRule() });
  const base: SimTxnStep[] = [card('a', '2026-10-02', 4000), card('b', '2026-10-04', 4000), card('c', '2026-10-06', 4000), card('d', '2026-10-08', 4000)];

  it('delivering the same transactions in any order yields the same reward', () => {
    const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]];
    const totals = orders.map((o) => runDefs(rule(), scenario(o.map((i) => base[i]))).final!.totalPoints);
    expect(new Set(totals)).toEqual(new Set([300]));
  });

  it('a duplicate delivered at every step changes nothing', () => {
    const noisy = base.map((s) => ({ ...s, repeat: 2, resendAs: 1 }));
    const res = runDefs(rule(), scenario(noisy), { totalPoints: 300, noDuplicateAwards: true });
    expect(res.final!.duplicateAwards).toBe(0);
  });
});

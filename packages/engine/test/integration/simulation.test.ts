import { describe, expect, it } from 'vitest';
import {
  DbRuleSource, cloneCase, generateMatrix, getRun, getSuiteRun, listCases, listRuns, openSimStore, previewForCustomer, runAndRecord, runCase, runPerformance,
  runScenario, runSuite, saveCase, saveMatrix, scenarioFromCustomer, archiveCase, type SimInput, type SimScenario,
} from '../../src/index';
import { rulesOnlyDb, seededDb } from '../helpers';

const PROD_TABLES = ['txn_master', 'xp_ledger', 'goal_progress', 'goal_contribution', 'ingestion_event', 'nudge', 'customer', 'account', 'rule_version', 'audit_log', 'xp_account'];
const counts = (db: ReturnType<typeof seededDb>) => Object.fromEntries(PROD_TABLES.map((t) => [t, db.value<number>(`SELECT COUNT(*) FROM ${t}`)]));

const scenario = (amount: number): SimScenario => ({
  timezone: 'Asia/Kolkata',
  customer: { status: 'ACTIVE', kycStatus: 'FULL' },
  accounts: [{ ref: 'CC-1', productCode: 'CC_GOLD' }],
  steps: [{ kind: 'TXN', id: 't1', at: '2026-10-02', type: 'PURCHASE', channel: 'CARD_ONLINE', amount, accountRef: 'CC-1', category: 'SHOPPING' }],
  asOf: '2026-10-10',
});

describe('production isolation', () => {
  it('simulations, matrices, performance runs and previews never write to the production database', () => {
    const db = seededDb();
    const source = new DbRuleSource(db);
    const before = counts(db);
    runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: scenario(20000), includeActive: true });
    for (const code of ['CARD_SPEND_10K', 'SAV_AVG_BAL_50K', 'BALANCE_PLUS_CARD']) {
      for (const c of generateMatrix(source, { ruleCode: code }).cases) runScenario(source, { rules: c.rules, scenario: c.scenario, expected: c.expected });
    }
    runPerformance(source, { rule: { ruleCode: 'UPI_10_TXNS' }, customers: 20, txnsPerCustomer: 12, duplicateRatio: 0.2 });
    previewForCustomer(db, source, { ruleCode: 'CARD_SPEND_10K' }, 'CUST-1001', { fromDate: '2026-08-15', toDate: '2026-10-10' });
    expect(counts(db)).toEqual(before);
  });

  it('a simulation with the same customer reference as a real customer does not touch the real one', () => {
    const db = seededDb();
    const source = new DbRuleSource(db);
    const before = counts(db);
    const sc = scenario(30000);
    sc.customer = { ref: 'CUST-1001', status: 'ACTIVE' };
    const res = runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: sc });
    expect(res.ok).toBe(true);
    expect(res.final!.totalPoints).toBe(700); // both tiers: 300 + 400
    expect(counts(db)).toEqual(before);
  });

  it('the simulator can test an unsaved draft definition without storing it', () => {
    const db = seededDb();
    const source = new DbRuleSource(db);
    const live = source.rule('CARD_SPEND_10K')!.def;
    const draft = { ...live, tiers: [{ label: 'low', threshold: 1000, points: 77 }] };
    const res = runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K', definition: draft }], scenario: scenario(1500), expected: { totalPoints: 77 } });
    expect(res.passed, JSON.stringify(res.checks)).toBe(true);
    expect(res.rules[0].draft).toBe(true);
    expect(db.value("SELECT COUNT(*) FROM rule_version WHERE name LIKE '%low%'")).toBe(0);
  });

  it('reports an invalid rule definition instead of running it', () => {
    const { source } = rulesOnlyDb();
    const bad = { ...source.rule('CARD_SPEND_10K')!.def, tiers: [] };
    const res = runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K', definition: bad }], scenario: scenario(100) });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBeTruthy();
  });

  it('reports unknown rules and products clearly', () => {
    const { source } = rulesOnlyDb();
    expect(runScenario(source, { rules: [{ ruleCode: 'NOPE' }], scenario: scenario(1) }).error!.code).toBe('RULE_NOT_FOUND');
    const sc = scenario(1);
    sc.accounts[0].productCode = 'MADE_UP';
    expect(runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: sc }).error!.code).toBe('UNKNOWN_PRODUCT');
  });
});

describe('result detail for reviewers', () => {
  it('explains each decision: per-condition results, progress before and after, and the XP', () => {
    const { source } = rulesOnlyDb();
    const res = runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: scenario(12000), expected: { totalPoints: 300, awards: 1 } });
    const step = res.steps[0];
    expect(step.progressBefore).toEqual([]);
    expect(step.progressAfter[0]).toMatchObject({ ruleCode: 'CARD_SPEND_10K', amount: 12000, achievedTier: 1 });
    expect(step.ledger[0]).toMatchObject({ type: 'AWARD', points: 300 });
    const ev = step.evaluations[0];
    expect(ev).toMatchObject({ ruleCode: 'CARD_SPEND_10K', eligible: true });
    expect(JSON.stringify(ev.trace)).toContain('txn.instrument_type');
    expect(res.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['Total XP']));
    expect(res.checks.every((c) => c.pass)).toBe(true);
  });

  it('shows expected versus actual when a check fails', () => {
    const { source } = rulesOnlyDb();
    const res = runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: scenario(12000), expected: { totalPoints: 999 } });
    expect(res.passed).toBe(false);
    expect(res.checks.find((c) => !c.pass)).toMatchObject({ expected: '999', actual: '300' });
  });
});

describe('real-customer preview', () => {
  it('replays production history in the sandbox and reaches the same rewards production did', () => {
    const db = seededDb();
    const source = new DbRuleSource(db);
    for (const [cust, rule] of [['CUST-1001', 'CARD_SPEND_10K'], ['CUST-1004', 'CARD_SPEND_10K'], ['CUST-1001', 'UPI_10_TXNS'], ['CUST-1002', 'CARD_SPEND_10K'], ['CUST-1003', 'UTILITY_3_BILLS']]) {
      const res = previewForCustomer(db, source, { ruleCode: rule }, cust, { fromDate: '2026-08-15', toDate: '2026-10-10' });
      expect(res.ok, `${cust}/${rule}: ${JSON.stringify(res.error)}`).toBe(true);
      const prod = db.value<number>(
        `SELECT COALESCE(SUM(l.points),0) FROM xp_ledger l JOIN customer c USING(customer_id) JOIN rule r USING(rule_id) WHERE c.customer_ref = ? AND r.rule_code = ?`, cust, rule,
      )!;
      expect(res.final!.pointsByRule[rule] ?? 0, `${cust}/${rule}`).toBe(prod);
    }
  });

  it('can preview a different (draft) definition against real history', () => {
    const db = seededDb();
    const source = new DbRuleSource(db);
    const draft = { ...source.rule('CARD_SPEND_10K')!.def, tiers: [{ label: '₹5K', threshold: 5000, points: 50 }] };
    const res = previewForCustomer(db, source, { ruleCode: 'CARD_SPEND_10K', definition: draft }, 'CUST-1002', { fromDate: '2026-08-15', toDate: '2026-10-10' });
    expect(res.final!.totalPoints).toBe(50); // CUST-1002 spent ₹9,999 this month: now qualifies
  });

  it('limits the amount of history it will replay', () => {
    const db = seededDb();
    expect(() => scenarioFromCustomer(db, 'CUST-1001', { fromDate: '2026-08-15', toDate: '2026-10-10', maxSteps: 10 })).toThrow(/narrow the date range/);
    expect(() => scenarioFromCustomer(db, 'NOPE')).toThrow(/not found/);
  });
});

describe('test case library, suites and run history', () => {
  const setup = () => {
    const db = seededDb();
    const source = new DbRuleSource(db);
    const store = openSimStore(':memory:');
    return { db, source, store };
  };

  it('generates, saves, and re-saves a matrix without duplicating cases', () => {
    const { source, store } = setup();
    const m = generateMatrix(source, { ruleCode: 'UPI_10_TXNS' });
    expect(m.cases.length).toBeGreaterThan(10);
    const a = saveMatrix(store, 'qa', m);
    const b = saveMatrix(store, 'qa', m);
    expect(b.map((c) => c.caseId)).toEqual(a.map((c) => c.caseId));
    expect(listCases(store, { ruleCode: 'UPI_10_TXNS' })).toHaveLength(m.cases.length);
  });

  it('covers the required categories for a goal rule', () => {
    const { source } = setup();
    const cats = new Set(generateMatrix(source, { ruleCode: 'CARD_SPEND_10K' }).cases.map((c) => c.category));
    for (const c of ['POSITIVE', 'NEGATIVE', 'BOUNDARY', 'DUPLICATE', 'REVERSAL', 'REFUND', 'ELIGIBILITY']) expect(cats.has(c as any), c).toBe(true);
  });

  it('runs a whole suite, keeps every run, and a regression is visible when a rule changes', () => {
    const { db, source, store } = setup();
    saveMatrix(store, 'qa', generateMatrix(source, { ruleCode: 'CARD_SPEND_10K' }));
    const first = runSuite(source, store, 'qa', { ruleCode: 'CARD_SPEND_10K' }, 'LIVE', 'baseline');
    expect(first.failed + first.errors).toBe(0);
    expect(first.passed).toBe(first.total);
    expect(getSuiteRun(store, first.suiteRunId)!.runs).toHaveLength(first.total);

    // Someone changes the live rule's tier points behind the test library's back (simulated at the source level).
    const changed = { ...source.rule('CARD_SPEND_10K')!, def: { ...source.rule('CARD_SPEND_10K')!.def, tiers: [{ label: 'x', threshold: 10000, points: 1 }, { label: 'y', threshold: 25000, points: 2 }] } };
    const patched = Object.assign(Object.create(source), { rule: () => changed, activeRules: () => [changed] });
    const second = runSuite(patched, store, 'qa', { ruleCode: 'CARD_SPEND_10K' }, 'PINNED', 'after change');
    expect(second.failed).toBeGreaterThan(0);
    expect(listRuns(store)).toHaveLength(first.total + second.total);
    void db;
  });

  it('saves, clones, archives and reruns a custom case, recording expected versus actual', () => {
    const { source, store } = setup();
    const input: SimInput = { name: 'Spend 12k', rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: scenario(12000), expected: { totalPoints: 300 } };
    const c = saveCase(store, 'qa', { name: 'Spend 12k', category: 'POSITIVE', input });
    const copy = cloneCase(store, 'qa', c.caseId);
    expect(copy.clonedFrom).toBe(c.caseId);
    expect(copy.name).toMatch(/copy/);
    const r = runCase(source, store, 'qa', c.caseId);
    expect(r.status).toBe('PASSED');
    expect(getRun(store, r.runId)!.result!.final!.totalPoints).toBe(300);
    archiveCase(store, copy.caseId);
    expect(listCases(store).map((x) => x.caseId)).toEqual([c.caseId]);
    expect(listCases(store, { includeArchived: true })).toHaveLength(2);
    expect(listCases(store)[0].lastRun!.status).toBe('PASSED');
  });

  it('flags cases without expectations as such rather than as passes, and rejects bad input', () => {
    const { source, store } = setup();
    const r = runAndRecord(source, store, 'qa', { rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: scenario(5) });
    expect(r.status).toBe('NO_EXPECTATION');
    expect(() => saveCase(store, 'qa', { name: 'x', input: { rules: [], scenario: scenario(1) } as any })).toThrow(/name/);
    expect(() => saveCase(store, 'qa', { name: 'No rules', input: { rules: [], scenario: scenario(1) } })).toThrow(/rule/i);
  });
});

describe('performance runner', () => {
  it('processes synthetic load without duplicate awards and with a stable ledger after redelivery', () => {
    const { source } = rulesOnlyDb();
    const r = runPerformance(source, { rule: { ruleCode: 'UPI_10_TXNS' }, customers: 30, txnsPerCustomer: 14, duplicateRatio: 0.25 });
    expect(r.events).toBeGreaterThanOrEqual(30 * 14);
    expect(r.duplicatesDelivered).toBeGreaterThan(0);
    expect(r.duplicateAwards).toBe(0);
    expect(r.ledgerStableAfterDuplicates).toBe(true);
    expect(r.reconciliation).toMatch(/PASSED/i);
    expect(r.eventsPerSecond).toBeGreaterThan(50);
    expect(r.customersRewarded).toBe(30);
    expect(r.totalPoints).toBe(30 * 100);
  });
});

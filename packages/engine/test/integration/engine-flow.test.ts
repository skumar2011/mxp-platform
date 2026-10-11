import { describe, expect, it } from 'vitest';
import { DbRuleSource, Engine, FixedClock, decideAdjustment, reconcileAgainstSource, requestAdjustment, runReconciliation, runScenario, type SimScenario } from '../../src/index';
import { NOW, admin, checker, ops, seededDb } from '../helpers';

const engineFor = (db: ReturnType<typeof seededDb>) => new Engine(db, new FixedClock(NOW));

describe('the seeded demo matches the documented business outcomes', () => {
  const db = seededDb();
  const net = (cust: string, rule: string, period?: string) =>
    db.value<number>(
      `SELECT COALESCE(SUM(l.points),0) FROM xp_ledger l JOIN customer c USING(customer_id) JOIN rule r USING(rule_id)
        WHERE c.customer_ref = ? AND r.rule_code = ? AND (? IS NULL OR l.period_key = ?)`,
      cust, rule, period ?? null, period ?? null,
    )!;

  it('ingested all 244 events with none rejected or stuck', () => {
    expect(db.all<any>('SELECT processing_status s, COUNT(*) n FROM ingestion_event GROUP BY 1')).toEqual([{ s: 'PROCESSED', n: 244 }]);
  });

  it('CUST-1001 clears four goals: card spend, 12 UPI payments, 3 utility bills and last month’s average balance', () => {
    expect(net('CUST-1001', 'CARD_SPEND_10K')).toBe(300);
    expect(net('CUST-1001', 'UPI_10_TXNS')).toBe(100);
    expect(net('CUST-1001', 'UTILITY_3_BILLS')).toBe(150);
    expect(net('CUST-1001', 'SAV_AVG_BAL_50K', '2026-09')).toBe(500);
  });

  it('CUST-1002 narrowly misses everything: ₹9,999 spend, 9 qualifying UPI payments (self transfer excluded), average balance under ₹50k', () => {
    expect(db.value("SELECT COALESCE(SUM(l.points),0) FROM xp_ledger l JOIN customer c USING(customer_id) WHERE c.customer_ref = 'CUST-1002'")).toBe(0);
    const spend = db.get<any>(`SELECT g.txn_sum_minor, g.achieved_tier FROM goal_progress g JOIN customer c USING(customer_id) JOIN rule_version v USING(rule_version_id) JOIN rule r ON r.rule_id = v.rule_id
      WHERE c.customer_ref = 'CUST-1002' AND r.rule_code = 'CARD_SPEND_10K' AND g.period_key = '2026-10'`)!;
    expect(spend).toMatchObject({ txn_sum_minor: 999_900, achieved_tier: 0 });
    const upi = db.get<any>(`SELECT g.txn_count FROM goal_progress g JOIN customer c USING(customer_id) JOIN rule_version v USING(rule_version_id) JOIN rule r ON r.rule_id = v.rule_id
      WHERE c.customer_ref = 'CUST-1002' AND r.rule_code = 'UPI_10_TXNS' AND g.period_key = '2026-10'`)!;
    expect(upi.txn_count).toBe(9);
  });

  it('CUST-1003 earns savings growth and the utility bonus, counting a bill from last month inside the campaign window', () => {
    expect(net('CUST-1003', 'SAV_GROWTH_25K')).toBe(400);
    expect(net('CUST-1003', 'UTILITY_3_BILLS')).toBe(150);
  });

  it('CUST-1004 earns the combined reward, and this month’s card reward is clawed back after a refund', () => {
    expect(net('CUST-1004', 'BALANCE_PLUS_CARD')).toBe(1000);
    expect(net('CUST-1004', 'CARD_SPEND_10K', '2026-09')).toBe(300);
    expect(net('CUST-1004', 'CARD_SPEND_10K', '2026-10')).toBe(0);
    expect(db.all<any>("SELECT entry_type t, points p FROM xp_ledger l JOIN customer c USING(customer_id) JOIN rule r USING(rule_id) WHERE c.customer_ref='CUST-1004' AND r.rule_code='CARD_SPEND_10K' AND l.period_key='2026-10' ORDER BY ledger_id"))
      .toEqual([{ t: 'AWARD', p: 300 }, { t: 'REVERSAL', p: -300 }]);
  });

  it('CUST-1005 earns nothing and, having declined nudges, receives none', () => {
    expect(db.value("SELECT COALESCE(SUM(l.points),0) FROM xp_ledger l JOIN customer c USING(customer_id) WHERE c.customer_ref = 'CUST-1005'")).toBe(0);
    expect(db.value("SELECT COUNT(*) FROM nudge n JOIN customer c USING(customer_id) WHERE c.customer_ref = 'CUST-1005' AND n.status = 'SENT'")).toBe(0);
  });

  it('totals: 3,700 awarded, 300 reversed, 3,400 net, no duplicate award keys', () => {
    expect(db.value("SELECT SUM(points) FROM xp_ledger WHERE entry_type = 'AWARD'")).toBe(3700);
    expect(db.value("SELECT SUM(points) FROM xp_ledger WHERE entry_type = 'REVERSAL'")).toBe(-300);
    expect(db.value('SELECT SUM(points) FROM xp_ledger')).toBe(3400);
    expect(db.value('SELECT COUNT(*) - COUNT(DISTINCT idempotency_key) FROM xp_ledger')).toBe(0);
  });

  it('the XP account projection equals the ledger for every customer', () => {
    const rows = db.all<any>('SELECT c.customer_ref, COALESCE(a.balance,0) b, COALESCE((SELECT SUM(points) FROM xp_ledger WHERE customer_id = c.customer_id),0) s FROM customer c LEFT JOIN xp_account a USING(customer_id)');
    for (const r of rows) expect(r.b, r.customer_ref).toBe(r.s);
  });
});

describe('re-processing is safe', () => {
  it('replaying every transaction through every rule changes nothing', () => {
    const db = seededDb();
    const before = db.all<any>('SELECT ledger_id, points, idempotency_key FROM xp_ledger ORDER BY ledger_id');
    const engine = engineFor(db);
    engine.backfillRule('CARD_SPEND_10K');
    engine.backfillRule('UPI_10_TXNS');
    engine.backfillRule('UTILITY_3_BILLS');
    engine.closePeriods();
    engine.closePeriods();
    expect(db.all<any>('SELECT ledger_id, points, idempotency_key FROM xp_ledger ORDER BY ledger_id')).toEqual(before);
  });

  it('period close is idempotent', () => {
    const db = seededDb();
    const engine = engineFor(db);
    const n = db.value<number>('SELECT COUNT(*) FROM xp_ledger')!;
    for (let i = 0; i < 3; i++) engine.closePeriods();
    expect(db.value('SELECT COUNT(*) FROM xp_ledger')).toBe(n);
  });
});

describe('closed periods and late data', () => {
  const sc = (receivedAt?: string): SimScenario => ({
    timezone: 'Asia/Kolkata',
    customer: { status: 'ACTIVE', kycStatus: 'FULL' },
    accounts: [{ ref: 'CC-1', productCode: 'CC_GOLD' }],
    steps: [{ kind: 'TXN', id: 't1', at: '2026-09-20', type: 'PURCHASE', channel: 'CARD_ONLINE', amount: 10500, accountRef: 'CC-1', category: 'SHOPPING', receivedAt }],
    asOf: '2026-10-10',
  });
  const { source } = (() => {
    const db = seededDb();
    return { source: new DbRuleSource(db) };
  })();

  it('on-time September spend earns the reward', () => {
    const res = runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: sc(), expected: { totalPoints: 300 } });
    expect(res.passed, JSON.stringify(res.checks)).toBe(true);
  });

  it('September spend that arrives after the period has closed cannot earn a reward', () => {
    const res = runScenario(source, { rules: [{ ruleCode: 'CARD_SPEND_10K' }], scenario: sc('2026-10-05T10:00'), expected: { totalPoints: 0 } });
    expect(res.passed, JSON.stringify(res.checks)).toBe(true);
    // It is still recorded in the master and the metric, so nothing is lost for audit.
    expect(res.final!.progress.find((p) => p.periodKey === '2026-09')!.amount).toBe(10500);
  });
});

describe('manual adjustments are maker-checker and keep the ledger consistent', () => {
  it('requires a reason, a different approver, and never takes a balance negative', () => {
    const db = seededDb();
    const ctx = engineFor(db).ctx;
    expect(() => requestAdjustment(ctx, ops, 'CUST-1001', 100, 'x')).toThrow(/reason/i);
    expect(() => requestAdjustment(ctx, ops, 'CUST-1001', 0, 'zero is meaningless')).toThrow(/non-zero/);
    expect(() => requestAdjustment(ctx, ops, 'NOPE', 100, 'unknown customer here')).toThrow(/not found/);
    const adj = requestAdjustment(ctx, ops, 'CUST-1001', 250, 'Goodwill for a service outage');
    expect(() => decideAdjustment(ctx, ops, adj.adjustment_id, true)).toThrow(/cannot decide your own/);
    const done = decideAdjustment(ctx, checker, adj.adjustment_id, true, 'Approved');
    expect(done.status).toBe('APPROVED');
    expect(db.value("SELECT SUM(points) FROM xp_ledger l JOIN customer c USING(customer_id) WHERE c.customer_ref = 'CUST-1001'")).toBe(1300); // 1,050 earned + 250 adjustment
    expect(() => decideAdjustment(ctx, checker, adj.adjustment_id, false)).toThrow(/already APPROVED/);
    const big = requestAdjustment(ctx, ops, 'CUST-1005', -50, 'Reverse a promo given in error');
    expect(() => decideAdjustment(ctx, checker, big.adjustment_id, true)).toThrow(/below zero/);
    expect(runReconciliation(ctx, admin).status).toBe('PASSED');
  });
});

describe('reconciliation', () => {
  it('passes on a healthy system and records the run', () => {
    const db = seededDb();
    const r = runReconciliation(engineFor(db).ctx, admin);
    expect(r.status).toBe('PASSED');
    expect(r.checks.map((c) => c.type)).toEqual(expect.arrayContaining(['LEDGER_BALANCE', 'PROGRESS_VS_JOURNAL', 'JOURNAL_VS_MASTER', 'REVERSAL_INTEGRITY', 'AUDIT_CHAIN', 'DEAD_LETTERS']));
    expect(db.get<any>('SELECT status FROM reconciliation_run')!.status).toBe('PASSED');
  });

  it('detects a projection that drifted from the ledger', () => {
    const db = seededDb();
    db.run("UPDATE xp_account SET balance = balance + 1 WHERE customer_id = (SELECT customer_id FROM customer WHERE customer_ref = 'CUST-1001')");
    const r = runReconciliation(engineFor(db).ctx, admin);
    expect(r.status).toBe('FAILED');
    expect(r.breaks[0]).toMatchObject({ type: 'LEDGER_BALANCE', entity: 'CUST-1001' });
  });

  it('detects progress that disagrees with its journal', () => {
    const db = seededDb();
    db.run('UPDATE goal_progress SET txn_count = txn_count + 5 WHERE rowid = (SELECT rowid FROM goal_progress WHERE txn_count > 0 LIMIT 1)');
    expect(runReconciliation(engineFor(db).ctx, admin).breaks.some((b) => b.type === 'PROGRESS_VS_JOURNAL')).toBe(true);
  });

  it('flags dead-lettered events', () => {
    const db = seededDb();
    db.run("UPDATE ingestion_event SET processing_status = 'DEAD_LETTER', error_code = 'X' WHERE rowid = 1");
    expect(runReconciliation(engineFor(db).ctx, admin).breaks.some((b) => b.type === 'DEAD_LETTERS')).toBe(true);
  });

  it('flags a tampered audit log', () => {
    const db = seededDb();
    db.exec('DROP TRIGGER trg_audit_no_update');
    db.run("UPDATE audit_log SET reason = 'edited' WHERE audit_id = 3");
    expect(runReconciliation(engineFor(db).ctx, admin).breaks.some((b) => b.type === 'AUDIT_CHAIN')).toBe(true);
  });

  it('reconciles against a source-system extract and reports missing, extra and different transactions', () => {
    const db = seededDb();
    const entries = [
      { sourceTxnId: '1001-C1', amount: 4200 }, // matches
      { sourceTxnId: '1001-C2', amount: 5000 }, // amount differs (5,100 in MXP)
      { sourceTxnId: 'ONLY-IN-SOURCE', amount: 100 },
    ];
    const out = reconcileAgainstSource(engineFor(db).ctx, admin, 'CARDS', entries, '2026-10-01', '2026-10-31');
    expect(out.matched).toBe(1);
    expect(out.missingInMxp).toEqual(['ONLY-IN-SOURCE']);
    expect(out.mismatched).toEqual([{ sourceTxnId: '1001-C2', expected: '5000', actual: '5100 POSTED' }]);
    // Everything else MXP holds for the month from CARDS is not in the extract.
    expect(out.unexpectedInMxp).toContain('1001-C3');
    expect(out.unexpectedInMxp).not.toContain('1001-C1');
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { cardEvent, makeApp, spend2kRule, type TestApp } from './helpers';

/**
 * The expected outcome of the whole platform, end to end over HTTP:
 * an admin creates a goal, configures conditions and XP, tests it against scenarios, gets it approved and activated,
 * and then verifies correct rewards with no duplicates.
 */
let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});

const RULE = 'SPEND_2K_E2E';
const ledgerFor = async (rule: string, customer = 'CUST-1001') => (await t.call('GET', `/api/ledger?ruleCode=${rule}&customerRef=${customer}`, 'ops')).json;

describe('create -> simulate -> approve -> activate -> verify', () => {
  it('1. a maker creates a draft goal and gets plain validation feedback first', async () => {
    const bad = await t.call('POST', '/api/rules/validate', 'maker', { definition: { ...spend2kRule(), tiers: [{ label: 'a', threshold: 100, points: 5 }, { label: 'b', threshold: 50, points: 9 }] } });
    expect(bad.json.valid).toBe(false);
    expect(bad.json.errors[0].message).toMatch(/tier|threshold|increas/i);

    const ok = await t.call('POST', '/api/rules/validate', 'maker', { definition: spend2kRule() });
    expect(ok.json.valid).toBe(true);

    const created = await t.call('POST', '/api/rules', 'maker', { code: RULE, definition: spend2kRule(), changeNote: 'Initial version' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ ruleCode: RULE, versionNo: 1, status: 'DRAFT', createdBy: 'maker' });
  });

  it('2. roles are enforced: QA cannot create rules, an auditor cannot simulate', async () => {
    expect((await t.call('POST', '/api/rules', 'qa', { code: 'QA_RULE', definition: spend2kRule() })).status).toBe(403);
    expect((await t.call('POST', '/api/sim/run', 'auditor', { input: { rules: [], scenario: { accounts: [], steps: [] } } })).status).toBe(403);
  });

  it('3. the draft is tested with an auto-generated scenario matrix; the result is recorded as approver evidence', async () => {
    const m = await t.call('POST', `/api/sim/matrix`, 'maker', { rule: { ruleCode: RULE, versionNo: 1 }, run: true });
    expect(m.status).toBe(200);
    expect(m.json.suite.total).toBeGreaterThanOrEqual(10);
    expect(m.json.suite).toMatchObject({ failed: 0, errors: 0 });
    expect(m.json.suite.passed).toBe(m.json.suite.total);
    const detail = await t.call('GET', `/api/rules/${RULE}/versions/1`, 'checker');
    const evidence = detail.json.history.filter((h: any) => h.action === 'SIMULATION_RUN');
    expect(evidence).toHaveLength(1);
    expect(JSON.parse(evidence[0].after_json)).toMatchObject({ failed: 0, kind: 'MATRIX' });
  });

  it('4. simulation never wrote to production', async () => {
    expect(t.db.value("SELECT COUNT(*) FROM xp_ledger l JOIN rule r USING(rule_id) WHERE r.rule_code = ?", RULE)).toBe(0);
    expect(t.db.value("SELECT COUNT(*) FROM customer WHERE customer_ref LIKE 'SIM%'")).toBe(0);
  });

  it('5. submit; the maker cannot approve their own rule; a checker can', async () => {
    expect((await t.call('POST', `/api/rules/${RULE}/versions/1/submit`, 'maker')).json.status).toBe('PENDING_APPROVAL');
    const self = await t.call('POST', `/api/rules/${RULE}/versions/1/approve`, 'maker', { note: 'self' });
    expect(self.status).toBe(403); // the maker role does not hold rules:approve
    expect(self.json.error.code).toBe('FORBIDDEN');
    const ok = await t.call('POST', `/api/rules/${RULE}/versions/1/approve`, 'checker', { note: 'Reviewed thresholds and exclusions' });
    expect(ok.json).toMatchObject({ status: 'APPROVED', approvedBy: 'checker' });
  });

  it('6. activation needs the activate permission, not just approval', async () => {
    expect((await t.call('POST', `/api/rules/${RULE}/versions/1/activate`, 'maker', {})).status).toBe(403);
    expect((await t.call('POST', `/api/rules/${RULE}/versions/1/activate`, 'qa', {})).status).toBe(403);
    const ok = await t.call('POST', `/api/rules/${RULE}/versions/1/activate`, 'ops', { backfill: false });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('ACTIVE');
    const list = await t.call('GET', '/api/rules', 'maker');
    expect(list.json.rules.find((r: any) => r.ruleCode === RULE)).toMatchObject({ status: 'ACTIVE' });
  });

  it('7. a qualifying transaction earns exactly one reward', async () => {
    const r = await t.call('POST', '/api/ingest', 'ops', { events: [cardEvent('E2E-1', 2500, '2026-10-05T10:00:00+05:30')] });
    expect(r.status).toBe(202);
    expect(r.json.summary).toMatchObject({ received: 1, accepted: 1, rejected: 0 });
    const l = await ledgerFor(RULE);
    expect(l.sum).toBe(40);
    expect(l.rows).toHaveLength(1);
    expect(l.rows[0]).toMatchObject({ entryType: 'AWARD', points: 40, ruleCode: RULE, period: '2026-10' });
  });

  it('8. redelivering the same event, or the same transaction under a new event id, never pays twice', async () => {
    const same = await t.call('POST', '/api/ingest', 'ops', { events: [cardEvent('E2E-1', 2500, '2026-10-05T10:00:00+05:30')] });
    expect(same.json.summary.duplicates).toBe(1);
    const otherId = { ...cardEvent('E2E-1', 2500, '2026-10-05T10:00:00+05:30'), sourceEventId: 'a-different-event-id' };
    await t.call('POST', '/api/ingest', 'ops', { events: [otherId] });
    await t.call('POST', '/api/ingest', 'ops', { events: [cardEvent('E2E-2', 900, '2026-10-06T10:00:00+05:30')] });
    const l = await ledgerFor(RULE);
    expect(l.sum).toBe(40);
    expect(l.rows).toHaveLength(1);
  });

  it('9. a refund that takes spend back under the threshold claws the reward back', async () => {
    // spend is now 3,400; refund 1,500 -> 1,900 < 2,000
    const refund = {
      eventType: 'TRANSACTION', sourceSystem: 'CARDS', sourceEventId: 'E2E-RF:POSTED',
      transaction: { sourceTxnId: 'E2E-RF', originalSourceTxnId: 'E2E-1', customerRef: 'CUST-1001', accountRef: 'CCA-1001', txnType: 'REFUND', channel: 'CARD_ONLINE', amount: 1500, currency: 'INR', drCr: 'C', status: 'POSTED', txnTimestamp: '2026-10-08T10:00:00+05:30' },
    };
    expect((await t.call('POST', '/api/ingest', 'ops', { events: [refund] })).status).toBe(202);
    const l = await ledgerFor(RULE);
    expect(l.sum).toBe(0);
    expect(l.rows.map((r: any) => [r.entryType, r.points])).toEqual([['REVERSAL', -40], ['AWARD', 40]]);
    expect(l.rows[0].reversesLedgerId).toBe(l.rows[1].ledgerId);
  });

  it('10. the customer 360, evaluation trace and audit trail explain what happened', async () => {
    const c = await t.call('GET', '/api/customers/CUST-1001', 'ops');
    expect(c.json.progress.find((p: any) => p.ruleCode === RULE)).toMatchObject({ period: '2026-10', metric: 1900 });
    const ev = await t.call('GET', `/api/evaluations?ruleCode=${RULE}&customerRef=CUST-1001`, 'ops');
    expect(ev.json.total).toBeGreaterThanOrEqual(3);
    const trace = await t.call('GET', `/api/evaluations/${ev.json.rows[0].evaluationId}`, 'ops');
    expect(trace.json.trace).toBeTruthy();
    const audit = await t.call('GET', `/api/audit?entityId=${RULE}@1`, 'auditor');
    expect(audit.json.rows.map((r: any) => r.action)).toEqual(expect.arrayContaining(['RULE_ACTIVATE', 'RULE_APPROVE', 'RULE_SUBMIT', 'SIMULATION_RUN']));
    expect((await t.call('GET', '/api/audit/verify', 'auditor')).json.ok).toBe(true);
  });

  it('11. the system reconciles', async () => {
    const r = await t.call('POST', '/api/ops/reconcile', 'ops', {});
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('PASSED');
  });
});

describe('versioning, diff and rollback over the API', () => {
  it('a new version goes through the same workflow, is diffed, supersedes v1, and can be rolled back with a reason', async () => {
    const v2 = await t.call('POST', `/api/rules/${RULE}/versions`, 'maker', { baseVersionNo: 1, changeNote: 'Raise threshold' });
    expect(v2.status).toBe(201);
    const def = { ...spend2kRule(), tiers: [{ label: '₹5K', threshold: 5000, points: 40 }] };
    expect((await t.call('PUT', `/api/rules/${RULE}/versions/2`, 'maker', { definition: def, changeNote: 'Raise threshold' })).status).toBe(200);
    await t.call('POST', `/api/rules/${RULE}/versions/2/submit`, 'maker');
    await t.call('POST', `/api/rules/${RULE}/versions/2/approve`, 'checker', {});
    const diff = await t.call('GET', `/api/rules/${RULE}/diff?from=1&to=2`, 'checker');
    expect(diff.json.changes.some((c: any) => c.path.startsWith('tiers'))).toBe(true);
    await t.call('POST', `/api/rules/${RULE}/versions/2/activate`, 'ops', { backfill: false });
    const versions = (await t.call('GET', `/api/rules/${RULE}`, 'maker')).json.versions;
    expect(versions.map((v: any) => [v.versionNo, v.status])).toEqual([[2, 'ACTIVE'], [1, 'SUPERSEDED']]);

    expect((await t.call('POST', `/api/rules/${RULE}/rollback`, 'ops', { versionNo: 1, reason: 'no' })).status).toBe(422);
    const rb = await t.call('POST', `/api/rules/${RULE}/rollback`, 'ops', { versionNo: 1, reason: 'Threshold change was premature' });
    expect(rb.status).toBe(200);
    expect(rb.json.status).toBe('ACTIVE');
  });
});

import { describe, expect, it } from 'vitest';
import {
  actorFor, approve, createRule, createVersion, diffDefinitions, getLiveRules, getVersion, listVersions, pause, reject, resume, retire, rollback,
  sampleRules, submitForApproval, updateDraft, validateVersion, verifyAuditChain, FixedClock, type Actor,
} from '../../src/index';
import { NOW, admin, cardEvent, checker, emptyEnv, ledgerTotal, maker } from '../helpers';

const T = '2026-10-02T10:00:00+05:30';
const card = () => sampleRules(new FixedClock(NOW)).find((r) => r.code === 'CARD_SPEND_10K')!.def;
const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (e: any) { return e.code as string; }
  return undefined;
};

/** Creates v2 of CARD_SPEND_10K with a different threshold, approved and ready to activate. */
function approvedV2(env: ReturnType<typeof emptyEnv>, threshold: number, backfill = false) {
  const ctx = env.engine.ctx;
  const v = createVersion(ctx, maker, 'CARD_SPEND_10K', 1, 'Change threshold');
  const def = { ...v.def, backfill, tiers: [{ label: 'new', threshold, points: 300 }] };
  updateDraft(ctx, maker, 'CARD_SPEND_10K', v.versionNo, def, 'Change threshold');
  submitForApproval(ctx, maker, 'CARD_SPEND_10K', v.versionNo);
  approve(ctx, checker, 'CARD_SPEND_10K', v.versionNo, 'ok');
  return v.versionNo;
}

describe('rule lifecycle and maker-checker', () => {
  it('a rule moves DRAFT -> PENDING_APPROVAL -> APPROVED -> ACTIVE and every step is audited', () => {
    const { engine, db } = emptyEnv();
    const ctx = engine.ctx;
    createRule(ctx, maker, 'NEW_RULE_1', { ...card(), name: 'New rule 1' }, 'first');
    expect(getVersion(db, 'NEW_RULE_1', 1)!.status).toBe('DRAFT');
    submitForApproval(ctx, maker, 'NEW_RULE_1', 1);
    expect(getVersion(db, 'NEW_RULE_1', 1)!.status).toBe('PENDING_APPROVAL');
    approve(ctx, checker, 'NEW_RULE_1', 1, 'looks right');
    engine.activate(admin, 'NEW_RULE_1', 1);
    expect(getVersion(db, 'NEW_RULE_1', 1)).toMatchObject({ status: 'ACTIVE', createdBy: 'maker', submittedBy: 'maker', approvedBy: 'checker', activatedBy: 'admin' });
    const actions = db.all<any>("SELECT action FROM audit_log WHERE entity_id = 'NEW_RULE_1@1' ORDER BY audit_id").map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['RULE_SUBMIT', 'RULE_APPROVE', 'RULE_ACTIVATE']));
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it('the creator or submitter cannot approve or reject their own rule', () => {
    const { engine } = emptyEnv();
    const ctx = engine.ctx;
    createRule(ctx, maker, 'SELF_REVIEW', { ...card(), name: 'Self review' });
    submitForApproval(ctx, maker, 'SELF_REVIEW', 1);
    expect(codeOf(() => approve(ctx, maker, 'SELF_REVIEW', 1))).toBe('MAKER_CHECKER');
    expect(codeOf(() => reject(ctx, maker, 'SELF_REVIEW', 1, 'Not acceptable'))).toBe('MAKER_CHECKER');
    // Even someone who holds the approver role is blocked if they are the maker.
    const dual: Actor = { username: 'maker', roles: ['RULE_MAKER', 'RULE_APPROVER'] };
    expect(codeOf(() => approve(ctx, dual, 'SELF_REVIEW', 1))).toBe('MAKER_CHECKER');
    // A different user may.
    expect(approve(ctx, actorFor('checker'), 'SELF_REVIEW', 1).status).toBe('APPROVED');
  });

  it('a submitter other than the creator also cannot approve', () => {
    const { engine } = emptyEnv();
    const ctx = engine.ctx;
    createRule(ctx, maker, 'SUBMITTER', { ...card(), name: 'Submitter test' });
    const qa: Actor = { username: 'qa', roles: ['QA_ENGINEER'] };
    submitForApproval(ctx, qa, 'SUBMITTER', 1);
    expect(codeOf(() => approve(ctx, qa, 'SUBMITTER', 1))).toBe('MAKER_CHECKER');
  });

  it('rejection needs a reason and sends the version to REJECTED', () => {
    const { engine, db } = emptyEnv();
    const ctx = engine.ctx;
    createRule(ctx, maker, 'REJECT_ME', { ...card(), name: 'Reject me' });
    submitForApproval(ctx, maker, 'REJECT_ME', 1);
    expect(codeOf(() => reject(ctx, checker, 'REJECT_ME', 1, ''))).toBe('REASON_REQUIRED');
    reject(ctx, checker, 'REJECT_ME', 1, 'Threshold too low');
    expect(getVersion(db, 'REJECT_ME', 1)).toMatchObject({ status: 'REJECTED' });
  });

  it('refuses invalid transitions and edits to non-drafts', () => {
    const { engine } = emptyEnv();
    const ctx = engine.ctx;
    expect(codeOf(() => approve(ctx, checker, 'CARD_SPEND_10K', 1))).toBe('BAD_TRANSITION');
    expect(codeOf(() => submitForApproval(ctx, maker, 'CARD_SPEND_10K', 1))).toBe('BAD_TRANSITION');
    expect(codeOf(() => updateDraft(ctx, maker, 'CARD_SPEND_10K', 1, card()))).toBe('NOT_DRAFT');
    expect(codeOf(() => engine.activate(admin, 'CARD_SPEND_10K', 1))).toBe('BAD_TRANSITION');
  });

  it('only the maker (or a system administrator, audited) can edit a draft', () => {
    const { engine, db } = emptyEnv();
    const ctx = engine.ctx;
    createRule(ctx, maker, 'MY_DRAFT', { ...card(), name: 'My draft' });
    const other: Actor = { username: 'rita', roles: ['RULE_MAKER'] };
    expect(codeOf(() => updateDraft(ctx, other, 'MY_DRAFT', 1, { ...card(), name: 'Hijacked' }))).toBe('NOT_OWNER');
    updateDraft(ctx, admin, 'MY_DRAFT', 1, { ...card(), name: 'Fixed by admin' });
    expect(getVersion(db, 'MY_DRAFT', 1)!.def.name).toBe('Fixed by admin');
    expect(db.get<any>("SELECT actor FROM audit_log WHERE action = 'RULE_DRAFT_UPDATE' ORDER BY audit_id DESC")!.actor).toBe('admin');
  });

  it('blocks submission of an invalid definition with a full validation report', () => {
    const { engine } = emptyEnv();
    const ctx = engine.ctx;
    const bad = { ...card(), name: 'Bad rule', tiers: [{ label: 'a', threshold: 100, points: 10 }, { label: 'b', threshold: 50, points: 5 }], period: { type: 'MONTHLY', timezone: 'Mars/Base' } };
    createRule(ctx, maker, 'BAD_RULE', bad);
    let err: any;
    try { submitForApproval(ctx, maker, 'BAD_RULE', 1); } catch (e) { err = e; }
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.status).toBe(422);
    expect(err.details.errors.length).toBeGreaterThanOrEqual(2);
    const report = validateVersion(ctx, 'BAD_RULE', 1);
    expect(report.valid).toBe(false);
    expect(report.errors.every((e: any) => e.message && e.path !== undefined)).toBe(true);
  });

  it('rejects bad rule codes and duplicate codes', () => {
    const { engine } = emptyEnv();
    expect(codeOf(() => createRule(engine.ctx, maker, 'bad code!', card()))).toBe('BAD_CODE');
    expect(codeOf(() => createRule(engine.ctx, maker, 'CARD_SPEND_10K', card()))).toBe('DUPLICATE_CODE');
  });

  it('only one version may be in flight at a time', () => {
    const { engine } = emptyEnv();
    createVersion(engine.ctx, maker, 'CARD_SPEND_10K', 1);
    expect(codeOf(() => createVersion(engine.ctx, maker, 'CARD_SPEND_10K', 1))).toBe('OPEN_VERSION_EXISTS');
  });
});

describe('activation, supersession, pause and rollback', () => {
  it('activating v2 supersedes v1 so exactly one version is live, and new events use v2', () => {
    const env = emptyEnv();
    const { engine, db } = env;
    const v2 = approvedV2(env, 5000);
    engine.ingestAndProcess([cardEvent('a', 6000, T)]);
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(0); // v1 needs 10,000
    engine.activate(admin, 'CARD_SPEND_10K', v2, { backfill: false });
    expect(listVersions(db, 'CARD_SPEND_10K').map((v) => [v.versionNo, v.status])).toEqual([[2, 'ACTIVE'], [1, 'SUPERSEDED']]);
    expect(getLiveRules(db).filter((r) => r.ruleCode === 'CARD_SPEND_10K')).toHaveLength(1);
    expect(db.value("SELECT COUNT(*) FROM goal_progress WHERE status = 'CLOSED_SUPERSEDED'")).toBeGreaterThan(0);
    // Without backfill v2 only counts what arrives after activation: 1,000 is not yet 5,000.
    engine.ingestAndProcess([cardEvent('b', 1000, T)]);
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(0);
    engine.ingestAndProcess([cardEvent('c', 4500, T)]);
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(300); // 5,500 >= 5,000 under v2
  });

  it('backfill on activation replays the open period so earlier spend is credited', () => {
    const env = emptyEnv();
    const { engine, db } = env;
    engine.ingestAndProcess([cardEvent('a', 6000, T)]);
    const v2 = approvedV2(env, 5000, true);
    engine.activate(admin, 'CARD_SPEND_10K', v2);
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(300);
    expect(db.value("SELECT COUNT(*) FROM xp_ledger WHERE entry_type = 'AWARD'")).toBe(1);
  });

  it('backfill twice never pays twice', () => {
    const env = emptyEnv();
    const { engine, db } = env;
    engine.ingestAndProcess([cardEvent('a', 12000, T)]);
    engine.backfillRule('CARD_SPEND_10K');
    engine.backfillRule('CARD_SPEND_10K');
    expect(db.value("SELECT COUNT(*) FROM xp_ledger WHERE entry_type = 'AWARD'")).toBe(1);
    expect(ledgerTotal(db)).toBe(300);
  });

  it('a paused rule stops evaluating; resuming does not guess, a backfill catches it up', () => {
    const { engine, db } = emptyEnv();
    pause(engine.ctx, admin, 'CARD_SPEND_10K', 1, 'Investigating a bug');
    engine.ingestAndProcess([cardEvent('a', 12000, T)]);
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(0);
    resume(engine.ctx, admin, 'CARD_SPEND_10K', 1);
    engine.ingestAndProcess([cardEvent('b', 100, T)]);
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(0); // spend during the pause was not counted
    engine.backfillRule('CARD_SPEND_10K'); // the documented catch-up step (runbook: resuming a rule)
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(300);
  });

  it('a retired rule is no longer live', () => {
    const { engine, db } = emptyEnv();
    retire(engine.ctx, admin, 'UPI_10_TXNS', 1, 'Campaign over');
    expect(getLiveRules(db).some((r) => r.ruleCode === 'UPI_10_TXNS')).toBe(false);
    expect(getVersion(db, 'UPI_10_TXNS', 1)!.status).toBe('RETIRED');
  });

  it('rollback re-activates the previous approved version, needs a reason, and only applies to superseded versions', () => {
    const env = emptyEnv();
    const { engine, db } = env;
    const v2 = approvedV2(env, 5000);
    engine.activate(admin, 'CARD_SPEND_10K', v2, { backfill: false });
    expect(codeOf(() => rollback(engine.ctx, admin, 'CARD_SPEND_10K', 1, 'x'))).toBe('REASON_REQUIRED');
    expect(codeOf(() => rollback(engine.ctx, admin, 'CARD_SPEND_10K', 2, 'rollback the live one'))).toBe('BAD_TRANSITION');
    engine.rollback(admin, 'CARD_SPEND_10K', 1, 'v2 threshold was a mistake');
    expect(listVersions(db, 'CARD_SPEND_10K').map((v) => [v.versionNo, v.status])).toEqual([[2, 'SUPERSEDED'], [1, 'ACTIVE']]);
    engine.ingestAndProcess([cardEvent('a', 6000, T)]);
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(0);
    expect(db.get<any>("SELECT reason FROM audit_log WHERE action = 'RULE_ROLLBACK'")!.reason).toBe('v2 threshold was a mistake');
  });

  it('a combined rule cannot be activated while a component is missing or retired', () => {
    const { engine } = emptyEnv();
    retire(engine.ctx, admin, 'CARD_SPEND_10K', 1, 'gone');
    const v = createVersion(engine.ctx, maker, 'BALANCE_PLUS_CARD', 1);
    updateDraft(engine.ctx, maker, 'BALANCE_PLUS_CARD', v.versionNo, v.def);
    const report = validateVersion(engine.ctx, 'BALANCE_PLUS_CARD', v.versionNo, true);
    expect(report.valid).toBe(false);
  });

  it('compares versions field by field', () => {
    const env = emptyEnv();
    const v2 = approvedV2(env, 5000);
    const a = getVersion(env.db, 'CARD_SPEND_10K', 1)!.def;
    const b = getVersion(env.db, 'CARD_SPEND_10K', v2)!.def;
    const diff = diffDefinitions(a, b);
    expect(diff.some((d) => d.path.startsWith('tiers'))).toBe(true);
    expect(diffDefinitions(a, a)).toEqual([]);
  });
});

describe('tamper evidence and immutability', () => {
  it('detects a sealed rule definition that was changed outside the workflow', () => {
    const { db } = emptyEnv();
    db.run("UPDATE rule_version SET priority = 1 WHERE status = 'ACTIVE' AND rule_id = (SELECT rule_id FROM rule WHERE rule_code = 'CARD_SPEND_10K')");
    expect(codeOf(() => getVersion(db, 'CARD_SPEND_10K', 1))).toBe('DEFINITION_TAMPERED');
  });

  it('the XP ledger cannot be updated or deleted', () => {
    const { engine, db } = emptyEnv();
    engine.ingestAndProcess([cardEvent('a', 12000, T)]);
    expect(() => db.run('UPDATE xp_ledger SET points = 9999')).toThrow(/immutable/);
    expect(() => db.run('DELETE FROM xp_ledger')).toThrow(/immutable/);
    expect(ledgerTotal(db)).toBe(300);
  });

  it('goal contributions are append-only', () => {
    const { engine, db } = emptyEnv();
    engine.ingestAndProcess([cardEvent('a', 12000, T)]);
    expect(db.value('SELECT COUNT(*) FROM goal_contribution')).toBeGreaterThan(0);
    expect(() => db.run('UPDATE goal_contribution SET amount_delta_minor = 1')).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM goal_contribution')).toThrow(/append-only/);
  });

  it('transaction master financial fields cannot be changed and rows cannot be deleted', () => {
    const { engine, db } = emptyEnv();
    engine.ingestAndProcess([cardEvent('a', 12000, T)]);
    expect(() => db.run("UPDATE txn_master SET customer_id = 'someone-else'")).toThrow();
    expect(() => db.run('DELETE FROM txn_master')).toThrow(/cannot be deleted/);
    expect(db.value('SELECT amount_minor FROM txn_master')).toBe(1_200_000);
  });

  it('the audit log is append-only and its hash chain detects tampering', () => {
    const { db } = emptyEnv();
    expect(db.value('SELECT COUNT(*) FROM audit_log')).toBeGreaterThan(10);
    expect(verifyAuditChain(db).ok).toBe(true);
    expect(() => db.run("UPDATE audit_log SET actor = 'mallory'")).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM audit_log')).toThrow(/append-only/);
    // An attacker with raw database access removes the trigger and rewrites history.
    db.exec('DROP TRIGGER trg_audit_no_update');
    db.run("UPDATE audit_log SET actor = 'mallory' WHERE audit_id = 5");
    const check = verifyAuditChain(db);
    expect(check.ok).toBe(false);
    expect(check.brokenAt).toBe(5);
  });
});

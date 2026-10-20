import { describe, expect, it } from 'vitest';
import { generateBoundaryCases, runScenario, MemoryStateStore } from '../src';
import { engine, ev, Journey, outcome, pointsFor, txn } from './helpers';

const upi = (date: string, amount = 100, over = {}) => txn(date, amount, { channel: 'UPI', ...over });

describe('UPI Transaction Count (bank sets the target)', () => {
  it('caps payments per day, ignores small ones, nudges near the goal and pays once', () => {
    const j = new Journey(engine());
    expect(outcome(j.send(upi('2026-10-01', 20)), 'UPI_STREAK_MASS')).toBe('NOT_MATCHED'); // below ₹50
    for (let i = 0; i < 5; i++) j.send(upi('2026-10-01')); // only 3 count
    expect(j.store.windows().find((w) => w.ruleCode === 'UPI_STREAK_MASS')!.value).toBe(3);
    const r = [j.send(upi('2026-10-02')), j.send(upi('2026-10-02')), j.send(upi('2026-10-02')), j.send(upi('2026-10-03'))];
    expect(r[3].effects.some((e) => e.type === 'NUDGE' && e.kind === 'NEAR_GOAL')).toBe(true); // 7 of 10 = 70%
    j.send(upi('2026-10-03'));
    j.send(upi('2026-10-03'));
    const award = j.send(upi('2026-10-04'));
    expect(outcome(award, 'UPI_STREAK_MASS')).toBe('AWARDED');
    expect(pointsFor(award, 'UPI_STREAK_MASS')).toBe(150);
    expect(outcome(j.send(upi('2026-10-05')), 'UPI_STREAK_MASS')).toBe('GOAL_MET');
    expect(j.points).toBe(150);
  });

  it('claws back when a counted payment is reversed below the target', () => {
    const j = new Journey(engine());
    const ids: string[] = [];
    for (let d = 1; d <= 4; d++) for (let k = 0; k < 3; k++) if (ids.length < 10) ids.push(j.send(upi(`2026-10-0${d}`)).evaluations[0].eventId!);
    expect(j.points).toBe(150);
    const rev = j.send(upi('2026-10-06', 100, { dr_cr: 'C', txn_type: 'REFUND', reversalOf: ids[9] }));
    expect(outcome(rev, 'UPI_STREAK_MASS')).toBe('REVERSED');
    expect(pointsFor(rev, 'UPI_STREAK_MASS')).toBe(-150);
    expect(j.points).toBe(0);
    // the next qualifying payment earns it back
    expect(pointsFor(j.send(upi('2026-10-07')), 'UPI_STREAK_MASS')).toBe(150);
  });

  it('is deterministic: the same events in a different order give the same ledger', () => {
    const events = Array.from({ length: 14 }, (_, i) => upi(`2026-10-${String(1 + (i % 6)).padStart(2, '0')}`, 60 + i));
    const a = new Journey(engine());
    const b = new Journey(engine());
    events.forEach((e) => a.send(e));
    [...events].reverse().forEach((e) => b.send(e));
    events.forEach((e) => b.send(e)); // redelivery
    expect(a.points).toBe(150);
    expect(b.points).toBe(150);
  });
});

describe('balance missions', () => {
  const snap = (date: string, balance: number, id?: string) => ev('BALANCE_SNAPSHOT', date, { account_type: 'SAVINGS', balance, as_of_date: date }, id ? { id } : {});

  it('20 days above ₹10,000 earns on the 20th day; a corrected snapshot claws back', () => {
    const j = new Journey(engine());
    for (let d = 1; d <= 19; d++) j.send(snap(`2026-10-${String(d).padStart(2, '0')}`, 12000));
    j.send(snap('2026-10-20', 9000));
    expect(j.points).toBe(0);
    const r = j.send(snap('2026-10-21', 15000));
    expect(pointsFor(r, 'AMB_DAYS_MASS')).toBe(200);
    // the bank re-sends Oct 5 with a lower balance: only 19 qualifying days remain
    const corr = j.send(snap('2026-10-05', 8000));
    expect(outcome(corr, 'AMB_DAYS_MASS')).toBe('REVERSED');
    expect(j.points).toBe(0);
  });

  it('average monthly balance is paid at month close at the highest tier reached', () => {
    const j = new Journey(engine(), { id: 'C1', segment: 'AFFLUENT' });
    for (let d = 1; d <= 10; d++) j.send(snap(`2026-10-${String(d).padStart(2, '0')}`, d <= 5 ? 1_400_000 : 1_000_000));
    const w = j.store.windows().find((x) => x.ruleCode === 'AMB_AVG_AFFLUENT')!;
    expect(w.value).toBe(1_200_000);
    expect(j.points).toBe(0);
    expect(j.close('2026-11-01').evaluations.filter((e) => e.ruleCode === 'AMB_AVG_AFFLUENT')).toHaveLength(0); // grace day
    const c = j.close('2026-11-02');
    expect(pointsFor(c, 'AMB_AVG_AFFLUENT')).toBe(700); // 300 + 400 top-up (HIGHEST_ONLY)
  });
});

describe('approval-based missions', () => {
  it('referral: rewarded on approval only, once per referral, clawed back on later rejection, capped per year', () => {
    const j = new Journey(engine());
    expect(outcome(j.send(ev('REFERRAL', '2026-10-01', { referral_id: 'R1', status: 'SUBMITTED' })), 'REFERRAL_STD')).toBe('NOT_MATCHED');
    expect(pointsFor(j.send(ev('REFERRAL', '2026-10-03', { referral_id: 'R1', status: 'APPROVED' })), 'REFERRAL_STD')).toBe(500);
    expect(pointsFor(j.send(ev('REFERRAL', '2026-10-04', { referral_id: 'R1', status: 'APPROVED' })), 'REFERRAL_STD')).toBe(0);
    expect(pointsFor(j.send(ev('REFERRAL', '2026-10-09', { referral_id: 'R1', status: 'REJECTED' })), 'REFERRAL_STD')).toBe(-500);
    for (let i = 2; i <= 7; i++) j.send(ev('REFERRAL', '2026-11-01', { referral_id: `R${i}`, status: 'APPROVED' }));
    expect(j.points).toBe(2500); // 5 per year
  });

  it('additional product: once per product family, lifetime maximum', () => {
    const j = new Journey(engine());
    const app = (fam: string) => ev('PRODUCT_APPLICATION', '2026-10-01', { product_family: fam, status: 'APPROVED' });
    expect(pointsFor(j.send(app('CREDIT_CARD')), 'CROSS_SELL_STD')).toBe(300);
    expect(pointsFor(j.send(app('CREDIT_CARD')), 'CROSS_SELL_STD')).toBe(0);
    expect(outcome(j.send(app('SAVINGS')), 'CROSS_SELL_STD')).toBe('OUT_OF_SCOPE');
    j.send(app('INSURANCE'));
    j.send(app('MUTUAL_FUND'));
    expect(outcome(j.send(app('FIXED_DEPOSIT')), 'CROSS_SELL_STD')).toBe('CAPPED');
    expect(j.points).toBe(900);
  });
});

describe('recurring and fixed deposits', () => {
  const inst = (date: string, onTime = true) => ev('RD_INSTALLMENT', date, { account_type: 'RECURRING_DEPOSIT', on_time: onTime }, { accountId: 'RD1' });

  it('RD streak: milestones, a late payment resets, a new streak can earn again', () => {
    const j = new Journey(engine(), { id: 'C1', segment: 'AFFLUENT' });
    j.send(inst('2026-01-05'));
    j.send(inst('2026-01-20')); // same month: no change
    j.send(inst('2026-02-05'));
    expect(pointsFor(j.send(inst('2026-03-05')), 'RD_STREAK_AFFLUENT')).toBe(150);
    expect(outcome(j.send(inst('2026-04-09', false)), 'RD_STREAK_AFFLUENT')).toBe('STREAK_BROKEN');
    j.send(inst('2026-05-05'));
    j.send(inst('2026-06-05'));
    expect(pointsFor(j.send(inst('2026-07-05')), 'RD_STREAK_AFFLUENT')).toBe(150);
    // skip August: restarts at 1
    expect(j.send(inst('2026-09-05')).evaluations.find((e) => e.ruleCode === 'RD_STREAK_AFFLUENT')!.after).toBe(1);
    expect(j.points).toBe(300);
  });

  it('RD completion pays once per RD account', () => {
    const j = new Journey(engine());
    const mat = (acct: string, attrs = {}) => ev('RD_MATURITY', '2026-10-01', { account_type: 'RECURRING_DEPOSIT', status: 'COMPLETED', installments_missed: 0, tenure_months: 12, ...attrs }, { accountId: acct });
    expect(outcome(j.send(mat('RD1', { status: 'PREMATURE_CLOSURE' })), 'RD_COMPLETE_STD')).toBe('NOT_MATCHED');
    expect(pointsFor(j.send(mat('RD1')), 'RD_COMPLETE_STD')).toBe(1000);
    expect(pointsFor(j.send(mat('RD1')), 'RD_COMPLETE_STD')).toBe(0);
    expect(pointsFor(j.send(mat('RD2')), 'RD_COMPLETE_STD')).toBe(1000);
  });

  it('FD renewal earns per ₹10,000 renewed, capped per year', () => {
    const j = new Journey(engine(), { id: 'C1', segment: 'AFFLUENT' });
    const fd = (id: string, amount: number, action = 'RENEW') => ev('FD_MATURITY', '2026-10-01', { maturity_id: id, amount, action, account_type: 'FIXED_DEPOSIT' });
    expect(pointsFor(j.send(fd('M1', 255000)), 'FD_RENEW_AFFLUENT')).toBe(250);
    expect(outcome(j.send(fd('M2', 500000, 'PAYOUT')), 'FD_RENEW_AFFLUENT')).toBe('NOT_MATCHED');
    expect(pointsFor(j.send(fd('M3', 5_000_000)), 'FD_RENEW_AFFLUENT')).toBe(1750);
  });
});

describe('extensions and enrolment', () => {
  it('dormancy win-back only for flagged customers; diversity needs opt-in', () => {
    const at_risk = new Journey(engine(), { id: 'C1', segment: 'MASS', dormancy_risk: true });
    at_risk.send(txn('2026-10-01', 150));
    expect(pointsFor(at_risk.send(txn('2026-10-09', 150)), 'DORMANCY_WINBACK')).toBe(100);
    const normal = new Journey(engine());
    expect(outcome(normal.send(txn('2026-10-01', 150)), 'DORMANCY_WINBACK')).toBe('NOT_ELIGIBLE');

    const j = new Journey(engine());
    const spend = (fam: string) => txn('2026-10-02', 300, { product_family: fam });
    expect(outcome(j.send(spend('CREDIT_CARD')), 'DIVERSITY_STD')).toBe('NOT_ENROLLED');
    j.enrollments.push('DIVERSITY_STD');
    j.send(spend('CREDIT_CARD'));
    j.send(spend('CREDIT_CARD'));
    j.send(spend('DEBIT_CARD'));
    expect(pointsFor(j.send(spend('SAVINGS')), 'DIVERSITY_STD')).toBe(250);
  });
});

describe('generated boundary cases', () => {
  const e = engine();
  for (const r of e.listRules()) {
    it(`${r.code}: all generated cases pass`, () => {
      const cases = generateBoundaryCases(e, r.code);
      expect(cases.length).toBeGreaterThanOrEqual(2);
      for (const sc of cases) {
        const res = runScenario(e, sc, new MemoryStateStore());
        expect(res.failures, `${sc.name}`).toEqual([]);
      }
    });
  }
});

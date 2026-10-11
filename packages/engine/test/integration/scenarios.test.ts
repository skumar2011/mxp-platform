import { beforeAll, describe, expect, it } from 'vitest';
import { runScenario, type DbRuleSource, type SimInput, type SimScenario, type SimStep, type SimTxnStep } from '../../src/index';
import { rulesOnlyDb } from '../helpers';

/**
 * Business-use-case tests. Each one drives the real engine (same code as production) in the isolated simulator
 * with a purpose-built customer history, and asserts the exact XP that results.
 */
let source: DbRuleSource;
beforeAll(() => {
  source = rulesOnlyDb().source;
});

const TZ = 'Asia/Kolkata';
const card = (id: string, at: string, amount: number, extra: Partial<SimTxnStep> = {}): SimTxnStep => ({
  kind: 'TXN', id, at, type: 'PURCHASE', channel: 'CARD_ONLINE', amount, accountRef: 'CC-1', category: 'SHOPPING', ...extra,
});
const upi = (id: string, at: string, amount = 100, extra: Partial<SimTxnStep> = {}): SimTxnStep => ({
  kind: 'TXN', id, at, type: 'MERCHANT_PAYMENT', channel: 'UPI', amount, accountRef: 'SA-1', category: 'GROCERY', ...extra,
});
const bill = (id: string, at: string, amount = 900, extra: Partial<SimTxnStep> = {}): SimTxnStep => ({
  kind: 'TXN', id, at, type: 'BILL_PAYMENT', channel: 'BILLPAY', amount, accountRef: 'SA-1', category: 'UTILITY_BILL', ...extra,
});

function scenario(steps: SimStep[], over: Partial<SimScenario> = {}): SimScenario {
  return {
    timezone: TZ,
    customer: { status: 'ACTIVE', kycStatus: 'FULL', nudgeConsent: true },
    accounts: [{ ref: 'CC-1', productCode: 'CC_GOLD' }, { ref: 'SA-1', productCode: 'SAV_REGULAR', openedOn: '2020-01-01' }],
    steps,
    asOf: '2026-10-10',
    ...over,
  };
}

const run = (rules: string[], sc: SimScenario, expected?: SimInput['expected']) => {
  const res = runScenario(source, { rules: rules.map((ruleCode) => ({ ruleCode })), scenario: sc, expected });
  expect(res.error, JSON.stringify(res.error)).toBeUndefined();
  expect(res.ok).toBe(true);
  return res;
};

describe('use case 2: card spend of ₹10,000 in a month earns 300 XP', () => {
  it('pays nothing one rupee below the threshold', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 6999), card('b', '2026-10-04', 3000)]), { totalPoints: 0 });
    expect(res.final!.progress[0].amount).toBe(9999);
    expect(res.passed).toBe(true);
  });

  it('pays exactly at the threshold, and only once however far past it the customer goes', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 6000), card('b', '2026-10-04', 4000), card('c', '2026-10-05', 500)]), { totalPoints: 300, awards: 1, noDuplicateAwards: true });
    expect(res.passed).toBe(true);
  });

  it('pays the second tier cumulatively', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 25000)]), { totalPoints: 700, achievedTier: { CARD_SPEND_10K: 2 } });
    expect(res.passed).toBe(true);
  });

  it('excludes rent and debit-card style transactions through the rule conditions', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 12000, { category: 'RENT' })]), { totalPoints: 0 });
    expect(res.passed).toBe(true);
  });

  it('does not count spend from the previous month', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-09-28', 8000), card('b', '2026-10-02', 3000)]), { totalPoints: 0 });
    expect(res.passed).toBe(true);
  });

  it('assigns a transaction to the month in the rule time zone, not UTC', () => {
    // 23:45 IST on 30 Sep is 18:15 UTC on 30 Sep; 00:15 IST on 1 Oct is 18:45 UTC on 30 Sep.
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-09-30T23:45', 4000), card('b', '2026-10-01T00:15', 10000)]), { pointsByRule: { CARD_SPEND_10K: 300 } });
    expect(res.final!.progress.find((p) => p.periodKey === '2026-10')!.amount).toBe(10000);
    expect(res.passed).toBe(true);
  });

  it('never rewards a blocked customer', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 30000)], { customer: { status: 'BLOCKED' } }), { totalPoints: 0 });
    expect(res.passed).toBe(true);
  });
});

describe('duplicates, reversals and refunds', () => {
  it('redelivered events do not double count or double reward', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 10000, { repeat: 4, resendAs: 2 })]), { totalPoints: 300, awards: 1, noDuplicateAwards: true, duplicateEvents: 4 });
    expect(res.final!.progress[0].amount).toBe(10000);
    expect(res.passed).toBe(true);
  });

  it('a full reversal claws back the reward', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 10500), { kind: 'REVERSAL', id: 'a-rev', original: 'a', at: '2026-10-03' }]), { totalPoints: 0, awards: 1, reversals: 1 });
    expect(res.passed).toBe(true);
  });

  it('a partial refund that drops spend below the threshold claws back; refunding less does not', () => {
    const below = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 10500), { kind: 'REFUND', id: 'r', original: 'a', at: '2026-10-03', amount: 600 }]), { totalPoints: 0, reversals: 1 });
    expect(below.passed).toBe(true);
    const above = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 10500), { kind: 'REFUND', id: 'r', original: 'a', at: '2026-10-03', amount: 400 }]), { totalPoints: 300, reversals: 0 });
    expect(above.passed).toBe(true);
  });

  it('re-earning after a clawback pays again, exactly once', () => {
    const res = run(['CARD_SPEND_10K'], scenario([
      card('a', '2026-10-02', 10500), { kind: 'REVERSAL', id: 'a-rev', original: 'a', at: '2026-10-03' }, card('b', '2026-10-04', 10500),
    ]), { totalPoints: 300, noDuplicateAwards: true });
    expect(res.passed).toBe(true);
  });

  it('pending transactions do not count until they post', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('a', '2026-10-02', 10500, { status: 'PENDING' }), { kind: 'STATUS', id: 'a', at: '2026-10-03', status: 'POSTED' }]), { totalPoints: 300, outcomes: [{ step: 0, ruleCode: 'CARD_SPEND_10K', outcome: 'NOT_QUALIFYING' }] });
    expect(res.passed).toBe(true);
  });
});

describe('use case 3: ten UPI transactions in a month earn 100 XP', () => {
  const nine = Array.from({ length: 9 }, (_, i) => upi(`u${i}`, `2026-10-0${i + 1}`));
  it('does not pay at nine, pays at ten', () => {
    expect(run(['UPI_10_TXNS'], scenario(nine), { totalPoints: 0 }).passed).toBe(true);
    expect(run(['UPI_10_TXNS'], scenario([...nine, upi('u9', '2026-10-09', 100)]), { totalPoints: 100, awards: 1 }).passed).toBe(true);
  });
  it('ignores self transfers and payments under the minimum amount', () => {
    const res = run(['UPI_10_TXNS'], scenario([...nine, upi('self', '2026-10-09', 500, { category: 'SELF_TRANSFER' }), upi('tiny', '2026-10-09', 5)]), { totalPoints: 0 });
    expect(res.final!.progress[0].count).toBe(9);
    expect(res.passed).toBe(true);
  });
  it('counts ten distinct transactions even when each is delivered twice', () => {
    const ten = Array.from({ length: 10 }, (_, i) => upi(`u${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`, 100, { repeat: 1 }));
    expect(run(['UPI_10_TXNS'], scenario(ten), { totalPoints: 100, noDuplicateAwards: true }).passed).toBe(true);
  });
});

describe('use case 4: three utility bills in the campaign period', () => {
  it('pays at three bills across the campaign window, then at six', () => {
    const three = [bill('b1', '2026-09-20'), bill('b2', '2026-10-02'), bill('b3', '2026-10-05')];
    expect(run(['UTILITY_3_BILLS'], scenario(three.slice(0, 2)), { totalPoints: 0 }).passed).toBe(true);
    expect(run(['UTILITY_3_BILLS'], scenario(three), { totalPoints: 150 }).passed).toBe(true);
    const six = [...three, bill('b4', '2026-10-06'), bill('b5', '2026-10-07'), bill('b6', '2026-10-08')];
    expect(run(['UTILITY_3_BILLS'], scenario(six), { totalPoints: 400 }).passed).toBe(true);
  });
  it('does not count payments of other categories', () => {
    expect(run(['UTILITY_3_BILLS'], scenario([bill('b1', '2026-10-01'), bill('b2', '2026-10-02'), bill('b3', '2026-10-03', 900, { category: 'TELECOM' })]), { totalPoints: 0 }).passed).toBe(true);
  });
});

describe('use cases 1 and 5: balance and savings growth', () => {
  const balances = (start: string, end: string, amount: number): SimStep => ({ kind: 'BALANCE', account: 'SA-1', date: start, toDate: end, balance: amount });

  it('awards 500 XP for an average balance of ₹50,000 once the month closes', () => {
    const res = run(['SAV_AVG_BAL_50K'], scenario([balances('2026-09-01', '2026-09-30', 50000)]), { pointsByRule: { SAV_AVG_BAL_50K: 500 } });
    expect(res.passed).toBe(true);
  });
  it('pays nothing at ₹49,999 average', () => {
    expect(run(['SAV_AVG_BAL_50K'], scenario([balances('2026-09-01', '2026-09-30', 49999)]), { totalPoints: 0 }).passed).toBe(true);
  });
  it('uses the average over the month, so a late spike is not enough', () => {
    const res = run(['SAV_AVG_BAL_50K'], scenario([balances('2026-09-01', '2026-09-24', 10000), balances('2026-09-25', '2026-09-30', 200000)]), { totalPoints: 0 });
    expect(res.passed).toBe(true);
  });
  it('awards 400 XP for savings growth of ₹25,000 and nothing for ₹24,999', () => {
    const grow = (end: number) => scenario([balances('2026-08-31', '2026-08-31', 40000), balances('2026-09-01', '2026-09-29', 41000), balances('2026-09-30', '2026-09-30', end)]);
    expect(run(['SAV_GROWTH_25K'], grow(65000), { totalPoints: 400 }).passed).toBe(true);
    expect(run(['SAV_GROWTH_25K'], grow(64999), { totalPoints: 0 }).passed).toBe(true);
  });
});

describe('use case 6: combined goals earn a higher reward', () => {
  const savings: SimStep = { kind: 'BALANCE', account: 'SA-1', date: '2026-09-01', toDate: '2026-09-30', balance: 60000 };
  it('pays the combined reward only when both component goals are met in the month', () => {
    const both = run(['SAV_AVG_BAL_50K', 'CARD_SPEND_10K', 'BALANCE_PLUS_CARD'], scenario([savings, card('a', '2026-09-10', 11000)]), { pointsByRule: { SAV_AVG_BAL_50K: 500, CARD_SPEND_10K: 300, BALANCE_PLUS_CARD: 1000 } });
    expect(both.passed).toBe(true);
    const one = run(['SAV_AVG_BAL_50K', 'CARD_SPEND_10K', 'BALANCE_PLUS_CARD'], scenario([savings, card('a', '2026-09-10', 9000)]), { pointsByRule: { SAV_AVG_BAL_50K: 500, CARD_SPEND_10K: 0, BALANCE_PLUS_CARD: 0 } });
    expect(one.passed).toBe(true);
  });
  it('withdraws the combined reward if a component is reversed', () => {
    const res = run(['SAV_AVG_BAL_50K', 'CARD_SPEND_10K', 'BALANCE_PLUS_CARD'], scenario([savings, card('a', '2026-10-02', 11000), { kind: 'REVERSAL', id: 'r', original: 'a', at: '2026-10-03' }]), { totalPoints: 500 });
    expect(res.passed).toBe(true);
  });
});

describe('per-event rules, caps and rule interaction', () => {
  it('the per-event rule pays 1 XP per ₹100 and stops at its monthly cap', () => {
    // not live: simulate the stored pending version explicitly
    const res = runScenario(source, {
      rules: [{ ruleCode: 'UPI_MERCHANT_PER_TXN', versionNo: 1 }],
      scenario: scenario([upi('m1', '2026-10-02', 15000), upi('m2', '2026-10-03', 9000)]),
      expected: { totalPoints: 200, noDuplicateAwards: true },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.passed).toBe(true);
  });
  it('several rules run side by side without interfering', () => {
    const steps: SimStep[] = [card('a', '2026-10-02', 12000), ...Array.from({ length: 10 }, (_, i) => upi(`u${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`))];
    const res = run(['CARD_SPEND_10K', 'UPI_10_TXNS'], scenario(steps), { pointsByRule: { CARD_SPEND_10K: 300, UPI_10_TXNS: 100 }, noDuplicateAwards: true });
    expect(res.passed).toBe(true);
  });
});

describe('data quality', () => {
  it('rejects an invalid event with a reason and does not affect results', () => {
    const res = run(['CARD_SPEND_10K'], scenario([card('bad', '2026-10-02', -5, { type: 'NOT_A_TYPE' }), card('a', '2026-10-03', 10000)]), { totalPoints: 300, rejectedEvents: 1 });
    expect(res.passed).toBe(true);
  });
  it('is deterministic: the same scenario gives byte-identical outcomes', () => {
    const sc = scenario([card('a', '2026-10-02', 12000), { kind: 'REFUND', id: 'r', original: 'a', at: '2026-10-04', amount: 3000 }]);
    const a = run(['CARD_SPEND_10K'], sc);
    const b = run(['CARD_SPEND_10K'], sc);
    expect(b.final!.ledger.map((l) => [l.type, l.points, l.slot])).toEqual(a.final!.ledger.map((l) => [l.type, l.points, l.slot]));
    expect(b.final!.totalPoints).toBe(a.final!.totalPoints);
  });
});

import { describe, expect, it } from 'vitest';
import { MemoryStateStore } from '../src';
import { engine, Journey, outcome, pointsFor, txn, at } from './helpers';

describe('Daily Spend Limit (customer sets the limit)', () => {
  it('allows, warns, blocks in pre-auth, breaches, and forfeits the day', () => {
    const j = new Journey(engine()).set('DSL_MASS', { limit: 3000 });
    expect(outcome(j.send(txn('2026-10-05', 1000)), 'DSL_MASS')).toBe('WITHIN_LIMIT');
    const warn = j.send(txn('2026-10-05', 1500));
    expect(outcome(warn, 'DSL_MASS')).toBe('WARNING'); // 2,500 >= 80% of 3,000
    expect(warn.decision).toBe('WARN');
    expect(warn.effects.some((e) => e.type === 'NUDGE' && e.kind === 'LIMIT_WARNING')).toBe(true);

    // pre-auth check: would breach -> ALERT, but nothing is stored
    const pre = j.check(txn('2026-10-05', 600));
    expect(pre.decision).toBe('ALERT');
    expect(j.store.windows()[0].value).toBe(2500);

    const b = j.send(txn('2026-10-05', 600));
    expect(outcome(b, 'DSL_MASS')).toBe('BREACH');
    expect(b.effects.find((e) => e.type === 'BREACH')).toMatchObject({ limit: 3000, value: 3100, action: 'ALERT' });

    const close = j.close('2026-10-06');
    expect(outcome(close, 'DSL_MASS')).toBe('BREACHED');
    expect(j.points).toBe(0);
  });

  it('pays the compliance reward when the day closes within the limit, once', () => {
    const j = new Journey(engine()).set('DSL_MASS', { limit: 3000 });
    j.send(txn('2026-10-05', 3000));
    expect(j.close('2026-10-05').evaluations).toHaveLength(0); // the day is not over
    const c = j.close('2026-10-06');
    expect(outcome(c, 'DSL_MASS')).toBe('COMPLIANT');
    expect(pointsFor(c, 'DSL_MASS')).toBe(10);
    expect(j.close('2026-10-07').evaluations).toHaveLength(0);
    expect(j.points).toBe(10);
  });

  it('ignores out-of-scope spend, duplicates and does not pay for inactivity', () => {
    const j = new Journey(engine()).set('DSL_MASS', { limit: 3000 });
    expect(outcome(j.send(txn('2026-10-05', 9000, { channel: 'ATM' })), 'DSL_MASS')).toBe('OUT_OF_SCOPE');
    expect(outcome(j.send(txn('2026-10-05', 9000, { txn_type: 'SELF_TRANSFER' })), 'DSL_MASS')).toBe('OUT_OF_SCOPE');
    const t = txn('2026-10-05', 1000);
    j.send(t);
    expect(outcome(j.send(t), 'DSL_MASS')).toBe('DUPLICATE');
    expect(j.store.windows()[0].value).toBe(1000);
    // no setting -> the control does not apply at all
    const nobody = new Journey(engine());
    expect(nobody.send(txn('2026-10-05', 99999)).evaluations.filter((e) => e.ruleCode === 'DSL_MASS')).toHaveLength(0);
  });

  it('applies segment eligibility and re-checks bounds at evaluation time', () => {
    const j = new Journey(engine(), { id: 'C1', segment: 'AFFLUENT' }).set('DSL_MASS', { limit: 3000 });
    expect(outcome(j.send(txn('2026-10-05', 100)), 'DSL_MASS')).toBe('NOT_ELIGIBLE');
    const k = new Journey(engine()).set('DSL_MASS', { limit: 90000 });
    expect(outcome(k.send(txn('2026-10-05', 100)), 'DSL_MASS')).toBe('INVALID_SETTING');
  });

  it('a refund lowers the running total but a recorded breach stands', () => {
    const j = new Journey(engine()).set('DSL_MASS', { limit: 3000 });
    const big = txn('2026-10-05', 3500);
    expect(outcome(j.send(big), 'DSL_MASS')).toBe('BREACH');
    const refund = txn('2026-10-05', 3500, { dr_cr: 'C', txn_type: 'REFUND', reversalOf: big.id });
    const r = j.send(refund);
    expect(outcome(r, 'DSL_MASS')).toBe('REVERSED');
    expect(j.store.windows()[0].value).toBe(0);
    expect(outcome(j.close('2026-10-06'), 'DSL_MASS')).toBe('BREACHED');
  });

  it('a cancelled setting forfeits the open window', () => {
    const j = new Journey(engine()).set('DSL_MASS', { limit: 3000 });
    j.send(txn('2026-10-05', 100));
    j.settings[0] = { ...j.settings[0], status: 'CANCELLED' };
    expect(outcome(j.close('2026-10-06'), 'DSL_MASS')).toBe('CANCELLED');
    expect(j.points).toBe(0);
  });
});

describe('setting changes', () => {
  const e = engine();
  it('NEXT_WINDOW policy starts tomorrow for a daily limit and next month for a monthly limit', () => {
    expect(e.planSettingChange('DSL_MASS', { limit: 3000 }, { now: at('2026-10-14', '18:00') }).effectiveFrom).toBe('2026-10-15');
    expect(e.planSettingChange('MSL_STANDARD', { limit: 50000 }, { now: at('2026-10-14') }).effectiveFrom).toBe('2026-11-01');
    expect(e.planSettingChange('MERCHANT_BLOCK_STD', { merchants: ['M_BETWAY'] }, { now: at('2026-10-14') }).effectiveFrom).toBe('2026-10-14');
  });
  it('enforces the cooldown', () => {
    const p = e.planSettingChange('MSL_STANDARD', { limit: 60000 }, { now: at('2026-10-14'), lastChangedAt: at('2026-10-10') });
    expect(p.issues.map((i) => i.code)).toContain('COOLDOWN');
  });
  it('uses the setting version effective on the event date', () => {
    const j = new Journey(engine())
      .set('DSL_MASS', { limit: 3000 }, { settingId: 'S1', version: 1, effectiveFrom: '2026-10-01' })
      .set('DSL_MASS', { limit: 5000 }, { settingId: 'S1', version: 2, effectiveFrom: '2026-10-15' });
    expect(outcome(j.send(txn('2026-10-14', 4000)), 'DSL_MASS')).toBe('BREACH');
    expect(outcome(j.send(txn('2026-10-15', 4000)), 'DSL_MASS')).toBe('WARNING');
  });
});

describe('restrictions', () => {
  it('blocks a merchant the customer chose; other merchants are activity', () => {
    const j = new Journey(engine()).set('MERCHANT_BLOCK_STD', { merchants: ['M_BETWAY', 'M_DREAM11'] });
    expect(j.check(txn('2026-10-05', 500, { merchant_id: 'M_BETWAY' })).decision).toBe('BLOCK');
    for (let i = 0; i < 5; i++) expect(j.send(txn('2026-10-05', 100, { merchant_id: 'M_SWIGGY' })).decision).toBe('ALLOW');
    const c = j.close('2026-11-01');
    expect(outcome(c, 'MERCHANT_BLOCK_STD')).toBe('COMPLIANT');
    expect(j.points).toBe(25);
  });

  it('needs minimum activity before paying for a clean period', () => {
    const j = new Journey(engine()).set('TXN_TYPE_BLOCK_STD', { blockedTypes: ['ATM_WITHDRAWAL'] });
    for (let i = 0; i < 4; i++) j.send(txn('2026-10-05', 100));
    expect(outcome(j.close('2026-11-01'), 'TXN_TYPE_BLOCK_STD')).toBe('NO_ACTIVITY');
  });

  it('blocks cash withdrawals and takes the strictest decision across controls', () => {
    const j = new Journey(engine()).set('TXN_TYPE_BLOCK_STD', { blockedTypes: ['ATM_WITHDRAWAL'] }).set('DSL_MASS', { limit: 500 });
    const r = j.check(txn('2026-10-05', 2000, { txn_type: 'ATM_WITHDRAWAL', channel: 'UPI' }));
    expect(r.decision).toBe('BLOCK'); // DSL says ALERT, type restriction says BLOCK
    expect(r.evaluations.filter((e) => e.family === 'SPEND_CONTROL').map((e) => e.decision).sort()).toEqual(['ALERT', 'BLOCK']);
  });

  it('timing restriction wraps midnight and uses the customer timezone', () => {
    const ny = new Journey(engine(), { id: 'C1', segment: 'MASS', timezone: 'America/New_York' }).set('TIMING_STD', { from: '23:00', to: '06:00' });
    // 23:30 in New York is 09:00 next day in India: still a breach for this customer
    const late = { ...txn('2026-10-05', 100), timestamp: '2026-10-06T03:30:00.000Z' };
    expect(outcome(ny.send(late), 'TIMING_STD')).toBe('BREACH');
    // 07:00 in New York
    expect(outcome(ny.send({ ...txn('2026-10-05', 100), timestamp: '2026-10-05T11:00:00.000Z' }), 'TIMING_STD')).toBe('NOT_MATCHED');
    // the same instant for an India-based customer is 09:00: allowed
    const ind = new Journey(engine()).set('TIMING_STD', { from: '23:00', to: '06:00' });
    expect(outcome(ind.send({ ...late, id: 'x' }), 'TIMING_STD')).toBe('NOT_MATCHED');
  });
});

describe('category and rolling limits', () => {
  it('only the chosen categories count against the limit', () => {
    const j = new Journey(engine()).set('CSL_MASS', { categories: ['FOOD_GROCERY'], limit: 2000 });
    expect(outcome(j.send(txn('2026-10-05', 5000, { category: 'TRAVEL' })), 'CSL_MASS')).toBe('NOT_MATCHED');
    expect(outcome(j.send(txn('2026-10-06', 1900, { category: 'FOOD_GROCERY' })), 'CSL_MASS')).toBe('WARNING');
    expect(outcome(j.send(txn('2026-10-07', 200, { category: 'FOOD_GROCERY' })), 'CSL_MASS')).toBe('BREACH');
  });

  it('rolling 30-day limit looks back across months; rewards are tracked per calendar month', () => {
    const j = new Journey(engine(), { id: 'C1', segment: 'AFFLUENT' }).set('MSL_ROLLING_AFFLUENT', { limit: 500000 });
    j.send(txn('2026-10-01', 300000));
    expect(outcome(j.send(txn('2026-10-20', 250000)), 'MSL_ROLLING_AFFLUENT')).toBe('BREACH'); // 550k in 30 days
    // Nov 5: the Oct 1 spend has rolled off; 250k + 100k = 350k
    const nov = j.send(txn('2026-11-05', 100000));
    expect(outcome(nov, 'MSL_ROLLING_AFFLUENT')).toBe('WITHIN_LIMIT');
    expect(nov.evaluations.find((e) => e.ruleCode === 'MSL_ROLLING_AFFLUENT')!.after).toBe(350000);
    for (let i = 0; i < 4; i++) j.send(txn('2026-11-20', 1000));
    const close = j.close('2026-12-01');
    const byWindow = Object.fromEntries(close.evaluations.filter((e) => e.ruleCode === 'MSL_ROLLING_AFFLUENT').map((e) => [e.windowKey, e.outcome]));
    expect(byWindow).toEqual({ '2026-10': 'BREACHED', '2026-11': 'COMPLIANT' });
    expect(j.points).toBe(150);
  });
});

describe('store contract', () => {
  it('check() never writes; process() writes window, lifetime and index keys', () => {
    const store = new MemoryStateStore();
    const e = engine();
    const ctx = { customer: { id: 'C1', segment: 'MASS' }, settings: [{ settingId: 'S', customerId: 'C1', ruleCode: 'DSL_MASS', values: { limit: 3000 } }] };
    e.check(txn('2026-10-05', 100), ctx, store);
    expect(store.dirty()).toEqual([]);
    e.process(txn('2026-10-05', 100), ctx, store);
    const keys = store.dirty().map(([k]) => k.split('|')[0]);
    expect(new Set(keys)).toEqual(new Set(['w', 'l', 'x']));
  });
});

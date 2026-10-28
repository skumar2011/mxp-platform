import { addDays, DEFAULT_REFERENCES, humanize, localParts, zonedToIso, type Scenario } from '@mxp/rules';
import { CATALOG_TEMPLATES, SAMPLE_REFERENCES, SAMPLE_RULES } from '@mxp/rules/catalog';
import type { Mxp } from './mxp';
import type { EventInput } from './runtime';
import type { Actor } from './util';

export const DEMO_PASSWORD = 'Mxp@Demo1';
const IST = 'Asia/Kolkata';

const USERS: [string, string, string[]][] = [
  ['maker', 'Maya Maker', ['RULE_MAKER']],
  ['checker', 'Chetan Checker', ['RULE_APPROVER']],
  ['qa', 'Quinn QA', ['QA_ENGINEER']],
  ['ops', 'Omar Operations', ['OPERATIONS']],
  ['auditor', 'Asha Auditor', ['AUDITOR']],
  ['admin', 'Admin', ['SYSTEM_ADMIN']],
];

const SEGMENTS: [string, string, string][] = [
  ['MASS', 'Mass', 'Everyday banking customers; emphasis on food and groceries.'],
  ['AFFLUENT', 'Affluent', 'High-balance customers; emphasis on travel and dining.'],
  ['YOUTH', 'Youth', 'Students and first jobbers; UPI-first.'],
  ['SENIOR', 'Senior', 'Senior citizens; deposits and safety.'],
];

const MERCHANTS: [string, string, string][] = [
  ['M_SWIGGY', 'Swiggy', 'FOOD_GROCERY'], ['M_ZOMATO', 'Zomato', 'DINING'], ['M_AMAZON', 'Amazon', 'SHOPPING'], ['M_FLIPKART', 'Flipkart', 'SHOPPING'],
  ['M_DREAM11', 'Dream11', 'GAMBLING'], ['M_BETWAY', 'Betway', 'GAMBLING'], ['M_MAKEMYTRIP', 'MakeMyTrip', 'TRAVEL'], ['M_BIGBASKET', 'BigBasket', 'FOOD_GROCERY'],
  ['M_UBER', 'Uber', 'TRAVEL'], ['M_NETFLIX', 'Netflix', 'ENTERTAINMENT'],
];

/** Deterministic PRNG so every seed produces the same history. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedOptions {
  /** Days of history ending yesterday. */
  days?: number;
  log?: (msg: string) => void;
}

export function seed(mx: Mxp, opts: SeedOptions = {}) {
  const log = opts.log ?? (() => {});
  const days = opts.days ?? 21;
  const pw = DEMO_PASSWORD;
  const system: Actor = { username: 'system', roles: ['SYSTEM_ADMIN'] };
  const now = mx.clock.now().toISOString();
  const db = mx.db;

  // ---- users, reference data ----
  for (const [u, n, r] of USERS) mx.createUser(u, n, pw, r);
  const actor = (u: string) => mx.user(u);
  const maker = actor('maker'), ops = actor('ops'), qa = actor('qa');
  void ops;

  db.tx(() => {
    SEGMENTS.forEach(([c, n, d], i) => db.run('INSERT INTO segment(segment_code, name, description, sort_order) VALUES (?,?,?,?)', c, n, d, i));
    const lists = { ...DEFAULT_REFERENCES, ...SAMPLE_REFERENCES };
    for (const [list, values] of Object.entries(lists)) {
      if (list === 'segments') continue;
      values.forEach((v, i) => {
        const label = list === 'merchants' ? MERCHANTS.find((m) => m[0] === v)?.[1] ?? v : humanize(v).replace(/^\w/, (s) => s.toUpperCase());
        db.run('INSERT INTO reference_value(list_code, value_code, label, sort_order) VALUES (?,?,?,?)', list, v, label, i);
      });
    }
    for (const [id, name, cat] of MERCHANTS) db.run('INSERT INTO merchant(merchant_id, name, category_code) VALUES (?,?,?)', id, name, cat);
  });
  log('reference data');

  // ---- catalogue: templates are files in @mxp/rules; rules are one DB row each ----
  for (const r of SAMPLE_RULES) mx.catalog.upsertLive(r, maker, 'Initial configuration');
  log(`${CATALOG_TEMPLATES.length} templates (package), ${SAMPLE_RULES.length} rules live`);

  // One draft left open so the admin queue is not empty.
  const upi = SAMPLE_RULES.find((r) => r.code === 'UPI_STREAK_MASS')!;
  mx.catalog.saveRule({ ...upi, code: 'UPI_STREAK_SENIOR', name: 'UPI starter mission (Senior)', segments: ['SENIOR'], featured: false, params: { ...upi.params, target: 5, points: 100 } }, maker, 'Pilot for seniors');

  // ---- customers ----
  const today = localParts(now, IST).date;
  const start = addDays(today, -days);
  const created = addDays(start, -400);
  const P = mx.participation;
  const persona = (id: string, name: string, segment: string, tz: string, state: string, accounts: [string, string, string][], extra: { dormancyRisk?: boolean; attributes?: Record<string, unknown> } = {}) =>
    P.createCustomer({
      customerId: id, customerRef: `CIF-${id.slice(1)}`, displayName: name, segment, stateCode: state, timezone: tz, dormancyRisk: extra.dormancyRisk, attributes: extra.attributes, createdAt: `${created}T04:00:00.000Z`,
      accounts: accounts.map(([suffix, type, family]) => ({ accountId: `${id}-${suffix}`, accountRef: `XX${id.slice(1)}${suffix}`, accountType: type, productFamily: family, stateCode: state, openedOn: created })),
    }, system);

  persona('C1001', 'Anita R.', 'MASS', IST, 'MH', [['SA', 'SAVINGS', 'SAVINGS'], ['RD', 'RECURRING_DEPOSIT', 'RECURRING_DEPOSIT'], ['DC', 'SAVINGS', 'DEBIT_CARD']]);
  persona('C1002', 'Vikram S.', 'AFFLUENT', IST, 'KA', [['SA', 'SAVINGS', 'SAVINGS'], ['RD', 'RECURRING_DEPOSIT', 'RECURRING_DEPOSIT'], ['FD', 'FIXED_DEPOSIT', 'FIXED_DEPOSIT'], ['CC', 'CREDIT_CARD', 'CREDIT_CARD']]);
  persona('C1003', 'Riya K.', 'YOUTH', IST, 'MH', [['SA', 'SAVINGS', 'SAVINGS'], ['DC', 'SAVINGS', 'DEBIT_CARD']]);
  persona('C1004', 'David M.', 'AFFLUENT', 'America/New_York', 'DL', [['SA', 'SAVINGS', 'SAVINGS'], ['CC', 'CREDIT_CARD', 'CREDIT_CARD']], { attributes: { home_country: 'US' } });
  persona('C1005', 'Suresh P.', 'MASS', IST, 'TN', [['SA', 'SAVINGS', 'SAVINGS']], { dormancyRisk: true });
  persona('C1006', 'Meera N.', 'SENIOR', IST, 'GJ', [['SA', 'SAVINGS', 'SAVINGS'], ['RD', 'RECURRING_DEPOSIT', 'RECURRING_DEPOSIT']]);
  log('6 customers');

  // ---- customer-set spend controls (backdated to the start of the history) ----
  const set = (c: string, rule: string, values: Record<string, unknown>) => P.setControl(c, rule, values, system, { via: 'SEED', effectiveFrom: start, reason: 'Seeded preference' });
  set('C1001', 'DSL_MASS', { limit: 3000 });
  set('C1001', 'CSL_MASS', { categories: ['FOOD_GROCERY', 'DINING'], limit: 8000 });
  set('C1001', 'TIMING_STD', { from: '23:00', to: '06:00' });
  set('C1002', 'DSL_AFFLUENT', { limit: 200000 });
  set('C1002', 'MSL_ROLLING_AFFLUENT', { limit: 500000 });
  set('C1002', 'CSL_AFFLUENT', { categories: ['TRAVEL', 'DINING'], limit: 150000 });
  set('C1002', 'MERCHANT_BLOCK_STD', { merchants: ['M_DREAM11', 'M_BETWAY'] });
  set('C1003', 'DSL_MASS', { limit: 1500 });
  set('C1003', 'TXN_TYPE_BLOCK_STD', { blockedTypes: ['ATM_WITHDRAWAL'] });
  set('C1004', 'DSL_AFFLUENT', { limit: 50000 });
  set('C1004', 'TIMING_STD', { from: '23:00', to: '06:00' });
  set('C1006', 'MSL_STANDARD', { limit: 30000 });
  P.enroll('C1003', 'DIVERSITY_STD', system, 'SEED');

  // ---- event history ----
  const events: Array<EventInput & { customerId: string }> = [];
  const n: Record<string, number> = {};
  const add = (c: string, date: string, hhmm: string, tz: string, attrs: Record<string, unknown>) => {
    n[c] = (n[c] ?? 0) + 1;
    const e = { sourceSystem: 'CORE', sourceEventId: `${c}-${String(n[c]).padStart(4, '0')}`, customerId: c, accountId: `${c}-SA`, timestamp: zonedToIso(date, hhmm, tz), ...attrs } as EventInput & { customerId: string };
    events.push(e);
    return e.sourceEventId!;
  };
  const txn = (c: string, date: string, hhmm: string, amount: number, o: Record<string, unknown> = {}, tz = IST) =>
    add(c, date, hhmm, tz, { type: 'TRANSACTION', amount, dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', category: 'FOOD_GROCERY', product_family: 'SAVINGS', accountId: `${c}-SA`, ...o });
  const bal = (c: string, date: string, balance: number, type = 'SAVINGS', suffix = 'SA') =>
    add(c, date, '23:55', IST, { type: 'BALANCE_SNAPSHOT', accountId: `${c}-${suffix}`, account_type: type, balance, as_of_date: date });
  const r = rng(42);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const amt = (lo: number, hi: number, step = 10) => Math.round((lo + r() * (hi - lo)) / step) * step;

  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const dom = Number(d.slice(8, 10));
    // Anita: groceries on UPI, occasional dining on card; one over-limit day, one late-night order, one refund.
    for (let k = 0; k < 1 + (i % 3); k++) txn('C1001', d, `${10 + k * 3}:${pick(['05', '20', '40'])}`, amt(120, 700), { merchant_id: pick(['M_BIGBASKET', 'M_SWIGGY']), merchant_name: 'Groceries' });
    if (i % 3 === 0) txn('C1001', d, '20:15', amt(300, 900), { channel: 'CARD_POS', category: 'DINING', product_family: 'DEBIT_CARD', accountId: 'C1001-DC', merchant_id: 'M_ZOMATO' });
    if (i === 9) txn('C1001', d, '16:30', 2600, { channel: 'CARD_ONLINE', category: 'SHOPPING', product_family: 'DEBIT_CARD', accountId: 'C1001-DC', merchant_id: 'M_AMAZON', merchant_name: 'Amazon' });
    if (i === 15) txn('C1001', d, '23:40', 450, { merchant_id: 'M_SWIGGY', merchant_name: 'Swiggy (late night)' });
    if (i === 5) {
      const id = txn('C1001', d, '18:00', 1200, { channel: 'CARD_ONLINE', category: 'SHOPPING', product_family: 'DEBIT_CARD', accountId: 'C1001-DC', merchant_id: 'M_FLIPKART' });
      add('C1001', addDays(d, 1), '11:00', IST, { type: 'TRANSACTION', amount: 1200, dr_cr: 'C', channel: 'CARD_ONLINE', txn_type: 'REFUND', category: 'SHOPPING', product_family: 'DEBIT_CARD', accountId: 'C1001-DC', merchant_id: 'M_FLIPKART', reversalOf: id });
    }
    bal('C1001', d, i % 7 === 3 ? 8500 : amt(10500, 16000, 100));
    if (dom === 5) add('C1001', d, '09:00', IST, { type: 'RD_INSTALLMENT', accountId: 'C1001-RD', account_type: 'RECURRING_DEPOSIT', installment_no: 7, on_time: true, amount: 2000 });

    // Vikram: affluent card spend on travel and dining; one very large travel day.
    txn('C1002', d, '13:10', amt(2000, 25000, 100), { channel: 'CARD_ONLINE', category: pick(['TRAVEL', 'DINING', 'SHOPPING']), product_family: 'CREDIT_CARD', accountId: 'C1002-CC', merchant_id: pick(['M_MAKEMYTRIP', 'M_ZOMATO', 'M_AMAZON']) });
    if (i % 2 === 0) txn('C1002', d, '19:45', amt(1500, 9000, 100), { channel: 'CARD_POS', category: 'DINING', product_family: 'CREDIT_CARD', accountId: 'C1002-CC' });
    if (i === 11) {
      txn('C1002', d, '09:30', 185000, { channel: 'CARD_ONLINE', category: 'TRAVEL', product_family: 'CREDIT_CARD', accountId: 'C1002-CC', merchant_id: 'M_MAKEMYTRIP', merchant_name: 'MakeMyTrip – Europe trip' });
      txn('C1002', d, '21:00', 22000, { channel: 'CARD_POS', category: 'DINING', product_family: 'CREDIT_CARD', accountId: 'C1002-CC' });
    }
    if (i === 14) txn('C1002', d, '22:10', 2000, { channel: 'CARD_ONLINE', category: 'GAMBLING', product_family: 'CREDIT_CARD', accountId: 'C1002-CC', merchant_id: 'M_BETWAY', merchant_name: 'Betway' });
    bal('C1002', d, amt(550000, 900000, 1000));
    if (dom === 10) add('C1002', d, '09:00', IST, { type: 'RD_INSTALLMENT', accountId: 'C1002-RD', account_type: 'RECURRING_DEPOSIT', installment_no: 4, on_time: true, amount: 25000 });
    if (i === 12) add('C1002', d, '10:00', IST, { type: 'FD_MATURITY', accountId: 'C1002-FD', account_type: 'FIXED_DEPOSIT', action: 'RENEW', amount: 500000, maturity_id: 'MAT-2026-0042', tenure_months: 12 });
    if (i === 4) add('C1002', d, '15:00', IST, { type: 'REFERRAL', accountId: 'C1002-SA', referral_id: 'REF-7781', status: 'SUBMITTED', referee_ref: 'masked' });
    if (i === 8) add('C1002', d, '15:00', IST, { type: 'REFERRAL', accountId: 'C1002-SA', referral_id: 'REF-7781', status: 'APPROVED', referee_ref: 'masked' });
    if (i === 6) add('C1002', d, '12:00', IST, { type: 'PRODUCT_APPLICATION', accountId: 'C1002-SA', application_id: 'APP-5521', product_family: 'INSURANCE', status: 'APPROVED' });

    // Riya: lots of small UPI payments (the UPI mission caps 3 per day), one blocked ATM withdrawal.
    for (let k = 0; k < 2 + (i % 3); k++) txn('C1003', d, `${9 + k * 2}:${pick(['10', '35', '50'])}`, amt(60, 380), { category: pick(['FOOD_GROCERY', 'DINING', 'ENTERTAINMENT']), payee_id: `P${k}` });
    if (i % 4 === 1) txn('C1003', d, '18:30', amt(250, 800), { channel: 'CARD_POS', category: 'SHOPPING', product_family: 'DEBIT_CARD', accountId: 'C1003-DC' });
    if (i === 7) txn('C1003', d, '17:00', 2000, { channel: 'ATM', txn_type: 'ATM_WITHDRAWAL', category: 'OTHER', product_family: 'DEBIT_CARD', accountId: 'C1003-DC' });
    if (i === 10) txn('C1003', d, '20:00', 900, { channel: 'CARD_ONLINE', category: 'SHOPPING', product_family: 'CREDIT_CARD', accountId: 'C1003-DC' });
    bal('C1003', d, amt(6000, 14000, 100));

    // David (New York): daytime spend in his own timezone, one late-night purchase.
    txn('C1004', d, '12:30', amt(3000, 30000, 100), { channel: 'CARD_POS', category: pick(['DINING', 'SHOPPING', 'TRAVEL']), product_family: 'CREDIT_CARD', accountId: 'C1004-CC', international: true }, 'America/New_York');
    if (i === 13) txn('C1004', d, '23:30', 4200, { channel: 'CARD_ONLINE', category: 'ENTERTAINMENT', product_family: 'CREDIT_CARD', accountId: 'C1004-CC', merchant_id: 'M_NETFLIX', international: true }, 'America/New_York');
    bal('C1004', d, amt(250000, 400000, 1000));

    // Suresh: dormant until the last few days.
    if (i === days - 4 || i === days - 2) txn('C1005', d, '11:00', amt(150, 600));

    // Meera: steady card spend, RD maturity, a referral.
    if (i % 2 === 1) txn('C1006', d, '11:30', amt(800, 3500, 50), { channel: 'CARD_POS', category: pick(['FOOD_GROCERY', 'HEALTH', 'UTILITIES']), product_family: 'DEBIT_CARD' });
    bal('C1006', d, amt(80000, 120000, 1000));
    if (i === 10) add('C1006', d, '10:00', IST, { type: 'RD_MATURITY', accountId: 'C1006-RD', account_type: 'RECURRING_DEPOSIT', status: 'COMPLETED', installments_missed: 0, tenure_months: 12 });
    if (i === 3) add('C1006', d, '16:00', IST, { type: 'REFERRAL', accountId: 'C1006-SA', referral_id: 'REF-9910', status: 'APPROVED' });
  }

  // Ensure every event has an account (account-centric model).
  for (const e of events) {
    if (!e.accountId) e.accountId = `${e.customerId}-SA`;
  }

  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let failed = 0;
  for (const e of events) if (mx.runtime.ingest(e as EventInput, system).status === 'FAILED') failed++;
  log(`${events.length} events processed${failed ? ` (${failed} failed)` : ''}`);

  const closed = mx.runtime.closeWindows(ops);
  log(`${closed.closed} windows closed, ${closed.points} points`);

  // A customer changing their mind: takes effect from the next window.
  P.setControl('C1001', 'DSL_MASS', { limit: 2500 }, { username: 'C1001', roles: [] }, { via: 'APP', reason: 'Tighter budget this month' });

  // Real-time checks as a card switch would make them.
  const at = new Date(mx.clock.now().getTime() - 3600_000).toISOString();
  mx.runtime.check({ customerId: 'C1002', accountId: 'C1002-CC', type: 'TRANSACTION', timestamp: at, amount: 1500, dr_cr: 'D', channel: 'CARD_ONLINE', txn_type: 'PURCHASE', category: 'GAMBLING', merchant_id: 'M_DREAM11', product_family: 'CREDIT_CARD', requestId: 'AUTH-1001' });
  mx.runtime.check({ customerId: 'C1003', accountId: 'C1003-DC', type: 'TRANSACTION', timestamp: at, amount: 1000, dr_cr: 'D', channel: 'ATM', txn_type: 'ATM_WITHDRAWAL', category: 'OTHER', product_family: 'DEBIT_CARD', requestId: 'AUTH-1002' });
  mx.runtime.check({ customerId: 'C1001', accountId: 'C1001-SA', type: 'TRANSACTION', timestamp: at, amount: 600, dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', category: 'FOOD_GROCERY', product_family: 'SAVINGS', requestId: 'AUTH-1003' });

  // Overall performance nudges (portfolio-level, not per-rule).
  const perf = mx.runtime.generatePerformanceNudges(ops);
  log(`${perf.length} performance nudges`);

  for (const sc of SEED_SCENARIOS) mx.tests.save(sc, qa);
  log(`${SEED_SCENARIOS.length} test scenarios`);
  return { events: events.length, failed, closed: closed.closed, performanceNudges: perf.length };
}

// ---------------------------------------------------------------------------
// Seeded regression scenarios: one per behaviour the business asked for.
// Dates are fixed so the scenarios are reproducible in any month.
// ---------------------------------------------------------------------------
const at = (date: string, hhmm: string, tz = IST) => zonedToIso(date, hhmm, tz);
const T = (o: Record<string, unknown>) => ({ type: 'TRANSACTION', dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', category: 'FOOD_GROCERY', product_family: 'SAVINGS', ...o }) as unknown as { type: string; timestamp: string };
const mass = { id: 'T_MASS', segment: 'MASS', state: 'MH', timezone: IST, dormancy_risk: false, status: 'ACTIVE', products: ['SAVINGS', 'DEBIT_CARD'] };
const affluent = { id: 'T_AFF', segment: 'AFFLUENT', state: 'KA', timezone: IST, dormancy_risk: false, status: 'ACTIVE', products: ['SAVINGS', 'CREDIT_CARD'] };
const massAcct = { id: 'A_MASS', product_family: 'SAVINGS', type: 'SAVINGS', status: 'ACTIVE' };
const affAcct = { id: 'A_AFF', product_family: 'CREDIT_CARD', type: 'CREDIT_CARD', status: 'ACTIVE' };
const setting = (ruleCode: string, values: Record<string, unknown>, customerId: string) => ({ settingId: `S_${ruleCode}`, customerId, ruleCode, values, effectiveFrom: '2026-01-01' });

export const SEED_SCENARIOS: Scenario[] = [
  {
    id: 'sc-dsl-breach', name: 'Daily limit: warn at 80%, alert on breach, no reward', focusRule: 'DSL_MASS', tags: ['spend-control', 'daily'],
    customer: mass, account: massAcct, settings: [setting('DSL_MASS', { limit: 3000 }, 'T_MASS')],
    steps: [
      { kind: 'event', label: '₹1,000 grocery', event: T({ amount: 1000, timestamp: at('2026-10-05', '10:00') }), expect: { outcomes: { DSL_MASS: 'WITHIN_LIMIT' }, decision: 'ALLOW' } },
      { kind: 'event', label: '₹1,500 more (83%)', event: T({ amount: 1500, timestamp: at('2026-10-05', '12:00') }), expect: { outcomes: { DSL_MASS: 'WARNING' }, decision: 'WARN' } },
      { kind: 'check', label: 'Pre-auth ₹600', event: T({ amount: 600, timestamp: at('2026-10-05', '18:00') }), expect: { decision: 'ALERT' } },
      { kind: 'event', label: '₹600 posted', event: T({ amount: 600, timestamp: at('2026-10-05', '18:00') }), expect: { outcomes: { DSL_MASS: 'BREACH' }, decision: 'ALERT' } },
      { kind: 'close', label: 'Day closes', asOf: '2026-10-06', expect: { outcomes: { DSL_MASS: 'BREACHED' }, points: 0 } },
    ],
    expect: { totalPoints: 0 },
  },
  {
    id: 'sc-dsl-compliant', name: 'Daily limit: a compliant day earns points', focusRule: 'DSL_MASS', tags: ['spend-control', 'daily'],
    customer: mass, account: massAcct, settings: [setting('DSL_MASS', { limit: 3000 }, 'T_MASS')],
    steps: [
      { kind: 'event', event: T({ amount: 1200, timestamp: at('2026-10-05', '10:00') }), expect: { outcomes: { DSL_MASS: 'WITHIN_LIMIT' } } },
      { kind: 'close', asOf: '2026-10-06', expect: { outcomes: { DSL_MASS: 'COMPLIANT' }, points: 10 } },
    ],
    expect: { totalPoints: 10 },
  },
  {
    id: 'sc-dsl-inactive', name: 'Daily limit: no spend means no reward (anti-gaming)', focusRule: 'DSL_MASS', tags: ['spend-control', 'anti-gaming'],
    customer: mass, account: massAcct, settings: [setting('DSL_MASS', { limit: 3000 }, 'T_MASS')],
    steps: [
      { kind: 'event', label: 'ATM withdrawal is out of scope', event: T({ amount: 500, channel: 'ATM', txn_type: 'ATM_WITHDRAWAL', timestamp: at('2026-10-05', '10:00') }) },
      { kind: 'close', asOf: '2026-10-06', expect: { points: 0 } },
    ],
    expect: { totalPoints: 0 },
  },
  {
    id: 'sc-dsl-refund', name: 'Daily limit: a refund does not undo a breach', focusRule: 'DSL_MASS', tags: ['spend-control', 'reversal'],
    customer: mass, account: massAcct, settings: [setting('DSL_MASS', { limit: 3000 }, 'T_MASS')],
    steps: [
      { kind: 'event', event: T({ amount: 2000, timestamp: at('2026-10-05', '10:00') }) },
      { kind: 'event', label: 'Breach', event: { ...T({ amount: 1500, timestamp: at('2026-10-05', '11:00') }), id: 'sc-dsl-refund-big' }, expect: { outcomes: { DSL_MASS: 'BREACH' } } },
      { kind: 'event', label: 'Refund of the breaching purchase', event: T({ amount: 1500, dr_cr: 'C', txn_type: 'REFUND', reversalOf: 'sc-dsl-refund-big', timestamp: at('2026-10-05', '15:00') }), expect: { outcomes: { DSL_MASS: 'REVERSED' } } },
      { kind: 'close', asOf: '2026-10-06', expect: { outcomes: { DSL_MASS: 'BREACHED' }, points: 0 } },
    ],
    expect: { totalPoints: 0 },
  },
  {
    id: 'sc-merchant-block', name: 'Merchant restriction: blocked merchant is declined', focusRule: 'MERCHANT_BLOCK_STD', tags: ['spend-control', 'block'],
    customer: affluent, account: affAcct, settings: [setting('MERCHANT_BLOCK_STD', { merchants: ['M_BETWAY'] }, 'T_AFF')],
    steps: [
      { kind: 'check', label: 'Betway pre-auth', event: T({ amount: 500, merchant_id: 'M_BETWAY', category: 'GAMBLING', timestamp: at('2026-10-05', '22:00') }), expect: { decision: 'BLOCK' } },
      { kind: 'check', label: 'Amazon pre-auth', event: T({ amount: 500, merchant_id: 'M_AMAZON', category: 'SHOPPING', timestamp: at('2026-10-05', '22:05') }), expect: { decision: 'ALLOW' } },
    ],
  },
  {
    id: 'sc-timing-tz', name: 'Timing restriction uses the customer timezone', focusRule: 'TIMING_STD', tags: ['spend-control', 'timezone'],
    customer: { ...affluent, id: 'T_NY', timezone: 'America/New_York' }, settings: [setting('TIMING_STD', { from: '23:00', to: '06:00' }, 'T_NY')],
    steps: [
      { kind: 'event', label: '12:00 New York', event: T({ amount: 50, channel: 'CARD_POS', timestamp: at('2026-10-05', '12:00', 'America/New_York') }), expect: { outcomes: { TIMING_STD: 'NOT_MATCHED' }, decision: 'ALLOW' } },
      { kind: 'event', label: '23:30 New York (09:00 IST next day)', event: T({ amount: 50, channel: 'CARD_POS', timestamp: at('2026-10-05', '23:30', 'America/New_York') }), expect: { outcomes: { TIMING_STD: 'BREACH' }, decision: 'ALERT' } },
    ],
  },
  {
    id: 'sc-upi-cap', name: 'UPI mission: 3 per day count, small payments ignored', focusRule: 'UPI_STREAK_MASS', tags: ['mission', 'anti-gaming'],
    customer: mass, account: massAcct,
    steps: [
      ...[0, 1, 2, 3].map((k) => ({ kind: 'event' as const, label: `Day 1 payment ${k + 1}`, event: T({ amount: 100, timestamp: at('2026-10-05', `1${k}:00`) }) })),
      { kind: 'event', label: '₹40 is below the minimum', event: T({ amount: 40, timestamp: at('2026-10-05', '15:00') }), expect: { outcomes: { UPI_STREAK_MASS: 'NOT_MATCHED' } } },
      ...[0, 1, 2].map((k) => ({ kind: 'event' as const, event: T({ amount: 100, timestamp: at('2026-10-06', `1${k}:00`) }) })),
      ...[0, 1, 2].map((k) => ({ kind: 'event' as const, event: T({ amount: 100, timestamp: at('2026-10-07', `1${k}:00`) }) })),
      { kind: 'event', label: '10th counted payment', event: T({ amount: 100, timestamp: at('2026-10-08', '10:00') }), expect: { points: 150 } },
    ],
    expect: { totalPoints: 150 },
  },
  {
    id: 'sc-referral', name: 'Referral: points only on approval, once per referral', focusRule: 'REFERRAL_STD', tags: ['mission'],
    customer: mass, account: massAcct,
    steps: [
      { kind: 'event', label: 'Submitted', event: { type: 'REFERRAL', referral_id: 'R1', status: 'SUBMITTED', timestamp: at('2026-10-05', '10:00') }, expect: { points: 0 } },
      { kind: 'event', label: 'Approved', event: { type: 'REFERRAL', referral_id: 'R1', status: 'APPROVED', timestamp: at('2026-10-06', '10:00') }, expect: { points: 500 } },
      { kind: 'event', label: 'Approval re-sent', event: { type: 'REFERRAL', referral_id: 'R1', status: 'APPROVED', timestamp: at('2026-10-06', '11:00') }, expect: { points: 0 } },
    ],
    expect: { totalPoints: 500 },
  },
  {
    id: 'sc-rd-streak', name: 'RD streak: milestone at 3 months, broken by a late payment', focusRule: 'RD_STREAK_MASS', tags: ['mission', 'streak'],
    customer: mass, account: massAcct,
    steps: [
      { kind: 'event', event: { type: 'RD_INSTALLMENT', on_time: true, amount: 2000, timestamp: at('2026-07-05', '09:00') } },
      { kind: 'event', event: { type: 'RD_INSTALLMENT', on_time: true, amount: 2000, timestamp: at('2026-08-05', '09:00') } },
      { kind: 'event', label: '3rd on-time month', event: { type: 'RD_INSTALLMENT', on_time: true, amount: 2000, timestamp: at('2026-09-05', '09:00') }, expect: { points: 100 } },
      { kind: 'event', label: 'Late payment', event: { type: 'RD_INSTALLMENT', on_time: false, amount: 2000, timestamp: at('2026-10-09', '09:00') }, expect: { outcomes: { RD_STREAK_MASS: 'STREAK_BROKEN' } } },
    ],
    expect: { totalPoints: 100 },
  },
  {
    id: 'sc-amb-days', name: 'Balance mission: 20 days above ₹10,000 in the month', focusRule: 'AMB_DAYS_MASS', tags: ['mission', 'balance'],
    customer: mass, account: { id: 'T_MASS-SA', type: 'SAVINGS', product_family: 'SAVINGS', status: 'ACTIVE' },
    steps: Array.from({ length: 20 }, (_, i) => {
      const d = `2026-10-${String(i + 1).padStart(2, '0')}`;
      return { kind: 'event' as const, label: i === 19 ? '20th qualifying day' : undefined, event: { type: 'BALANCE_SNAPSHOT', accountId: 'T_MASS-SA', account_type: 'SAVINGS', balance: 12000, as_of_date: d, timestamp: at(d, '23:55') }, expect: i === 19 ? { points: 200 } : undefined };
    }),
    expect: { totalPoints: 200 },
  },
];

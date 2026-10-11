import type { Db } from './db';
import type { Actor } from './audit';
import { createCampaign, setCampaignStatus } from './campaigns';
import { Engine } from './engine';
import { seedTemplates } from './nudge';
import { approve, createRule, submitForApproval, activate } from './ruleRepo';
import { hashPassword, type Role } from './security';
import { addDays, localDate, zonedToIso } from './time';
import { FixedClock, uid, type Clock } from './util';

// ---------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------
export function seedReference(db: Db) {
  const channels: [string, string, number][] = [
    ['UPI', 'UPI', 1], ['CARD_POS', 'Card - point of sale', 1], ['CARD_ONLINE', 'Card - online', 1], ['NETBANKING', 'Net banking', 1],
    ['MOBILE_APP', 'Mobile app', 1], ['BILLPAY', 'Bill payment', 1], ['BRANCH', 'Branch', 0], ['ATM', 'ATM', 1], ['CORE_BATCH', 'Core banking batch', 0],
  ];
  for (const [c, n, r] of channels) db.run('INSERT OR IGNORE INTO channel_ref(channel_code, name, realtime) VALUES (?,?,?)', c, n, r);

  const products: [string, string, string][] = [
    ['SAV_REGULAR', 'SAVINGS', 'Regular Savings'], ['SAV_PREMIUM', 'SAVINGS', 'Premium Savings'], ['CUR_STD', 'CURRENT', 'Current Account'],
    ['CC_PLATINUM', 'CREDIT_CARD', 'Platinum Credit Card'], ['CC_GOLD', 'CREDIT_CARD', 'Gold Credit Card'], ['DC_CLASSIC', 'DEBIT_CARD', 'Classic Debit Card'],
    ['UPI_VPA', 'UPI', 'UPI'], ['FD_STD', 'DEPOSIT', 'Fixed Deposit'], ['PL_STD', 'LOAN', 'Personal Loan'],
  ];
  for (const [c, f, n] of products) db.run('INSERT OR IGNORE INTO product_ref(product_code, product_family, name) VALUES (?,?,?)', c, f, n);

  const types: [string, string, number][] = [
    ['PURCHASE', 'Purchase', 0], ['P2P_TRANSFER', 'Person-to-person transfer', 0], ['MERCHANT_PAYMENT', 'Merchant payment', 0], ['BILL_PAYMENT', 'Bill payment', 0],
    ['DEPOSIT', 'Deposit', 0], ['WITHDRAWAL', 'Withdrawal', 0], ['EMI', 'EMI', 0], ['FEE', 'Fee', 0], ['REVERSAL', 'Full reversal', 1], ['REFUND', 'Refund', 1],
  ];
  for (const [c, n, r] of types) db.run('INSERT OR IGNORE INTO txn_type_ref(txn_type_code, name, is_reversal) VALUES (?,?,?)', c, n, r);

  const cats: [string, string][] = [
    ['GROCERY', 'Grocery'], ['DINING', 'Dining'], ['FUEL', 'Fuel'], ['TRAVEL', 'Travel'], ['SHOPPING', 'Shopping'], ['UTILITY_BILL', 'Utility bill'],
    ['TELECOM', 'Telecom'], ['SELF_TRANSFER', 'Self transfer'], ['RENT', 'Rent'], ['ENTERTAINMENT', 'Entertainment'], ['OTHER', 'Other'],
  ];
  for (const [c, n] of cats) db.run('INSERT OR IGNORE INTO txn_category_ref(category_code, name) VALUES (?,?)', c, n);

  const segs: [string, string][] = [['MASS', 'Mass market'], ['AFFLUENT', 'Affluent'], ['SALARIED', 'Salaried'], ['NEW_TO_BANK', 'New to bank'], ['DIGITAL_FIRST', 'Digital first']];
  for (const [c, n] of segs) db.run('INSERT OR IGNORE INTO segment(segment_code, name) VALUES (?,?)', c, n);

  seedTemplates(db);
}

// ---------------------------------------------------------------------
// Users (demo credentials; production uses the bank SSO / IdP - see docs/10)
// ---------------------------------------------------------------------
export const DEMO_PASSWORD = 'Mxp@Demo1';

export const DEMO_USERS: { username: string; name: string; roles: Role[] }[] = [
  { username: 'maker', name: 'Maya Maker', roles: ['RULE_MAKER'] },
  { username: 'checker', name: 'Charan Checker', roles: ['RULE_APPROVER'] },
  { username: 'qa', name: 'Qiana QA', roles: ['QA_ENGINEER'] },
  { username: 'ops', name: 'Omar Operations', roles: ['OPERATIONS'] },
  { username: 'auditor', name: 'Asha Auditor', roles: ['AUDITOR'] },
  { username: 'admin', name: 'Sam Admin', roles: ['SYSTEM_ADMIN'] },
];

export function seedUsers(db: Db, clock: Clock, password = DEMO_PASSWORD) {
  const now = clock.now().toISOString();
  const hash = hashPassword(password);
  for (const u of DEMO_USERS) {
    if (db.get('SELECT 1 FROM app_user WHERE username = ?', u.username)) continue;
    const id = uid();
    db.run('INSERT INTO app_user(user_id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)', id, u.username, u.name, hash, now);
    for (const r of u.roles) db.run('INSERT INTO user_role(user_id, role_code) VALUES (?,?)', id, r);
  }
}

export function actorFor(username: string): Actor {
  const u = DEMO_USERS.find((x) => x.username === username)!;
  return { username: u.username, roles: u.roles };
}

// ---------------------------------------------------------------------
// Sample rules: the six business use cases, all pure configuration.
// ---------------------------------------------------------------------
const leaf = (field: string, operator: string, value?: unknown) => ({ type: 'condition', field, operator, value });
const AND = (...children: unknown[]) => ({ type: 'group', op: 'AND', negate: false, children });
const NOT = (...children: unknown[]) => ({ type: 'group', op: 'AND', negate: true, children });

export function sampleCampaigns(clock: Clock) {
  const today = localDate(clock.now().toISOString(), 'Asia/Kolkata');
  const year = today.slice(0, 4);
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonthStart = localDate(addDays(monthStart, -1) + 'T12:00:00Z', 'UTC').slice(0, 7) + '-01';
  const nextMonthEnd = addDays(`${addDays(monthStart, 62).slice(0, 7)}-01`, -1);
  return {
    alwaysOn: { code: 'MXP_ALWAYS_ON', name: 'MXP Always-on rewards', description: 'Standing monthly goals for all retail customers.', objective: 'Daily banking engagement', startDate: `${year}-01-01`, endDate: `${Number(year) + 1}-12-31` },
    utility: { code: 'UTILITY_FEST', name: 'Utility bill fest', description: 'Pay utility bills digitally during the campaign.', objective: 'Digital bill payments', startDate: prevMonthStart, endDate: nextMonthEnd, pointsBudget: 100000 },
    effectiveFrom: prevMonthStart,
  };
}

export function sampleRules(clock: Clock) {
  const c = sampleCampaigns(clock);
  const eff = { from: c.effectiveFrom, to: null as string | null };
  return [
    {
      code: 'SAV_AVG_BAL_50K',
      def: {
        name: 'Average savings balance >= ₹50,000', description: 'Maintain an average monthly savings balance of at least ₹50,000.',
        businessObjective: 'Grow CASA balances', category: 'BALANCE', campaignCode: 'MXP_ALWAYS_ON', kind: 'GOAL',
        eligibility: AND(leaf('customer.status', 'EQ', 'ACTIVE'), leaf('customer.kyc_status', 'EQ', 'FULL')),
        qualifying: AND(leaf('account.product_family', 'EQ', 'SAVINGS'), leaf('account.status', 'EQ', 'ACTIVE')),
        metric: { type: 'AVG_BALANCE', operator: 'GTE' }, period: { type: 'MONTHLY', timezone: 'Asia/Kolkata' },
        tiers: [{ label: '₹50K average', threshold: 50000, points: 500 }], effective: eff, priority: 100,
      },
    },
    {
      code: 'CARD_SPEND_10K',
      def: {
        name: 'Card spend >= ₹10,000 in a month', description: 'Spend at least ₹10,000 on your credit card in the calendar month.',
        businessObjective: 'Increase card spends', category: 'SPEND', campaignCode: 'MXP_ALWAYS_ON', kind: 'GOAL', scope: { channels: ['CARD_POS', 'CARD_ONLINE'], productCodes: [] },
        eligibility: AND(leaf('customer.status', 'EQ', 'ACTIVE')),
        qualifying: AND(leaf('txn.type', 'EQ', 'PURCHASE'), leaf('txn.dr_cr', 'EQ', 'D'), leaf('txn.instrument_type', 'EQ', 'CREDIT_CARD'), NOT(leaf('txn.category', 'IN', ['RENT']))),
        metric: { type: 'SUM', operator: 'GTE' }, period: { type: 'MONTHLY', timezone: 'Asia/Kolkata' },
        tiers: [{ label: '₹10K spend', threshold: 10000, points: 300 }, { label: '₹25K spend', threshold: 25000, points: 400 }], tierMode: 'CUMULATIVE',
        effective: eff, priority: 100, handling: { reversal: 'CLAWBACK', countStatuses: ['POSTED'] },
      },
    },
    {
      code: 'UPI_10_TXNS',
      def: {
        name: '10 UPI payments in a month', description: 'Make 10 UPI payments of ₹10 or more (self transfers excluded).',
        businessObjective: 'Drive UPI activity', category: 'FREQUENCY', campaignCode: 'MXP_ALWAYS_ON', kind: 'GOAL', scope: { channels: ['UPI'], productCodes: [] },
        eligibility: AND(leaf('customer.status', 'EQ', 'ACTIVE')),
        qualifying: AND(leaf('txn.channel', 'EQ', 'UPI'), leaf('txn.dr_cr', 'EQ', 'D'), leaf('txn.amount', 'GTE', 10), NOT(leaf('txn.category', 'IN', ['SELF_TRANSFER']))),
        metric: { type: 'COUNT', operator: 'GTE' }, period: { type: 'MONTHLY', timezone: 'Asia/Kolkata' },
        tiers: [{ label: '10 payments', threshold: 10, points: 100 }], effective: eff, priority: 100,
      },
    },
    {
      code: 'UTILITY_3_BILLS',
      def: {
        name: '3 utility bills in the campaign', description: 'Pay three utility bills during the Utility Fest.',
        businessObjective: 'Digital bill payments', category: 'BILL_PAYMENT', campaignCode: 'UTILITY_FEST', kind: 'GOAL',
        eligibility: AND(leaf('customer.status', 'EQ', 'ACTIVE')),
        qualifying: AND(leaf('txn.type', 'EQ', 'BILL_PAYMENT'), leaf('txn.category', 'EQ', 'UTILITY_BILL'), leaf('txn.dr_cr', 'EQ', 'D')),
        metric: { type: 'COUNT', operator: 'GTE' }, period: { type: 'CAMPAIGN', timezone: 'Asia/Kolkata' },
        tiers: [{ label: '3 bills', threshold: 3, points: 150 }, { label: '6 bills', threshold: 6, points: 250 }], limits: { frequency: 'RECURRING' },
        effective: { from: null, to: null }, priority: 100,
      },
    },
    {
      code: 'SAV_GROWTH_25K',
      def: {
        name: 'Savings growth of ₹25,000 in a month', description: 'Grow the savings balance by at least ₹25,000 during the month.',
        businessObjective: 'Savings growth', category: 'SAVINGS_GROWTH', campaignCode: 'MXP_ALWAYS_ON', kind: 'GOAL',
        eligibility: AND(leaf('customer.status', 'EQ', 'ACTIVE')),
        qualifying: AND(leaf('account.product_family', 'EQ', 'SAVINGS'), leaf('account.status', 'EQ', 'ACTIVE')),
        metric: { type: 'BALANCE_GROWTH', operator: 'GTE' }, period: { type: 'MONTHLY', timezone: 'Asia/Kolkata' },
        tiers: [{ label: '+₹25K', threshold: 25000, points: 400 }], effective: eff, priority: 100,
      },
    },
    {
      code: 'BALANCE_PLUS_CARD',
      def: {
        name: 'Balance + card combo', description: 'Meet both the savings balance goal and the card spend goal in the same month.',
        businessObjective: 'Cross-sell: deeper relationship', category: 'COMBINED', campaignCode: 'MXP_ALWAYS_ON', kind: 'COMBINED',
        eligibility: AND(leaf('customer.status', 'EQ', 'ACTIVE')),
        combined: { components: [{ ruleCode: 'SAV_AVG_BAL_50K', minTier: 1 }, { ruleCode: 'CARD_SPEND_10K', minTier: 1 }] },
        period: { type: 'MONTHLY', timezone: 'Asia/Kolkata' },
        tiers: [{ label: 'Both goals', threshold: 2, points: 1000 }], effective: eff, priority: 100,
      },
    },
  ];
}

/** A rule left in PENDING_APPROVAL so the approval queue is not empty in the demo. */
export function sampleRulePending() {
  return {
    code: 'UPI_MERCHANT_PER_TXN',
    def: {
      name: '1 XP per ₹100 on UPI merchant payments', description: 'Earn 1 XP for every ₹100 paid to a merchant through UPI, capped at 200 XP a month.',
      businessObjective: 'Merchant UPI adoption', category: 'ENGAGEMENT', campaignCode: 'MXP_ALWAYS_ON', kind: 'PER_EVENT', scope: { channels: ['UPI'], productCodes: [] },
      eligibility: AND(leaf('customer.status', 'EQ', 'ACTIVE')),
      qualifying: AND(leaf('txn.type', 'EQ', 'MERCHANT_PAYMENT'), leaf('txn.dr_cr', 'EQ', 'D')),
      perEvent: { mode: 'PER_AMOUNT', points: 1, perAmount: 100 }, period: { type: 'MONTHLY', timezone: 'Asia/Kolkata' },
      limits: { capPointsPerPeriod: 200 }, priority: 200,
    },
  };
}

export function seedRulesAndCampaigns(engine: Engine, now: Date = engine.clock.now()) {
  const ref: Clock = { now: () => now };
  const ctx = engine.ctx;
  const maker = actorFor('maker');
  const checker = actorFor('checker');
  const admin = actorFor('admin');
  const c = sampleCampaigns(ref);
  for (const camp of [c.alwaysOn, c.utility]) {
    createCampaign(ctx, maker, camp);
    setCampaignStatus(ctx, checker, camp.code, 'ACTIVE');
  }
  for (const r of sampleRules(ref)) {
    createRule(ctx, maker, r.code, r.def, 'Initial version');
    submitForApproval(ctx, maker, r.code, 1);
    approve(ctx, checker, r.code, 1, 'Approved for launch');
    activate(ctx, admin, r.code, 1);
  }
  const p = sampleRulePending();
  createRule(ctx, maker, p.code, p.def, 'Initial version');
  submitForApproval(ctx, maker, p.code, 1);
}

// ---------------------------------------------------------------------
// Sample customers and transactions
// ---------------------------------------------------------------------
export interface SampleCustomer {
  ref: string; name: string; segments: string[]; consent?: boolean;
  accounts: { ref: string; product: string; type: string; openedOn: string }[];
  instruments?: { ref: string; type: string; account?: string; product?: string }[];
}

export const SAMPLE_CUSTOMERS: SampleCustomer[] = [
  { ref: 'CUST-1001', name: 'A*** S****', segments: ['AFFLUENT', 'DIGITAL_FIRST'], accounts: [{ ref: 'SA-1001', product: 'SAV_PREMIUM', type: 'SAVINGS', openedOn: '2022-04-11' }, { ref: 'CCA-1001', product: 'CC_PLATINUM', type: 'CREDIT_CARD', openedOn: '2023-01-05' }], instruments: [{ ref: 'CARD-1001', type: 'CREDIT_CARD', account: 'CCA-1001', product: 'CC_PLATINUM' }, { ref: 'VPA-1001', type: 'UPI_VPA', account: 'SA-1001', product: 'UPI_VPA' }] },
  { ref: 'CUST-1002', name: 'R**** K****', segments: ['SALARIED'], accounts: [{ ref: 'SA-1002', product: 'SAV_REGULAR', type: 'SAVINGS', openedOn: '2021-08-23' }, { ref: 'CCA-1002', product: 'CC_GOLD', type: 'CREDIT_CARD', openedOn: '2022-06-30' }], instruments: [{ ref: 'CARD-1002', type: 'CREDIT_CARD', account: 'CCA-1002', product: 'CC_GOLD' }, { ref: 'VPA-1002', type: 'UPI_VPA', account: 'SA-1002', product: 'UPI_VPA' }] },
  { ref: 'CUST-1003', name: 'M**** I****', segments: ['MASS', 'DIGITAL_FIRST'], accounts: [{ ref: 'SA-1003', product: 'SAV_REGULAR', type: 'SAVINGS', openedOn: '2020-02-17' }], instruments: [{ ref: 'VPA-1003', type: 'UPI_VPA', account: 'SA-1003', product: 'UPI_VPA' }] },
  { ref: 'CUST-1004', name: 'K**** M****', segments: ['AFFLUENT'], accounts: [{ ref: 'SA-1004', product: 'SAV_PREMIUM', type: 'SAVINGS', openedOn: '2019-11-02' }, { ref: 'CCA-1004', product: 'CC_PLATINUM', type: 'CREDIT_CARD', openedOn: '2021-03-14' }], instruments: [{ ref: 'CARD-1004', type: 'CREDIT_CARD', account: 'CCA-1004', product: 'CC_PLATINUM' }] },
  { ref: 'CUST-1005', name: 'S**** N****', segments: ['NEW_TO_BANK'], consent: false, accounts: [{ ref: 'SA-1005', product: 'SAV_REGULAR', type: 'SAVINGS', openedOn: '2026-09-20' }], instruments: [{ ref: 'VPA-1005', type: 'UPI_VPA', account: 'SA-1005', product: 'UPI_VPA' }] },
];

export function seedCustomers(db: Db, clock: Clock, customers = SAMPLE_CUSTOMERS) {
  const now = clock.now().toISOString();
  for (const c of customers) {
    if (db.get('SELECT 1 FROM customer WHERE customer_ref = ?', c.ref)) continue;
    const cid = uid();
    db.run('INSERT INTO customer(customer_id, customer_ref, masked_name, nudge_consent, created_at, updated_at) VALUES (?,?,?,?,?,?)', cid, c.ref, c.name, c.consent === false ? 0 : 1, now, now);
    for (const s of c.segments) db.run('INSERT INTO customer_segment(customer_id, segment_code, valid_from) VALUES (?,?,?)', cid, s, '2020-01-01');
    const accIds = new Map<string, string>();
    for (const a of c.accounts) {
      const aid = uid();
      accIds.set(a.ref, aid);
      db.run('INSERT INTO account(account_id, customer_id, account_ref, product_code, account_type, opened_on, created_at) VALUES (?,?,?,?,?,?,?)', aid, cid, a.ref, a.product, a.type, a.openedOn, now);
    }
    for (const i of c.instruments ?? []) {
      db.run('INSERT INTO instrument(instrument_id, customer_id, account_id, instrument_ref, instrument_type, product_code) VALUES (?,?,?,?,?,?)', uid(), cid, i.account ? accIds.get(i.account) ?? null : null, i.ref, i.type, i.product ?? null);
    }
  }
}

type Ev = Record<string, unknown>;
const IST = 'Asia/Kolkata';

export function txnEvent(source: string, id: string, p: Record<string, unknown>): Ev {
  return { eventType: 'TRANSACTION', sourceSystem: source, sourceEventId: `${id}:${p.status ?? 'POSTED'}`, transaction: { sourceTxnId: id, currency: 'INR', drCr: 'D', status: 'POSTED', ...p } };
}
export function snapshotEvent(account: string, date: string, balance: number): Ev {
  return { eventType: 'BALANCE_SNAPSHOT', sourceSystem: 'CORE', sourceEventId: `SNAP:${account}:${date}`, snapshot: { accountRef: account, asOfDate: date, closingBalance: balance } };
}

/**
 * Builds a realistic month of activity relative to "today" and pushes it through the normal ingestion path.
 * Expected outcomes are documented in docs/08-sample-data.md.
 */
export function buildSampleEvents(clock: Clock): Ev[] {
  const today = localDate(clock.now().toISOString(), IST);
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevEnd = addDays(monthStart, -1);
  const prevStart = `${prevEnd.slice(0, 7)}-01`;
  const ts = (date: string, hhmm = '11:30') => zonedToIso(date, hhmm, IST);
  const day = (n: number) => addDays(monthStart, Math.min(n, Number(today.slice(8)) - 1)); // n-th day of this month, never in the future
  const ev: Ev[] = [];
  const range = (a: string, b: string) => { const out: string[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };

  // Balance snapshots: every day of last month and this month up to today.
  const profile: Record<string, (d: string, i: number, prev: boolean) => number> = {
    'SA-1001': (d, i) => 62000 + (i % 5) * 1000,                         // clearly above ₹50k
    'SA-1002': (d, i, prev) => 48000 + (i % 3) * 500,                    // average just under ₹50k
    'SA-1003': (d, i, prev) => (prev ? 31000 + i * 1000 : 61000 + (i - 31) * 200), // grows by ₹30k during last month
    'SA-1004': (d, i) => 55000,                                          // flat ₹55k
    'SA-1005': (d, i) => 8000,
  };
  const days = [...range(addDays(prevStart, -1), prevEnd).map((d) => [d, true] as const), ...range(monthStart, addDays(today, -1)).map((d) => [d, false] as const)];
  for (const [acc, f] of Object.entries(profile)) {
    let i = 0;
    for (const [d, prev] of days) { ev.push(snapshotEvent(acc, d, f(d, i++, prev))); }
  }

  // CUST-1001: card spend 12,400 (clears 10k), 12 UPI payments, 3 utility bills.
  [['C1', 4200, 'DINING', 1], ['C2', 5100, 'SHOPPING', 2], ['C3', 3100, 'TRAVEL', 3]].forEach(([id, amt, cat, d]) =>
    ev.push(txnEvent('CARDS', `1001-${id}`, { customerRef: 'CUST-1001', accountRef: 'CCA-1001', instrumentRef: 'CARD-1001', txnType: 'PURCHASE', categoryCode: cat, channel: 'CARD_POS', amount: amt, txnTimestamp: ts(day(d as number)), merchantName: 'Sample Merchant', mcc: '5812' })));
  for (let i = 1; i <= 12; i++) ev.push(txnEvent('UPI', `1001-U${i}`, { customerRef: 'CUST-1001', accountRef: 'SA-1001', instrumentRef: 'VPA-1001', txnType: 'MERCHANT_PAYMENT', categoryCode: 'GROCERY', channel: 'UPI', amount: 150 + i * 20, txnTimestamp: ts(day(1 + (i % 8)), `1${i % 10}:15`) }));
  for (let i = 1; i <= 3; i++) ev.push(txnEvent('BILLPAY', `1001-B${i}`, { customerRef: 'CUST-1001', accountRef: 'SA-1001', txnType: 'BILL_PAYMENT', categoryCode: 'UTILITY_BILL', channel: 'BILLPAY', amount: 800 + i * 100, txnTimestamp: ts(day(i + 1)) }));

  // CUST-1002: card spend exactly 9,999 (boundary, misses by ₹1), 9 UPI payments + 1 self transfer (excluded).
  ev.push(txnEvent('CARDS', '1002-C1', { customerRef: 'CUST-1002', accountRef: 'CCA-1002', instrumentRef: 'CARD-1002', txnType: 'PURCHASE', categoryCode: 'SHOPPING', channel: 'CARD_ONLINE', amount: 6999, txnTimestamp: ts(day(2)) }));
  ev.push(txnEvent('CARDS', '1002-C2', { customerRef: 'CUST-1002', accountRef: 'CCA-1002', instrumentRef: 'CARD-1002', txnType: 'PURCHASE', categoryCode: 'FUEL', channel: 'CARD_POS', amount: 3000, txnTimestamp: ts(day(4)) }));
  for (let i = 1; i <= 9; i++) ev.push(txnEvent('UPI', `1002-U${i}`, { customerRef: 'CUST-1002', accountRef: 'SA-1002', instrumentRef: 'VPA-1002', txnType: 'P2P_TRANSFER', categoryCode: 'OTHER', channel: 'UPI', amount: 100 + i, txnTimestamp: ts(day(i % 8 + 1)) }));
  ev.push(txnEvent('UPI', '1002-U-SELF', { customerRef: 'CUST-1002', accountRef: 'SA-1002', instrumentRef: 'VPA-1002', txnType: 'P2P_TRANSFER', categoryCode: 'SELF_TRANSFER', channel: 'UPI', amount: 500, txnTimestamp: ts(day(5)) }));

  // CUST-1003: utility bills, two this month and one last month inside the campaign, plus savings growth.
  ev.push(txnEvent('BILLPAY', '1003-B0', { customerRef: 'CUST-1003', accountRef: 'SA-1003', txnType: 'BILL_PAYMENT', categoryCode: 'UTILITY_BILL', channel: 'BILLPAY', amount: 1450, txnTimestamp: ts(addDays(prevEnd, -3)) }));
  for (let i = 1; i <= 2; i++) ev.push(txnEvent('BILLPAY', `1003-B${i}`, { customerRef: 'CUST-1003', accountRef: 'SA-1003', txnType: 'BILL_PAYMENT', categoryCode: 'UTILITY_BILL', channel: 'BILLPAY', amount: 700 * i, txnTimestamp: ts(day(i + 2)) }));

  // CUST-1004: balance ₹55k + card spend ₹10,500 last month -> combined reward. This month ₹12,500 spend is awarded, then a ₹3,000 refund drops it below ₹10k -> clawback.
  ev.push(txnEvent('CARDS', '1004-C1', { customerRef: 'CUST-1004', accountRef: 'CCA-1004', instrumentRef: 'CARD-1004', txnType: 'PURCHASE', categoryCode: 'TRAVEL', channel: 'CARD_ONLINE', amount: 8000, txnTimestamp: ts(day(2)) }));
  ev.push(txnEvent('CARDS', '1004-C2', { customerRef: 'CUST-1004', accountRef: 'CCA-1004', instrumentRef: 'CARD-1004', txnType: 'PURCHASE', categoryCode: 'DINING', channel: 'CARD_POS', amount: 3000, txnTimestamp: ts(day(3)) }));
  ev.push(txnEvent('CARDS', '1004-P1', { customerRef: 'CUST-1004', accountRef: 'CCA-1004', instrumentRef: 'CARD-1004', txnType: 'PURCHASE', categoryCode: 'TRAVEL', channel: 'CARD_ONLINE', amount: 10500, txnTimestamp: ts(addDays(prevStart, 10)) }));
  ev.push(txnEvent('CARDS', '1004-C3', { customerRef: 'CUST-1004', accountRef: 'CCA-1004', instrumentRef: 'CARD-1004', txnType: 'PURCHASE', categoryCode: 'SHOPPING', channel: 'CARD_ONLINE', amount: 1500, txnTimestamp: ts(day(3), '16:40') }));
  ev.push({ eventType: 'TRANSACTION', sourceSystem: 'CARDS', sourceEventId: '1004-C2-RF:POSTED', transaction: { sourceTxnId: '1004-C2-RF', originalSourceTxnId: '1004-C2', customerRef: 'CUST-1004', accountRef: 'CCA-1004', txnType: 'REFUND', channel: 'CARD_ONLINE', amount: 3000, drCr: 'C', currency: 'INR', status: 'POSTED', txnTimestamp: ts(day(5)) } });

  // CUST-1005: small activity; no nudge consent.
  for (let i = 1; i <= 6; i++) ev.push(txnEvent('UPI', `1005-U${i}`, { customerRef: 'CUST-1005', accountRef: 'SA-1005', instrumentRef: 'VPA-1005', txnType: 'P2P_TRANSFER', channel: 'UPI', amount: 200, txnTimestamp: ts(day(i)) }));
  return ev;
}

export function arrivalOf(ev: any): Date {
  if (ev.eventType === 'TRANSACTION') return new Date(new Date(ev.transaction.txnTimestamp).getTime() + 60_000);
  return new Date(zonedToIso(addDays(ev.snapshot.asOfDate, 1), '01:00', IST));
}

/**
 * Replays sample history in arrival order under a simulated clock, so that late-arrival rules,
 * period close and balance finality behave exactly as they would have in production.
 */
export function seedSampleData(engine: Engine, clock: FixedClock, now: Date) {
  seedCustomers(engine.db, clock);
  const events = buildSampleEvents({ now: () => now })
    .map((ev, i) => ({ ev, at: arrivalOf(ev), i }))
    .map((x) => ({ ...x, at: x.at > now ? now : x.at }))
    .filter((x) => x.ev.eventType !== 'TRANSACTION' || new Date((x.ev as any).transaction.txnTimestamp) <= now)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.i - b.i);
  const rejected: unknown[] = [];
  let currentDay = '';
  for (const { ev, at } of events) {
    if (at > clock.now()) clock.set(at);
    const day = localDate(at.toISOString(), IST);
    if (day !== currentDay) {
      if (currentDay) { engine.closePeriods(); engine.dispatchNudges(); }
      currentDay = day;
    }
    const r = engine.ingestAndProcess([ev]);
    rejected.push(...r.results.filter((x) => x.status === 'REJECTED'));
  }
  clock.set(now);
  engine.closePeriods();
  engine.dispatchNudges();
  return { events: events.length, rejected };
}

/** Complete demo environment: reference data, users, campaigns, rules, customers, transactions. */
export function seedAll(db: Db, now: Date = new Date()) {
  const today = localDate(now.toISOString(), IST);
  const prevMonthStart = `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
  const clock = new FixedClock(new Date(zonedToIso(prevMonthStart, '00:30', IST)));
  const engine = new Engine(db, clock);
  seedReference(db);
  seedUsers(db, clock);
  seedRulesAndCampaigns(engine, now);
  return seedSampleData(engine, clock, now);
}

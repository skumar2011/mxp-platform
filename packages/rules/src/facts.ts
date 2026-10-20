/**
 * Fact model: the fields a rule can reference. A pack may ship its own fact
 * model; otherwise this banking model is used. Paths are resolved generically
 * (event.*, customer.*, account.*), so unknown attributes still work at runtime;
 * the fact model only drives validation warnings and the admin UI.
 */
import type { EvalContext, FactDef, MxpEvent } from './schema';
import { localParts } from './time';

export const EVENT_TYPES = [
  'TRANSACTION',
  'BALANCE_SNAPSHOT',
  'REFERRAL',
  'PRODUCT_APPLICATION',
  'RD_INSTALLMENT',
  'RD_MATURITY',
  'FD_MATURITY',
] as const;

export const DEFAULT_REFERENCES: Record<string, string[]> = {
  event_types: [...EVENT_TYPES],
  segments: ['MASS', 'AFFLUENT', 'YOUTH', 'SENIOR'],
  channels: ['CARD_POS', 'CARD_ONLINE', 'UPI', 'ATM', 'NETBANKING', 'BRANCH'],
  txn_types: ['PURCHASE', 'ATM_WITHDRAWAL', 'CASH_ADVANCE', 'P2P_TRANSFER', 'BILL_PAYMENT', 'SELF_TRANSFER', 'INTERNATIONAL_POS', 'REFUND'],
  categories: ['FOOD_GROCERY', 'DINING', 'TRAVEL', 'SHOPPING', 'ENTERTAINMENT', 'FUEL', 'UTILITIES', 'HEALTH', 'EDUCATION', 'GAMBLING', 'OTHER'],
  product_families: ['SAVINGS', 'CURRENT', 'CREDIT_CARD', 'DEBIT_CARD', 'RECURRING_DEPOSIT', 'FIXED_DEPOSIT', 'PERSONAL_LOAN', 'HOME_LOAN', 'INSURANCE', 'MUTUAL_FUND'],
  account_types: ['SAVINGS', 'CURRENT', 'CREDIT_CARD', 'RECURRING_DEPOSIT', 'FIXED_DEPOSIT', 'LOAN'],
  application_status: ['SUBMITTED', 'APPROVED', 'REJECTED'],
  fd_actions: ['RENEW', 'ROLLOVER', 'PAYOUT'],
};

export const DEFAULT_FACTS: FactDef[] = [
  // transaction
  { path: 'event.amount', label: 'Amount', type: 'money', events: ['TRANSACTION', 'RD_INSTALLMENT', 'FD_MATURITY'] },
  { path: 'event.dr_cr', label: 'Debit / credit', type: 'enum', values: ['D', 'C'], events: ['TRANSACTION'] },
  { path: 'event.channel', label: 'Channel', type: 'enum', valuesFrom: 'channels', events: ['TRANSACTION'] },
  { path: 'event.txn_type', label: 'Transaction type', type: 'enum', valuesFrom: 'txn_types', events: ['TRANSACTION'] },
  { path: 'event.category', label: 'Merchant category', type: 'enum', valuesFrom: 'categories', events: ['TRANSACTION'] },
  { path: 'event.merchant_id', label: 'Merchant ID', type: 'string', events: ['TRANSACTION'] },
  { path: 'event.merchant_name', label: 'Merchant name', type: 'string', events: ['TRANSACTION'] },
  { path: 'event.mcc', label: 'MCC', type: 'string', events: ['TRANSACTION'] },
  { path: 'event.product_family', label: 'Product family', type: 'enum', valuesFrom: 'product_families', events: ['TRANSACTION', 'PRODUCT_APPLICATION'] },
  { path: 'event.payee_id', label: 'Payee / counterparty', type: 'string', events: ['TRANSACTION'] },
  { path: 'event.international', label: 'International', type: 'boolean', events: ['TRANSACTION'] },
  { path: 'event.status', label: 'Status', type: 'string' },
  // balances
  { path: 'event.balance', label: 'Closing balance', type: 'money', events: ['BALANCE_SNAPSHOT'] },
  { path: 'event.as_of_date', label: 'Balance date', type: 'date', events: ['BALANCE_SNAPSHOT'] },
  { path: 'event.account_type', label: 'Account type', type: 'enum', valuesFrom: 'account_types', events: ['BALANCE_SNAPSHOT', 'RD_INSTALLMENT', 'RD_MATURITY', 'FD_MATURITY'] },
  // lifecycle
  { path: 'event.referral_id', label: 'Referral ID', type: 'string', events: ['REFERRAL'] },
  { path: 'event.application_id', label: 'Application ID', type: 'string', events: ['PRODUCT_APPLICATION'] },
  { path: 'event.installment_no', label: 'Installment number', type: 'number', events: ['RD_INSTALLMENT'] },
  { path: 'event.on_time', label: 'Paid on time', type: 'boolean', events: ['RD_INSTALLMENT'] },
  { path: 'event.installments_missed', label: 'Installments missed', type: 'number', events: ['RD_MATURITY'] },
  { path: 'event.tenure_months', label: 'Tenure (months)', type: 'number', events: ['RD_MATURITY', 'FD_MATURITY'] },
  { path: 'event.action', label: 'Maturity action', type: 'enum', valuesFrom: 'fd_actions', events: ['FD_MATURITY'] },
  { path: 'event.maturity_id', label: 'Maturity ID', type: 'string', events: ['FD_MATURITY'] },
  // derived, local to the rule timezone
  { path: 'event.local.date', label: 'Local date', type: 'date' },
  { path: 'event.local.time', label: 'Local time (HH:mm)', type: 'time' },
  { path: 'event.local.hour', label: 'Local hour (0-23)', type: 'number' },
  { path: 'event.local.dow', label: 'Day of week (1=Mon)', type: 'number' },
  { path: 'event.local.dom', label: 'Day of month', type: 'number' },
  { path: 'event.type', label: 'Event type', type: 'enum', valuesFrom: 'event_types' },
  // customer / account context
  { path: 'customer.segment', label: 'Customer segment', type: 'enum', valuesFrom: 'segments' },
  { path: 'customer.status', label: 'Customer status', type: 'enum', values: ['ACTIVE', 'INACTIVE', 'BLOCKED', 'CLOSED'] },
  { path: 'customer.kyc_status', label: 'KYC status', type: 'enum', values: ['FULL', 'MINIMAL', 'PENDING'] },
  { path: 'customer.days_since_last_txn', label: 'Days since last transaction', type: 'number' },
  { path: 'customer.products', label: 'Products held', type: 'array', valuesFrom: 'product_families' },
  { path: 'customer.tenure_days', label: 'Relationship age (days)', type: 'number' },
  { path: 'customer.dormancy_risk', label: 'Flagged as dormancy risk', type: 'boolean' },
  { path: 'account.type', label: 'Account type', type: 'enum', valuesFrom: 'account_types' },
  { path: 'account.status', label: 'Account status', type: 'enum', values: ['ACTIVE', 'DORMANT', 'FROZEN', 'CLOSED'] },
];

/** Builds the fact object a condition reads from. */
export interface FactFrame {
  event: Record<string, unknown>;
  customer: Record<string, unknown>;
  account: Record<string, unknown>;
}

export function frameOf(event: MxpEvent | null, ctx: EvalContext, tz: string): FactFrame {
  let ev: Record<string, unknown> = {};
  if (event) {
    const local = localParts(event.timestamp, tz);
    ev = { ...event, local };
  }
  return { event: ev, customer: { ...ctx.customer }, account: { ...(ctx.account ?? {}) } };
}

export function resolvePath(frame: FactFrame, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = (frame as unknown as Record<string, unknown>)[parts[0]];
  for (let i = 1; i < parts.length && cur !== undefined && cur !== null; i++) {
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

export function factIndex(facts: FactDef[]): Map<string, FactDef> {
  return new Map(facts.map((f) => [f.path, f]));
}

import type { Db } from './db';
import type { Ctx } from './campaigns';
import type { Facts } from './conditions';
import { daysBetween, localParts } from './time';

export interface EngineConfig {
  /** Delivery attempts before an event moves to the dead-letter state. */
  maxAttempts: number;
  retryBaseSeconds: number;
  /** Events dated further in the future than this are rejected. */
  futureToleranceMinutes: number;
  nudge: {
    approvedChannels: string[];
    defaultChannel: string;
    /** Progress nudges per customer per day (achievement and reversal notices are exempt). */
    dailyProgressCap: number;
  };
  /** Store the full per-condition trace on every evaluation (disable to save space at scale). */
  storeTrace: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  maxAttempts: 5,
  retryBaseSeconds: 30,
  futureToleranceMinutes: 10,
  nudge: { approvedChannels: ['PUSH', 'IN_APP'], defaultChannel: 'PUSH', dailyProgressCap: 2 },
  storeTrace: true,
};

export interface EngineCtx extends Ctx {
  config: EngineConfig;
  correlationId?: string;
}

export function loadConfig(db: Db): EngineConfig {
  const row = db.get<{ value_json: string }>('SELECT value_json FROM system_config WHERE config_key = ?', 'engine.config');
  if (!row) return DEFAULT_CONFIG;
  const o = JSON.parse(row.value_json);
  return { ...DEFAULT_CONFIG, ...o, nudge: { ...DEFAULT_CONFIG.nudge, ...(o.nudge ?? {}) } };
}

// ---------------------------------------------------------------------
export interface TxnRow {
  txn_id: string;
  source_system: string;
  source_txn_id: string;
  customer_id: string;
  account_id: string | null;
  instrument_ref: string | null;
  product_code: string | null;
  txn_type: string;
  category_code: string | null;
  channel_code: string;
  amount_minor: number;
  currency: string;
  dr_cr: 'D' | 'C';
  txn_ts: string;
  posting_date: string | null;
  status: string;
  refunded_minor: number;
  merchant_id: string | null;
  merchant_name: string | null;
  mcc: string | null;
  original_txn_id: string | null;
  is_reversal: number;
  attributes_json: string;
}

export interface CustomerRow {
  customer_id: string;
  customer_ref: string;
  status: string;
  customer_type: string;
  kyc_status: string;
  nudge_consent: number;
}

export interface AccountRow {
  account_id: string;
  customer_id: string;
  account_ref: string;
  product_code: string;
  account_type: string;
  status: string;
  opened_on: string;
  closed_on: string | null;
}

export interface CustomerContext {
  customer: CustomerRow;
  segments: string[];
}

export function loadCustomerContext(db: Db, customerId: string, asOfDate?: string): CustomerContext | undefined {
  const customer = db.get<CustomerRow>('SELECT * FROM customer WHERE customer_id = ?', customerId);
  if (!customer) return undefined;
  const day = asOfDate ?? '9999-12-31';
  const segments = db
    .all<{ segment_code: string }>(
      'SELECT segment_code FROM customer_segment WHERE customer_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?) ORDER BY segment_code',
      customerId, day, day,
    )
    .map((r) => r.segment_code);
  return { customer, segments };
}

export function loadAccount(db: Db, accountId: string | null): (AccountRow & { product_family: string }) | undefined {
  if (!accountId) return undefined;
  return db.get<any>(
    `SELECT a.*, p.product_family FROM account a JOIN product_ref p ON p.product_code = a.product_code WHERE a.account_id = ?`,
    accountId,
  );
}

export function customerFacts(cc: CustomerContext): Facts {
  return {
    'customer.segments': cc.segments,
    'customer.type': cc.customer.customer_type,
    'customer.kyc_status': cc.customer.kyc_status,
    'customer.status': cc.customer.status,
  };
}

export function accountFacts(acc: (AccountRow & { product_family: string }) | undefined, onDate: string): Facts {
  if (!acc) return {};
  return {
    'account.product_code': acc.product_code,
    'account.product_family': acc.product_family,
    'account.type': acc.account_type,
    'account.status': acc.status,
    'account.age_days': Math.max(0, daysBetween(acc.opened_on, onDate)),
  };
}

export function txnFacts(t: TxnRow, tz: string, instrumentType: string | null): Facts {
  const lp = localParts(t.txn_ts, tz);
  const f: Facts = {
    'txn.type': t.txn_type,
    'txn.category': t.category_code,
    'txn.channel': t.channel_code,
    'txn.product_code': t.product_code,
    'txn.instrument_type': instrumentType,
    'txn.amount': t.amount_minor,
    'txn.status': t.status,
    'txn.dr_cr': t.dr_cr,
    'txn.merchant_id': t.merchant_id,
    'txn.merchant_name': t.merchant_name,
    'txn.mcc': t.mcc,
    'txn.day_of_week': lp.dayOfWeek,
    'txn.day_of_month': lp.dayOfMonth,
    'txn.hour_of_day': lp.hour,
  };
  const attrs = JSON.parse(t.attributes_json || '{}');
  for (const [k, v] of Object.entries(attrs)) f[`txn.attr.${k}`] = v as any;
  return f;
}

export function instrumentTypeOf(db: Db, ref: string | null): string | null {
  if (!ref) return null;
  return db.get<{ instrument_type: string }>('SELECT instrument_type FROM instrument WHERE instrument_ref = ?', ref)?.instrument_type ?? null;
}

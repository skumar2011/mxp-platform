/**
 * Field catalogue. Rules reference fields by path. The catalogue is the single
 * source of truth for the rule validator, the evaluator and the admin UI
 * rule builder, so adding a field here exposes it everywhere.
 */
export type FieldType = 'string' | 'enum' | 'number' | 'money' | 'boolean' | 'array';
export type FieldScope = 'txn' | 'account' | 'customer';

export const OPERATORS = [
  'EQ',
  'NE',
  'GT',
  'GTE',
  'LT',
  'LTE',
  'IN',
  'NOT_IN',
  'BETWEEN',
  'CONTAINS',
  'STARTS_WITH',
  'IS_NULL',
  'NOT_NULL',
] as const;
export type Operator = (typeof OPERATORS)[number];

export const OPERATOR_LABELS: Record<Operator, string> = {
  EQ: 'equals',
  NE: 'not equal to',
  GT: 'greater than',
  GTE: 'greater than or equal to',
  LT: 'less than',
  LTE: 'less than or equal to',
  IN: 'is one of',
  NOT_IN: 'is not one of',
  BETWEEN: 'is between (inclusive)',
  CONTAINS: 'contains',
  STARTS_WITH: 'starts with',
  IS_NULL: 'is empty',
  NOT_NULL: 'is present',
};

export const OPERATORS_BY_TYPE: Record<FieldType, Operator[]> = {
  string: ['EQ', 'NE', 'IN', 'NOT_IN', 'STARTS_WITH', 'IS_NULL', 'NOT_NULL'],
  enum: ['EQ', 'NE', 'IN', 'NOT_IN', 'IS_NULL', 'NOT_NULL'],
  number: ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'BETWEEN', 'IS_NULL', 'NOT_NULL'],
  money: ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'BETWEEN'],
  boolean: ['EQ', 'NE'],
  array: ['CONTAINS', 'IN', 'NOT_IN', 'IS_NULL', 'NOT_NULL'],
};

export interface FieldDef {
  path: string;
  label: string;
  scope: FieldScope;
  type: FieldType;
  /** Name of a reference-data list that supplies the allowed values. */
  valuesFrom?: 'txn_types' | 'categories' | 'channels' | 'products' | 'segments' | 'product_families';
  values?: string[];
  description?: string;
}

export const ACCOUNT_TYPES = ['SAVINGS', 'CURRENT', 'CREDIT_CARD', 'DEBIT_CARD', 'UPI', 'LOAN', 'DEPOSIT', 'WALLET', 'OTHER'];
export const TXN_STATUSES = ['PENDING', 'POSTED', 'REVERSED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED'];

export const FIELD_CATALOG: FieldDef[] = [
  { path: 'txn.type', label: 'Transaction type', scope: 'txn', type: 'enum', valuesFrom: 'txn_types' },
  { path: 'txn.category', label: 'Transaction category', scope: 'txn', type: 'enum', valuesFrom: 'categories' },
  { path: 'txn.channel', label: 'Channel', scope: 'txn', type: 'enum', valuesFrom: 'channels' },
  { path: 'txn.product_code', label: 'Product code', scope: 'txn', type: 'enum', valuesFrom: 'products' },
  {
    path: 'txn.instrument_type',
    label: 'Instrument type',
    scope: 'txn',
    type: 'enum',
    values: ['CREDIT_CARD', 'DEBIT_CARD', 'UPI_VPA', 'WALLET'],
  },
  { path: 'txn.amount', label: 'Transaction amount (INR)', scope: 'txn', type: 'money' },
  { path: 'txn.status', label: 'Transaction status', scope: 'txn', type: 'enum', values: TXN_STATUSES },
  { path: 'txn.dr_cr', label: 'Debit / credit', scope: 'txn', type: 'enum', values: ['D', 'C'] },
  { path: 'txn.merchant_id', label: 'Merchant ID', scope: 'txn', type: 'string' },
  { path: 'txn.merchant_name', label: 'Merchant name', scope: 'txn', type: 'string' },
  { path: 'txn.mcc', label: 'Merchant category code', scope: 'txn', type: 'string' },
  { path: 'txn.day_of_week', label: 'Day of week (1=Mon..7=Sun)', scope: 'txn', type: 'number' },
  { path: 'txn.day_of_month', label: 'Day of month', scope: 'txn', type: 'number' },
  { path: 'txn.hour_of_day', label: 'Hour of day (0-23, rule timezone)', scope: 'txn', type: 'number' },
  { path: 'account.product_code', label: 'Account product code', scope: 'account', type: 'enum', valuesFrom: 'products' },
  { path: 'account.product_family', label: 'Account product family', scope: 'account', type: 'enum', valuesFrom: 'product_families' },
  { path: 'account.type', label: 'Account type', scope: 'account', type: 'enum', values: ACCOUNT_TYPES },
  { path: 'account.status', label: 'Account status', scope: 'account', type: 'enum', values: ['ACTIVE', 'DORMANT', 'FROZEN', 'CLOSED'] },
  { path: 'account.age_days', label: 'Account age (days)', scope: 'account', type: 'number' },
  { path: 'customer.segments', label: 'Customer segments', scope: 'customer', type: 'array', valuesFrom: 'segments' },
  { path: 'customer.type', label: 'Customer type', scope: 'customer', type: 'enum', values: ['RETAIL', 'SME', 'CORPORATE'] },
  { path: 'customer.kyc_status', label: 'KYC status', scope: 'customer', type: 'enum', values: ['FULL', 'MINIMAL', 'PENDING'] },
  { path: 'customer.status', label: 'Customer status', scope: 'customer', type: 'enum', values: ['ACTIVE', 'INACTIVE', 'CLOSED', 'BLOCKED'] },
];

const byPath = new Map(FIELD_CATALOG.map((f) => [f.path, f]));

/** Extensible transaction attributes: txn.attr.<key> (string or number, resolved at evaluation). */
export function getField(path: string): FieldDef | undefined {
  const f = byPath.get(path);
  if (f) return f;
  if (/^txn\.attr\.[A-Za-z0-9_]{1,40}$/.test(path)) {
    return { path, label: `Attribute ${path.slice(9)}`, scope: 'txn', type: 'string', description: 'Extensible attribute' };
  }
  return undefined;
}

export function fieldTypeOf(path: string): FieldType | undefined {
  return getField(path)?.type;
}

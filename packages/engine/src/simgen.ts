import { evalNode, type ConditionLeaf, type ConditionNode, type Facts } from './conditions';
import { isBalanceMetric, type RuleDefinition } from './ruleDef';
import { normalizeDefinition } from './ruleRepo';
import { addDays, daysBetween, periodOf, type Period } from './time';
import type { RuleSource, SimAccount, SimCustomer, SimExpected, SimRuleRef, SimScenario, SimStep, SimTxnStep } from './simtypes';

/**
 * Scenario-matrix generator.
 *
 * It reads a rule definition, derives what a qualifying transaction (or balance history) looks like
 * from the rule's own conditions, and emits positive, negative, boundary, duplicate, reversal, refund,
 * status, period-edge and data-quality scenarios. Expected results are computed here from the rule
 * definition (thresholds, tier points, caps) and NOT by running the engine, so a run compares
 * independent expectation against actual behaviour.
 */
export type MatrixCategory = 'POSITIVE' | 'NEGATIVE' | 'BOUNDARY' | 'DUPLICATE' | 'REVERSAL' | 'REFUND' | 'STATUS' | 'PERIOD' | 'CAP' | 'DATA' | 'COMBINED' | 'ELIGIBILITY';

export interface MatrixCase {
  id: string;
  name: string;
  description: string;
  category: MatrixCategory;
  rules: SimRuleRef[];
  scenario: SimScenario;
  expected: SimExpected;
}

export interface MatrixResult {
  ruleCode: string;
  versionNo: number;
  cases: MatrixCase[];
  notes: string[];
}

interface RefData {
  channels: string[];
  types: string[];
  categories: string[];
  products: { code: string; family: string }[];
  segments: string[];
}

function refData(source: RuleSource): RefData {
  const r = source.referenceData();
  return {
    channels: (r.channel_ref ?? []).map((x) => x.channel_code),
    types: (r.txn_type_ref ?? []).filter((x) => !x.is_reversal).map((x) => x.txn_type_code),
    categories: (r.txn_category_ref ?? []).map((x) => x.category_code),
    products: (r.product_ref ?? []).map((x) => ({ code: x.product_code, family: x.product_family })),
    segments: (r.segment ?? []).map((x) => x.segment_code),
  };
}

// ---------------------------------------------------------------------
// Constraint solving: from conditions to a concrete qualifying transaction
// ---------------------------------------------------------------------
interface Cons {
  eq?: unknown;
  any?: unknown[];
  not: unknown[];
  min?: number;
  max?: number;
}

const TIME_FIELDS = ['txn.day_of_week', 'txn.day_of_month', 'txn.hour_of_day'];

/** All ways to satisfy a tree (OR yields alternatives, AND combines). Negated groups are left to verification. */
function variants(node: ConditionNode, cap = 24): ConditionLeaf[][] {
  if (node.type === 'condition') return [[node]];
  if (node.negate || node.children.length === 0) return [[]];
  if (node.op === 'OR') return node.children.flatMap((c) => variants(c, cap)).slice(0, cap);
  let acc: ConditionLeaf[][] = [[]];
  for (const c of node.children) {
    const vs = variants(c, cap);
    const next: ConditionLeaf[][] = [];
    for (const a of acc) for (const v of vs) next.push([...a, ...v]);
    acc = next.slice(0, cap);
  }
  return acc;
}

function consOf(leaves: ConditionLeaf[]): Map<string, Cons> {
  const m = new Map<string, Cons>();
  const get = (f: string) => {
    if (!m.has(f)) m.set(f, { not: [] });
    return m.get(f)!;
  };
  for (const l of leaves) {
    const c = get(l.field);
    const v = l.value as any;
    switch (l.operator) {
      case 'EQ': c.eq = v; break;
      case 'IN': c.any = v; break;
      case 'CONTAINS': c.eq = v; break;
      case 'STARTS_WITH': c.eq = `${v}X`; break;
      case 'NE': c.not.push(v); break;
      case 'NOT_IN': c.not.push(...v); break;
      case 'GT': c.min = Math.max(c.min ?? -Infinity, Number(v) + 0.01); break;
      case 'GTE': c.min = Math.max(c.min ?? -Infinity, Number(v)); break;
      case 'LT': c.max = Math.min(c.max ?? Infinity, Number(v) - 0.01); break;
      case 'LTE': c.max = Math.min(c.max ?? Infinity, Number(v)); break;
      case 'BETWEEN': c.min = Math.max(c.min ?? -Infinity, v[0]); c.max = Math.min(c.max ?? Infinity, v[1]); break;
      default: break;
    }
  }
  return m;
}

export interface TxnTemplate {
  ok: boolean;
  notes: string[];
  type: string;
  category?: string;
  channel: string;
  productCode?: string;
  mcc?: string;
  merchantId?: string;
  drCr: 'D' | 'C';
  attributes: Record<string, string | number | boolean>;
  minAmount: number;
  /** True when the rule itself sets a minimum amount (otherwise minAmount is just a sensible default). */
  explicitMin?: boolean;
  maxAmount: number | null;
  account: SimAccount;
  family: string;
  instrumentType: string | null;
  customer: SimCustomer;
}

function pickValue(c: Cons | undefined, fallbacks: string[]): string | undefined {
  const bad = new Set((c?.not ?? []).map(String));
  const first = (xs: unknown[]) => xs.map(String).find((x) => !bad.has(x));
  if (c?.eq !== undefined && !bad.has(String(c.eq))) return String(c.eq);
  if (c?.any) {
    const v = first(c.any);
    if (v !== undefined) return v;
  }
  if (c && (c.eq !== undefined || c.any)) return undefined;
  return first(fallbacks);
}

function factsFor(t: Pick<TxnTemplate, 'type' | 'category' | 'channel' | 'productCode' | 'mcc' | 'merchantId' | 'drCr' | 'attributes' | 'account' | 'family' | 'instrumentType' | 'customer'>, amount: number, status = 'POSTED'): Facts {
  const f: Facts = {
    'txn.type': t.type, 'txn.category': t.category ?? null, 'txn.channel': t.channel, 'txn.product_code': t.productCode ?? t.account.productCode,
    'txn.instrument_type': t.instrumentType, 'txn.amount': Math.round(amount * 100), 'txn.status': status, 'txn.dr_cr': t.drCr,
    'txn.merchant_id': t.merchantId ?? null, 'txn.merchant_name': null, 'txn.mcc': t.mcc ?? null,
    'account.product_code': t.account.productCode, 'account.product_family': t.family, 'account.type': t.family, 'account.status': t.account.status ?? 'ACTIVE', 'account.age_days': 100000,
    'customer.segments': t.customer.segments ?? [], 'customer.type': t.customer.type ?? 'RETAIL', 'customer.kyc_status': t.customer.kycStatus ?? 'FULL', 'customer.status': t.customer.status ?? 'ACTIVE',
  };
  for (const [k, v] of Object.entries(t.attributes)) f[`txn.attr.${k}`] = v as any;
  return f;
}

function treeNodes(def: RuleDefinition): ConditionNode {
  return { type: 'group', op: 'AND', children: [def.eligibility, def.qualifying] };
}

function inScope(def: RuleDefinition, t: TxnTemplate, channel = t.channel, product = t.productCode ?? t.account.productCode): boolean {
  return (def.scope.channels.length === 0 || def.scope.channels.includes(channel)) && (def.scope.productCodes.length === 0 || def.scope.productCodes.includes(product));
}

export function qualifies(def: RuleDefinition, t: TxnTemplate, amount: number, override: Partial<TxnTemplate> = {}, status = 'POSTED'): boolean {
  const tt = { ...t, ...override };
  if (!inScope(def, tt, tt.channel, tt.productCode ?? tt.account.productCode)) return false;
  return evalNode(treeNodes(def), factsFor(tt, amount, status)).pass;
}

function accountFamilyOf(ref: RefData, code: string): string {
  return ref.products.find((p) => p.code === code)?.family ?? 'OTHER';
}

export function buildTemplate(def: RuleDefinition, ref: RefData, accRef = 'ACC-MAIN'): TxnTemplate {
  const notes: string[] = [];
  const unsupported = new Set<string>();
  const all = variants(treeNodes(def));
  let best: TxnTemplate | null = null;
  for (const leaves of all) {
    for (const l of leaves) if (TIME_FIELDS.includes(l.field)) unsupported.add(l.field);
    const m = consOf(leaves);
    const get = (f: string) => m.get(f);
    const type = pickValue(get('txn.type'), ['PURCHASE', 'MERCHANT_PAYMENT', ...ref.types]) ?? 'PURCHASE';
    const category = pickValue(get('txn.category'), []) ?? undefined;
    const channelFallbacks = [...def.scope.channels, ...ref.channels.filter((c) => c !== 'BRANCH')];
    const channel = pickValue(get('txn.channel'), channelFallbacks) ?? channelFallbacks[0] ?? 'MOBILE_APP';
    const instrumentType = pickValue(get('txn.instrument_type'), []) ?? null;
    const productCode = pickValue(get('txn.product_code'), def.scope.productCodes) ?? undefined;
    const amt = get('txn.amount');
    const eqAmt = typeof amt?.eq === 'number' ? amt.eq : undefined;
    const minAmount = eqAmt ?? amt?.min ?? 1;
    const maxAmount = eqAmt ?? (amt?.max !== undefined && Number.isFinite(amt.max) ? amt.max : null);
    const accFam = pickValue(get('account.product_family'), []);
    const accType = pickValue(get('account.type'), []);
    const wantedFamily =
      accFam ?? accType ??
      (instrumentType === 'CREDIT_CARD' ? 'CREDIT_CARD' : instrumentType === 'DEBIT_CARD' ? 'DEBIT_CARD' : instrumentType === 'WALLET' ? 'WALLET' : channel.startsWith('CARD') ? 'CREDIT_CARD' : 'SAVINGS');
    const accProductCode =
      pickValue(get('account.product_code'), []) ??
      ref.products.find((p) => p.family === wantedFamily)?.code ??
      ref.products[0]?.code ?? 'SAV_REGULAR';
    const family = accountFamilyOf(ref, accProductCode);
    const segs = get('customer.segments');
    const segment = pickValue(segs, []);
    const customer: SimCustomer = {
      type: (pickValue(get('customer.type'), ['RETAIL']) as any) ?? 'RETAIL',
      kycStatus: (pickValue(get('customer.kyc_status'), ['FULL']) as any) ?? 'FULL',
      status: (pickValue(get('customer.status'), ['ACTIVE']) as any) ?? 'ACTIVE',
      segments: segment ? [segment] : [],
    };
    const attributes: Record<string, string | number | boolean> = {};
    for (const [k, c] of m) if (k.startsWith('txn.attr.')) { const v = c.eq ?? c.any?.[0]; if (v !== undefined) attributes[k.slice(9)] = v as any; }
    const account: SimAccount = {
      ref: accRef, productCode: accProductCode, status: (pickValue(get('account.status'), ['ACTIVE']) as any) ?? 'ACTIVE', openedOn: '2000-01-01',
      instrumentType: instrumentType ? (instrumentType as any) : undefined,
    };
    const familyInstrument = ({ CREDIT_CARD: 'CREDIT_CARD', DEBIT_CARD: 'DEBIT_CARD', UPI: 'UPI_VPA', WALLET: 'WALLET' } as Record<string, string>)[family] ?? null;
    const tpl: TxnTemplate = {
      ok: false, notes: [], type, category, channel, productCode, mcc: pickValue(get('txn.mcc'), []), merchantId: pickValue(get('txn.merchant_id'), []),
      drCr: (pickValue(get('txn.dr_cr'), ['D']) as 'D' | 'C') ?? 'D', attributes, minAmount, explicitMin: amt?.min !== undefined || eqAmt !== undefined, maxAmount, account, family, instrumentType: instrumentType ?? familyInstrument, customer,
    };
    if (maxAmount !== null && maxAmount < minAmount) continue;
    const probe = Math.max(minAmount, 1);
    if (qualifies(def, tpl, probe)) {
      tpl.ok = true;
      best = tpl;
      break;
    }
    best ??= tpl;
  }
  if (!best) return { ok: false, notes: ['The rule conditions could not be satisfied by any transaction.'], type: 'PURCHASE', channel: 'MOBILE_APP', drCr: 'D', attributes: {}, minAmount: 1, maxAmount: null, account: { ref: accRef, productCode: 'SAV_REGULAR' }, family: 'SAVINGS', instrumentType: null, customer: {} };
  if (unsupported.size) notes.push(`Conditions on ${[...unsupported].join(', ')} are not auto-generated; write those scenarios by hand.`);
  if (!best.ok) notes.push('Could not derive a qualifying transaction from the conditions (conflicting or unsupported conditions).');
  if (unsupported.size) best.ok = false;
  best.notes = notes;
  return best;
}

/** Account-level template for balance rules. */
export function buildAccountTemplate(def: RuleDefinition, ref: RefData, accRef = 'ACC-MAIN'): TxnTemplate {
  const t = buildTemplate({ ...def, scope: { channels: [], productCodes: [] } }, ref, accRef);
  // Balance rules only look at account and customer facts; transaction conditions do not apply.
  const m = consOf(variants({ type: 'group', op: 'AND', children: [def.eligibility, def.qualifying] }).find((v) => v.every((l) => !l.field.startsWith('txn.'))) ?? []);
  const fam = pickValue(m.get('account.product_family'), []) ?? pickValue(m.get('account.type'), []) ?? 'SAVINGS';
  const code = pickValue(m.get('account.product_code'), []) ?? ref.products.find((p) => p.family === fam)?.code ?? 'SAV_REGULAR';
  t.account = { ref: accRef, productCode: code, status: (pickValue(m.get('account.status'), ['ACTIVE']) as any) ?? 'ACTIVE', openedOn: '2000-01-01' };
  t.family = accountFamilyOf(ref, code);
  const probe = evalNode(treeNodes(def), { ...factsFor(t, 0), 'txn.type': undefined as any });
  t.ok = probe.pass || def.eligibility.children.length + def.qualifying.children.length === 0;
  t.notes = t.ok ? [] : ['Could not derive an account that satisfies the rule conditions.'];
  return t;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const cents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;

function splitCents(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => fromCents(base + (i < rem ? 1 : 0)));
}

interface GenCtx {
  code: string;
  versionNo: number;
  def: RuleDefinition;
  ref: RefData;
  tpl: TxnTemplate;
  period: Period;
  next: Period | null;
  winFrom: string | null;
  winTo: string | null;
  budget: number | null;
  campaignWindow: { code: string; start: string; end: string } | null;
  notes: string[];
  cases: MatrixCase[];
}

function metricUnitsOf(def: RuleDefinition): 'SUM' | 'COUNT' | 'BAL' {
  const t = def.metric?.type;
  return t === 'SUM' ? 'SUM' : t === 'COUNT' ? 'COUNT' : 'BAL';
}

function reachedTier(def: RuleDefinition, value: number): number {
  const gt = def.metric?.operator === 'GT';
  let r = 0;
  def.tiers.forEach((t, i) => {
    const th = metricUnitsOf(def) === 'COUNT' ? t.threshold : cents(t.threshold) / 100;
    if (gt ? value > th : value >= th) r = i + 1;
  });
  return r;
}

function capPoints(g: GenCtx, pts: number): number {
  const l = g.def.limits;
  let v = pts;
  if (l.capPointsPerPeriod !== null && l.capPointsPerPeriod !== undefined) v = Math.min(v, l.capPointsPerPeriod);
  if (l.capPointsLifetime !== null && l.capPointsLifetime !== undefined) v = Math.min(v, l.capPointsLifetime);
  if (g.budget !== null) v = Math.min(v, g.budget);
  return v;
}

function tierPoints(g: GenCtx, tier: number): number {
  if (tier <= 0) return 0;
  const t = g.def.tiers;
  const raw = g.def.tierMode === 'HIGHEST_ONLY' ? t[tier - 1].points : t.slice(0, tier).reduce((a, x) => a + x.points, 0);
  return capPoints(g, raw);
}

function awardEntries(g: GenCtx, tier: number): number {
  if (tier <= 0) return 0;
  const pts = g.def.tierMode === 'HIGHEST_ONLY' ? [g.def.tiers[tier - 1].points] : g.def.tiers.slice(0, tier).map((x) => x.points);
  return pts.filter((p) => p > 0).length;
}

function pickPeriod(def: RuleDefinition, campaignWindow: GenCtx['campaignWindow'], winFrom: string | null): { period: Period; next: Period | null } {
  const type = def.period.type;
  const anchor = winFrom && winFrom > '2026-06-01' ? winFrom : '2026-06-01';
  let p = periodOf(anchor, type, campaignWindow);
  if (type !== 'CAMPAIGN' && winFrom && p.start < winFrom) p = periodOf(addDays(p.end, 1), type, campaignWindow);
  const next = type === 'CAMPAIGN' ? null : periodOf(addDays(p.end, 1), type, campaignWindow);
  return { period: p, next };
}

function dayAt(p: Period, i: number): string {
  const len = daysBetween(p.start, p.end) + 1;
  return addDays(p.start, i % len);
}
function timeFor(i: number): string {
  return `${String(9 + (i % 10)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`;
}

function txnSteps(g: GenCtx, prefix: string, amounts: number[], opts: { period?: Period; tpl?: TxnTemplate; status?: SimTxnStep['status']; startIndex?: number } = {}): SimTxnStep[] {
  const tpl = opts.tpl ?? g.tpl;
  const per = opts.period ?? g.period;
  return amounts.map((amount, i) => {
    const idx = (opts.startIndex ?? 0) + i;
    return {
      kind: 'TXN',
      id: `${prefix}-${idx + 1}`,
      at: `${dayAt(per, idx)}T${timeFor(idx)}`,
      type: tpl.type, category: tpl.category, channel: tpl.channel, amount, drCr: tpl.drCr, status: opts.status ?? 'POSTED',
      accountRef: tpl.account.ref, instrumentRef: tpl.instrumentType ? `${tpl.account.ref}-INS` : undefined, productCode: tpl.productCode, mcc: tpl.mcc, merchantId: tpl.merchantId,
      attributes: Object.keys(tpl.attributes).length ? tpl.attributes : undefined,
    } as SimTxnStep;
  });
}

function amountsForSum(g: GenCtx, total: number, preferSplit = true): number[] | null {
  const c = cents(total);
  const minC = Math.max(1, cents(g.tpl.minAmount));
  const maxC = g.tpl.maxAmount === null ? Infinity : cents(g.tpl.maxAmount);
  const lower = Math.max(1, Math.ceil(c / maxC));
  const upper = Math.floor(c / minC);
  if (c <= 0 || lower > upper) return null;
  const n = Math.min(upper, Math.max(lower, preferSplit ? 2 : 1));
  if (n > 400) return null;
  return splitCents(c, n);
}

function amountsForCount(g: GenCtx, k: number): number[] | null {
  if (k <= 0 || k > 300) return k === 0 ? [] : null;
  const lo = g.tpl.minAmount;
  const hi = g.tpl.maxAmount ?? Infinity;
  const a = Math.min(Math.max(500, lo), hi);
  if (a < lo || a > hi) return null;
  return Array.from({ length: k }, () => a);
}

function valueAmounts(g: GenCtx, value: number, split = true): number[] | null {
  return metricUnitsOf(g.def) === 'SUM' ? amountsForSum(g, value, split) : amountsForCount(g, value);
}

let seq = 0;
function add(g: GenCtx, c: Omit<MatrixCase, 'id' | 'rules'> & { id?: string }) {
  g.cases.push({ ...c, id: c.id ?? `${g.code}#${String(++seq).padStart(2, '0')}`, rules: [{ ruleCode: g.code, versionNo: g.versionNo }] });
}

function scenario(g: GenCtx, steps: SimStep[], opts: { tpl?: TxnTemplate; accounts?: SimAccount[]; customer?: SimCustomer; asOf?: string } = {}): SimScenario {
  const tpl = opts.tpl ?? g.tpl;
  return {
    timezone: g.def.period.timezone,
    customer: opts.customer ?? tpl.customer,
    accounts: opts.accounts ?? [tpl.account],
    steps,
    asOf: opts.asOf ?? g.period.end,
  };
}

const delta = (g: GenCtx) => (metricUnitsOf(g.def) === 'SUM' || metricUnitsOf(g.def) === 'BAL' ? 0.01 : 1);

// ---------------------------------------------------------------------
// Negative variants
// ---------------------------------------------------------------------
function negativeTemplate(g: GenCtx, amount: number): { desc: string; tpl: TxnTemplate; status?: string } | null {
  const t = g.tpl;
  const trials: { desc: string; over: Partial<TxnTemplate> }[] = [];
  const other = (xs: string[], cur: string | undefined) => xs.filter((x) => x !== cur);
  for (const ch of other(g.ref.channels, t.channel)) trials.push({ desc: `channel ${ch} instead of ${t.channel}`, over: { channel: ch } });
  for (const ty of other(g.ref.types, t.type)) trials.push({ desc: `type ${ty} instead of ${t.type}`, over: { type: ty } });
  for (const ca of other(g.ref.categories, t.category)) trials.push({ desc: `category ${ca} instead of ${t.category ?? 'none'}`, over: { category: ca } });
  trials.push({ desc: 'debit/credit direction flipped', over: { drCr: t.drCr === 'D' ? 'C' : 'D' } });
  trials.push({ desc: 'merchant category 9999', over: { mcc: '9999' } });
  for (const trial of trials) {
    if (!qualifies(g.def, t, amount, trial.over)) return { desc: trial.desc, tpl: { ...t, ...trial.over } };
  }
  return null;
}

/** Values the rule explicitly excludes (inside NOT groups): a transaction carrying one must not count. */
function exclusionTrials(def: RuleDefinition): { desc: string; over: Partial<TxnTemplate> }[] {
  const out: { desc: string; over: Partial<TxnTemplate> }[] = [];
  const keyOf: Record<string, keyof TxnTemplate> = { 'txn.category': 'category', 'txn.channel': 'channel', 'txn.type': 'type', 'txn.mcc': 'mcc', 'txn.merchant_id': 'merchantId' };
  const visit = (n: ConditionNode, negated: boolean) => {
    if (n.type === 'group') {
      for (const c of n.children) visit(c, negated !== !!n.negate);
      return;
    }
    const key = keyOf[n.field];
    if (negated && key && (n.operator === 'EQ' || n.operator === 'IN')) {
      const v = Array.isArray(n.value) ? n.value[0] : n.value;
      out.push({ desc: `excluded ${n.field.slice(4)} ${v}`, over: { [key]: String(v) } as Partial<TxnTemplate> });
    }
  };
  visit(def.qualifying, false);
  return out.slice(0, 3);
}

function genExclusions(g: GenCtx, amounts: number[] | null, perEvent = false) {
  if (!amounts) return;
  for (const ex of exclusionTrials(g.def)) {
    const tpl = { ...g.tpl, ...ex.over };
    const probe = Math.max(g.tpl.minAmount, 1000);
    if (qualifies(g.def, tpl, probe)) continue; // the exclusion does not apply on its own
    add(g, { name: `Exclusion honoured (${ex.desc})`, description: 'The rule excludes this value; matching transactions never count even if they otherwise qualify.', category: 'NEGATIVE',
      scenario: scenario(g, txnSteps(g, 'X', amounts, { tpl }), { tpl }), expected: { pointsByRule: { [g.code]: 0 }, achievedTier: perEvent ? undefined : { [g.code]: 0 } } });
  }
}

// ---------------------------------------------------------------------
// Case builders: transaction goals (SUM / COUNT)
// ---------------------------------------------------------------------
function genTxnGoal(g: GenCtx) {
  const { def } = g;
  const units = metricUnitsOf(def);
  const d = delta(g);
  const T = def.tiers.map((t) => t.threshold);
  const label = (v: number) => (units === 'SUM' ? `₹${v.toLocaleString('en-IN')}` : `${v}`);
  const noun = units === 'SUM' ? 'spend' : 'transactions';
  const expect = (value: number): SimExpected => {
    const tier = reachedTier(def, value);
    return { pointsByRule: { [g.code]: tierPoints(g, tier) }, achievedTier: { [g.code]: tier }, noDuplicateAwards: true };
  };
  const run = (value: number, name: string, description: string, category: MatrixCategory, opts: { split?: boolean } = {}) => {
    const amounts = valueAmounts(g, value, opts.split ?? true);
    if (!amounts) {
      g.notes.push(`Skipped "${name}": cannot build ${label(value)} ${noun} within the per-transaction limits of the rule.`);
      return;
    }
    add(g, { name, description, category, scenario: scenario(g, txnSteps(g, 'T', amounts)), expected: expect(value) });
  };

  // Boundaries around the first tier.
  if (units === 'COUNT' ? T[0] - 1 > 0 : T[0] - d > 0) {
    run(units === 'COUNT' ? T[0] - 1 : Math.round((T[0] - d) * 100) / 100, `Just below tier 1 (${label(T[0])})`, 'One unit short of the first threshold earns nothing.', 'BOUNDARY');
  }
  def.tiers.forEach((t, i) => {
    run(t.threshold, `Exactly at tier ${i + 1} (${label(t.threshold)})`, `Meets tier ${i + 1}${def.metric?.operator === 'GT' ? ' (strictly-greater rule: boundary value does not qualify)' : ''}.`, i === 0 ? 'BOUNDARY' : 'POSITIVE');
  });
  const aboveFirst = units === 'COUNT' ? T[0] + 1 : Math.round((T[0] + d) * 100) / 100;
  if (def.tiers.length === 1 || aboveFirst < T[1]) run(aboveFirst, `Just above tier 1`, 'One unit over the first threshold.', 'BOUNDARY');
  const top = T[T.length - 1];
  const wellAbove = units === 'COUNT' ? top + 2 : Math.round(top * 1.25 * 100) / 100;
  const capped = (def.limits.capPointsPerPeriod ?? null) !== null || (def.limits.capPointsLifetime ?? null) !== null || g.budget !== null;
  run(wellAbove, capped ? `Far above top tier: caps hold` : `Well above top tier (all tiers, ${def.tierMode === 'HIGHEST_ONLY' ? 'highest only' : 'cumulative'})`,
    capped ? 'Points are limited by the period/lifetime/campaign cap.' : 'Every tier is rewarded according to the tier mode.', capped ? 'CAP' : 'POSITIVE');

  // Negative: transaction that does not meet the conditions.
  const bigAmount = units === 'SUM' ? Math.max(top * 1.25, g.tpl.minAmount) : Math.max(g.tpl.minAmount, 500);
  const neg = negativeTemplate(g, bigAmount);
  const count = units === 'COUNT' ? top + 1 : 1;
  if (neg) {
    const amounts = units === 'SUM' ? splitCents(cents(bigAmount), 1) : amountsForCount({ ...g, tpl: neg.tpl }, count);
    if (amounts) add(g, { name: `Non-qualifying transaction (${neg.desc})`, description: 'A transaction outside the qualifying conditions must not count toward the goal.', category: 'NEGATIVE',
      scenario: scenario(g, txnSteps(g, 'N', amounts, { tpl: neg.tpl }), { tpl: neg.tpl }), expected: { pointsByRule: { [g.code]: 0 }, achievedTier: { [g.code]: 0 }, noDuplicateAwards: true } });
  } else {
    g.notes.push('No negative transaction could be derived automatically (the conditions accept every variation tried).');
  }
  genExclusions(g, valueAmounts(g, top));
  if (g.tpl.explicitMin && g.tpl.minAmount > 0.02) {
    const small = Math.round((g.tpl.minAmount - 0.01) * 100) / 100;
    const n = units === 'COUNT' ? top + 1 : Math.ceil(top / small) + 1;
    if (n <= 300) add(g, { name: `Amount just below the minimum (${label(small)})`, description: 'Transactions below the minimum qualifying amount do not count.', category: 'NEGATIVE',
      scenario: scenario(g, txnSteps(g, 'M', Array(n).fill(small))), expected: { pointsByRule: { [g.code]: 0 }, achievedTier: { [g.code]: 0 } } });
  }

  // Customer outside the eligibility rules, blocked customer.
  add(g, { name: 'Blocked customer earns nothing', description: 'Customers that are not ACTIVE are never rewarded.', category: 'ELIGIBILITY',
    scenario: scenario(g, txnSteps(g, 'B', valueAmounts(g, top) ?? []), { customer: { ...g.tpl.customer, status: 'BLOCKED' } }), expected: { pointsByRule: { [g.code]: 0 } } });
  const inelig = ineligibleCustomer(g);
  if (inelig) add(g, { name: `Outside eligibility (${inelig.desc})`, description: 'The customer does not satisfy the eligibility conditions.', category: 'ELIGIBILITY',
    scenario: scenario(g, txnSteps(g, 'E', valueAmounts(g, top) ?? []), { customer: inelig.customer, accounts: inelig.accounts }), expected: { pointsByRule: { [g.code]: 0 } } });

  // Duplicates.
  const firstAmounts = valueAmounts(g, T[0], false);
  if (firstAmounts) {
    const steps = txnSteps(g, 'D', firstAmounts);
    const last = steps[steps.length - 1];
    last.repeat = 3;
    last.resendAs = 2;
    const e = expect(T[0]);
    add(g, { name: 'Duplicate deliveries do not double count or double reward', description: 'The final transaction is redelivered 3 times with the same event id and twice more under new event ids.', category: 'DUPLICATE',
      scenario: scenario(g, steps), expected: { ...e, awards: awardEntries(g, reachedTier(def, T[0])), duplicateEvents: 3 } });
  }

  // Reversal / refund.
  const base = valueAmounts(g, T[0]);
  if (base) {
    const tier = reachedTier(def, T[0]);
    const clawback = def.handling.reversal === 'CLAWBACK';
    const steps: SimStep[] = txnSteps(g, 'R', base);
    const lastId = (steps[steps.length - 1] as SimTxnStep).id;
    steps.push({ kind: 'REVERSAL', id: `${lastId}-REV`, original: lastId, at: `${g.period.end}T23:00`, label: 'Last transaction fully reversed' });
    const pts = clawback ? 0 : tierPoints(g, tier);
    add(g, { name: `Reversal after the reward (${clawback ? 'claw back' : 'grandfather'})`, description: clawback ? 'Reversing a qualifying transaction withdraws the points it earned.' : 'The rule grandfathers rewards, so a reversal keeps them.', category: 'REVERSAL',
      scenario: scenario(g, steps), expected: { pointsByRule: { [g.code]: pts }, awards: awardEntries(g, tier), reversals: clawback ? awardEntries(g, tier) : 0, noDuplicateAwards: true } });
    if (units === 'SUM') {
      const above = Math.round((T[0] + (def.metric?.operator === 'GT' ? d : 0)) * 100) / 100;
      const amounts = valueAmounts(g, above, false);
      if (amounts && amounts[0] >= d) {
        const steps2: SimStep[] = txnSteps(g, 'F', amounts);
        const id = (steps2[0] as SimTxnStep).id;
        steps2.push({ kind: 'REFUND', id: `${id}-RF`, original: id, at: `${g.period.end}T23:00`, amount: d, label: `Partial refund of ${label(d)}` });
        add(g, { name: 'Partial refund drops spend below the threshold', description: 'A small partial refund reduces the qualifying amount; the reward is recalculated.', category: 'REFUND',
          scenario: scenario(g, steps2), expected: { pointsByRule: { [g.code]: clawback ? 0 : tierPoints(g, reachedTier(def, above)) }, noDuplicateAwards: true } });
      }
    } else if (base.length) {
      const steps2: SimStep[] = txnSteps(g, 'F', base);
      const id = (steps2[0] as SimTxnStep).id;
      steps2.push({ kind: 'REFUND', id: `${id}-RF`, original: id, at: `${g.period.end}T23:00`, amount: 0.01, label: 'Partial refund of ₹0.01' });
      add(g, { name: 'Partial refund does not remove a counted transaction', description: 'A partial refund leaves the transaction counted for count-based goals.', category: 'REFUND',
        scenario: scenario(g, steps2), expected: { ...expect(T[0]) } });
    }
  }

  // Status handling.
  if (!def.handling.countStatuses.includes('PENDING') && firstAmounts) {
    const pend = txnSteps(g, 'P', firstAmounts, { status: 'PENDING' });
    const steps: SimStep[] = [...pend, ...pend.map((p): SimStep => ({ kind: 'STATUS', id: p.id, at: p.at, status: 'POSTED', label: `${p.id} posts` }))];
    add(g, { name: 'Pending transactions count only once posted', description: 'Pending items earn nothing; when they post the goal is reached.', category: 'STATUS',
      scenario: scenario(g, steps), expected: expect(T[0]) });
    add(g, { name: 'Pending transactions are not counted', description: 'The same history, still pending at the end of the day, earns nothing.', category: 'STATUS',
      scenario: scenario(g, pend), expected: { pointsByRule: { [g.code]: 0 }, achievedTier: { [g.code]: 0 } } });
    const failed = txnSteps(g, 'X', valueAmounts(g, top) ?? [], { status: 'FAILED' });
    add(g, { name: 'Failed transactions never count', description: 'FAILED transactions are ignored.', category: 'STATUS', scenario: scenario(g, failed), expected: { pointsByRule: { [g.code]: 0 } } });
  }

  // Period edges.
  if (def.period.type !== 'CAMPAIGN' && g.next && (g.winTo === null || g.next.end <= g.winTo)) {
    const split = units === 'SUM' ? amountsForSum(g, T[0]) : amountsForCount(g, T[0]);
    const nextP = g.next;
    if (split && split.length >= 2 && nextP) {
      const base = txnSteps(g, 'E', split);
      const inside = base.map((s, i) => (i === 0 ? { ...s, at: `${g.period.start}T00:00` } : i === base.length - 1 ? { ...s, at: `${g.period.end}T23:59` } : s));
      add(g, { name: 'First and last minute of the period both count', description: `Transactions at 00:00 on ${g.period.start} and 23:59 on ${g.period.end} (${def.period.timezone}) belong to the same period.`, category: 'PERIOD',
        scenario: scenario(g, inside), expected: expect(T[0]) });
      const outside = base.map((s, i) => (i === 0 ? { ...s, at: `${g.period.start}T00:00` } : i === base.length - 1 ? { ...s, at: `${nextP.start}T00:00` } : s));
      add(g, { name: 'Transaction just after the period ends does not count', description: `The final transaction is at 00:00 on ${nextP.start}, in the next period, so ${g.period.key} falls short.`, category: 'PERIOD',
        scenario: scenario(g, outside, { asOf: nextP.start }), expected: { pointsByRule: { [g.code]: 0 }, noDuplicateAwards: true } });
    }
  }
  if (g.winFrom && firstAmounts) {
    const before = addDays(g.winFrom, -1);
    const steps = txnSteps(g, 'W', firstAmounts).map((s) => ({ ...s, at: `${before}T${timeFor(0)}` }));
    add(g, { name: 'Before the rule becomes effective', description: `Transactions on ${before}, the day before the rule or campaign starts, do not count.`, category: 'PERIOD',
      scenario: scenario(g, steps), expected: { pointsByRule: { [g.code]: 0 } } });
  }
  if (g.winTo && firstAmounts) {
    const after = addDays(g.winTo, 1);
    const steps = txnSteps(g, 'W', firstAmounts).map((s) => ({ ...s, at: `${after}T${timeFor(0)}` }));
    add(g, { name: 'After the rule or campaign ends', description: `Transactions on ${after}, after the window closes, do not count.`, category: 'PERIOD',
      scenario: scenario(g, steps, { asOf: after }), expected: { pointsByRule: { [g.code]: 0 } } });
  }
  // Late arrival after the period closed.
  if (firstAmounts && g.def.period.type !== 'CAMPAIGN') {
    const lateAt = `${addDays(g.period.end, def.period.lateGraceDays + 2)}T10:00`;
    const steps = txnSteps(g, 'L', firstAmounts).map((s) => ({ ...s, receivedAt: lateAt }));
    add(g, { name: 'Late-arriving data after the period closed earns nothing', description: `Events for ${g.period.key} arrive on ${lateAt.slice(0, 10)}, beyond the ${def.period.lateGraceDays}-day grace.`, category: 'PERIOD',
      scenario: scenario(g, steps, { asOf: lateAt.slice(0, 10) }), expected: { pointsByRule: { [g.code]: 0 }, achievedTier: { [g.code]: 0 } } });
  }
}

function ineligibleCustomer(g: GenCtx): { desc: string; customer: SimCustomer; accounts: SimAccount[] } | null {
  const t = g.tpl;
  const amount = Math.max(t.minAmount, 100);
  const options: { desc: string; customer?: Partial<SimCustomer>; account?: Partial<SimAccount>; segments?: string[] }[] = [
    { desc: 'no customer segments', customer: { segments: [] } },
    ...g.ref.segments.filter((s) => !(t.customer.segments ?? []).includes(s)).map((s) => ({ desc: `segment ${s} only`, customer: { segments: [s] } })),
    { desc: 'KYC pending', customer: { kycStatus: 'PENDING' as const } },
    { desc: 'KYC minimal', customer: { kycStatus: 'MINIMAL' as const } },
    { desc: 'SME customer', customer: { type: 'SME' as const } },
    { desc: 'account frozen', account: { status: 'FROZEN' as const } },
    { desc: 'account dormant', account: { status: 'DORMANT' as const } },
  ];
  for (const o of options) {
    const cust = { ...t.customer, ...(o.customer ?? {}) };
    const acc = { ...t.account, ...(o.account ?? {}) };
    const probe = { ...t, customer: cust, account: acc };
    if (!qualifies(g.def, probe, amount)) return { desc: o.desc, customer: cust, accounts: [acc] };
  }
  return null;
}

// ---------------------------------------------------------------------
// Case builders: per-event rewards
// ---------------------------------------------------------------------
function genPerEvent(g: GenCtx) {
  const { def } = g;
  const pe = def.perEvent!;
  const perTxn = (amount: number) => (pe.mode === 'FIXED' ? pe.points : Math.floor(cents(amount) / cents(pe.perAmount ?? 1)) * pe.points);
  const unit = pe.mode === 'PER_AMOUNT' ? pe.perAmount ?? 1 : Math.max(g.tpl.minAmount, 100);
  const amt = Math.max(g.tpl.minAmount, pe.mode === 'PER_AMOUNT' ? unit * 3 + unit / 2 : 100);
  const capped = (n: number) => capPoints(g, n);
  const mk = (amounts: number[], extra: Partial<SimTxnStep>[] = []) => txnSteps(g, 'P', amounts).map((s, i) => ({ ...s, ...(extra[i] ?? {}) }));

  add(g, { name: 'Single qualifying transaction', description: pe.mode === 'FIXED' ? `Earns a fixed ${pe.points} XP.` : `Earns ${pe.points} XP per ₹${unit}.`, category: 'POSITIVE',
    scenario: scenario(g, mk([amt])), expected: { pointsByRule: { [g.code]: capped(perTxn(amt)) }, noDuplicateAwards: true } });
  add(g, { name: 'Three qualifying transactions', description: 'Each transaction is rewarded independently.', category: 'POSITIVE',
    scenario: scenario(g, mk([amt, amt, amt])), expected: { pointsByRule: { [g.code]: capped(3 * perTxn(amt)) }, noDuplicateAwards: true } });
  if (pe.mode === 'PER_AMOUNT') {
    const below = Math.round((unit - 0.01) * 100) / 100;
    if (below >= g.tpl.minAmount && below > 0) add(g, { name: `Just below one reward unit (₹${below})`, description: 'Less than one unit of the per-amount reward earns nothing.', category: 'BOUNDARY',
      scenario: scenario(g, mk([below])), expected: { pointsByRule: { [g.code]: 0 } } });
    add(g, { name: `Exactly one reward unit (₹${unit})`, description: `₹${unit} earns exactly ${pe.points} XP.`, category: 'BOUNDARY',
      scenario: scenario(g, mk([Math.max(unit, g.tpl.minAmount)])), expected: { pointsByRule: { [g.code]: capped(perTxn(Math.max(unit, g.tpl.minAmount))) } } });
  }
  const periodCap = def.limits.capPointsPerPeriod;
  if (periodCap !== null && periodCap !== undefined && perTxn(amt) > 0) {
    const n = Math.min(300, Math.ceil(periodCap / perTxn(amt)) + 2);
    add(g, { name: `Period cap of ${periodCap} XP holds`, description: 'More qualifying transactions than the cap allows; points stop at the cap.', category: 'CAP',
      scenario: scenario(g, mk(Array(n).fill(amt))), expected: { pointsByRule: { [g.code]: capped(n * perTxn(amt)) }, noDuplicateAwards: true } });
  }
  const neg = negativeTemplate(g, amt);
  if (neg) add(g, { name: `Non-qualifying transaction (${neg.desc})`, description: 'Outside the qualifying conditions.', category: 'NEGATIVE',
    scenario: scenario(g, txnSteps(g, 'N', [amt], { tpl: neg.tpl }), { tpl: neg.tpl }), expected: { pointsByRule: { [g.code]: 0 } } });
  genExclusions(g, [amt], true);
  const steps = mk([amt]);
  (steps[0] as SimTxnStep).repeat = 3;
  (steps[0] as SimTxnStep).resendAs = 2;
  add(g, { name: 'Duplicate deliveries earn once', description: 'The same transaction delivered several times is rewarded once.', category: 'DUPLICATE',
    scenario: scenario(g, steps), expected: { pointsByRule: { [g.code]: capped(perTxn(amt)) }, awards: perTxn(amt) > 0 ? 1 : 0, noDuplicateAwards: true, duplicateEvents: 3 } });
  const rev: SimStep[] = [...mk([amt]), { kind: 'REVERSAL', id: 'P-1-REV', original: 'P-1', at: `${g.period.end}T23:00` }];
  const claw = def.handling.reversal === 'CLAWBACK';
  add(g, { name: `Reversal (${claw ? 'claw back' : 'grandfather'})`, description: 'Reversing the transaction takes the reward back unless the rule grandfathers.', category: 'REVERSAL',
    scenario: scenario(g, rev), expected: { pointsByRule: { [g.code]: claw ? 0 : capped(perTxn(amt)) } } });
  add(g, { name: 'Blocked customer earns nothing', description: 'Customers that are not ACTIVE are never rewarded.', category: 'ELIGIBILITY',
    scenario: scenario(g, mk([amt]), { customer: { ...g.tpl.customer, status: 'BLOCKED' } }), expected: { pointsByRule: { [g.code]: 0 } } });
}

// ---------------------------------------------------------------------
// Case builders: balance goals
// ---------------------------------------------------------------------
function balanceSteps(g: GenCtx, accountRef: string, pattern: (day: string, i: number, n: number) => number | null, opts: { from?: string; to?: string } = {}): SimStep[] {
  const from = opts.from ?? g.period.start;
  const to = opts.to ?? g.period.end;
  const steps: SimStep[] = [];
  const n = daysBetween(from, to) + 1;
  for (let i = 0; i < n; i++) {
    const day = addDays(from, i);
    const v = pattern(day, i, n);
    if (v !== null) steps.push({ kind: 'BALANCE', account: accountRef, date: day, balance: Math.round(v * 100) / 100 });
  }
  return mergeRuns(steps);
}

/** Collapses consecutive equal balances into range steps to keep scenarios compact. */
function mergeRuns(steps: SimStep[]): SimStep[] {
  const out: SimStep[] = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (s.kind === 'BALANCE' && last && last.kind === 'BALANCE' && last.balance === s.balance && last.account === s.account && addDays(last.toDate ?? last.date, 1) === s.date) {
      last.toDate = s.date;
    } else out.push({ ...s });
  }
  return out;
}

function genBalance(g: GenCtx) {
  const { def } = g;
  const metric = def.metric!.type;
  const acc = g.tpl.account.ref;
  const T = def.tiers.map((t) => t.threshold);
  const top = T[T.length - 1];
  const asOf = addDays(g.period.end, 1);
  const expect = (value: number): SimExpected => {
    const tier = reachedTier(def, value);
    return { pointsByRule: { [g.code]: tierPoints(g, tier) }, achievedTier: { [g.code]: tier }, noDuplicateAwards: true };
  };
  const sc = (steps: SimStep[], o: { asOf?: string; customer?: SimCustomer; accounts?: SimAccount[] } = {}) => scenario(g, steps, { asOf: o.asOf ?? asOf, customer: o.customer, accounts: o.accounts });
  const nDays = daysBetween(g.period.start, g.period.end) + 1;
  const gap = g.def.balancePolicy.gapFill === 'CARRY_FORWARD';

  if (metric === 'AVG_BALANCE' || metric === 'MIN_BALANCE') {
    const name = metric === 'AVG_BALANCE' ? 'average' : 'minimum';
    def.tiers.forEach((t, i) => {
      add(g, { name: `Flat balance exactly at tier ${i + 1} (₹${t.threshold.toLocaleString('en-IN')})`, description: `The ${name} daily closing balance equals the threshold.`, category: i === 0 ? 'BOUNDARY' : 'POSITIVE',
        scenario: sc(balanceSteps(g, acc, () => t.threshold)), expected: expect(t.threshold) });
    });
    add(g, { name: `Flat balance just below tier 1`, description: `One paisa below the first threshold: no reward.`, category: 'BOUNDARY',
      scenario: sc(balanceSteps(g, acc, () => T[0] - 0.01)), expected: expect(T[0] - 0.01) });
    add(g, { name: capPointsText(g) ? 'Well above top tier: caps hold' : 'Well above top tier', description: 'Comfortably above every threshold.', category: capPointsText(g) ? 'CAP' : 'POSITIVE',
      scenario: sc(balanceSteps(g, acc, () => top * 1.5)), expected: expect(top * 1.5) });
    if (metric === 'AVG_BALANCE') {
      const x = Math.min(T[0] * 0.5, 20000);
      const k = Math.floor(nDays / 2);
      add(g, { name: 'Fluctuating balance averaging exactly the threshold', description: `Half the days above and half below ${T[0]}, average exactly equal.`, category: 'BOUNDARY',
        scenario: sc(balanceSteps(g, acc, (_d, i) => (i < k ? T[0] + x : i < 2 * k ? T[0] - x : T[0]))), expected: expect(T[0]) });
      if (T[0] >= 0.01 * nDays) {
        add(g, { name: 'Fluctuating balance averaging just below the threshold', description: 'One low day pulls the average one paisa under the line.', category: 'BOUNDARY',
          scenario: sc(balanceSteps(g, acc, (_d, i) => (i === 0 ? T[0] - 0.01 * nDays : T[0]))), expected: expect(T[0] - 0.01) });
      }
    } else {
      add(g, { name: 'One low day breaks the minimum', description: 'A single day below the threshold means the minimum balance goal is not met.', category: 'NEGATIVE',
        scenario: sc(balanceSteps(g, acc, (_d, i) => (i === Math.floor(nDays / 2) ? T[0] - 1 : top * 1.2))), expected: expect(Math.min(T[0] - 1, top * 1.2)) });
    }
    // Data quality
    const miss = Math.floor(nDays / 2);
    add(g, { name: gap ? 'Missing snapshot day is carried forward' : 'Missing snapshot day: no reward is decided', description: gap ? 'Policy CARRY_FORWARD fills the gap with the previous closing balance.' : 'With incomplete balance data MXP never guesses: no reward and status DATA_UNAVAILABLE.', category: 'DATA',
      scenario: sc(balanceSteps(g, acc, (_d, i) => (i === miss ? null : top * 1.5))),
      expected: gap ? expect(top * 1.5) : { pointsByRule: { [g.code]: 0 }, progressStatus: { [g.code]: 'DATA_UNAVAILABLE' } } });
    add(g, { name: 'Mid-period reading never pays early', description: 'Balances only for the first half of the period; the goal cannot be decided yet.', category: 'PERIOD',
      scenario: sc(balanceSteps(g, acc, () => top * 1.5, { to: addDays(g.period.start, Math.max(0, Math.floor(nDays / 2) - 1)) }), { asOf: addDays(g.period.start, Math.max(0, Math.floor(nDays / 2) - 1)) }),
      expected: { pointsByRule: { [g.code]: 0 } } });
  } else {
    // BALANCE_GROWTH
    const open = 10000;
    const gstep = (grow: number): SimStep[] => [
      ...balanceSteps(g, acc, () => open, { from: addDays(g.period.start, -1), to: addDays(g.period.end, -1) }),
      { kind: 'BALANCE', account: acc, date: g.period.end, balance: Math.round((open + grow) * 100) / 100 },
    ];
    def.tiers.forEach((t, i) => {
      add(g, { name: `Growth exactly ₹${t.threshold.toLocaleString('en-IN')} (tier ${i + 1})`, description: 'Closing balance minus opening balance equals the threshold.', category: i === 0 ? 'BOUNDARY' : 'POSITIVE',
        scenario: sc(gstep(t.threshold)), expected: expect(t.threshold) });
    });
    add(g, { name: 'Growth one paisa short of tier 1', description: 'Just under the threshold earns nothing.', category: 'BOUNDARY', scenario: sc(gstep(T[0] - 0.01)), expected: expect(T[0] - 0.01) });
    add(g, { name: 'Balance falls during the period', description: 'Negative growth earns nothing.', category: 'NEGATIVE', scenario: sc(gstep(-500)), expected: { pointsByRule: { [g.code]: 0 } } });
    add(g, { name: 'Well above top tier', description: 'Growth far above every threshold.', category: capPointsText(g) ? 'CAP' : 'POSITIVE', scenario: sc(gstep(top * 1.5)), expected: expect(top * 1.5) });
    add(g, { name: 'Opening balance missing: no reward is decided', description: 'Growth needs the opening balance; without it MXP will not guess.', category: 'DATA',
      scenario: sc([{ kind: 'BALANCE', account: acc, date: g.period.end, balance: open + top * 1.5 }]), expected: { pointsByRule: { [g.code]: 0 }, progressStatus: { [g.code]: 'DATA_UNAVAILABLE' } } });
  }

  add(g, { name: 'Blocked customer earns nothing', description: 'Customers that are not ACTIVE are never rewarded.', category: 'ELIGIBILITY',
    scenario: sc(balanceSteps(g, acc, () => top * 1.5), { customer: { ...g.tpl.customer, status: 'BLOCKED' } }), expected: { pointsByRule: { [g.code]: 0 } } });
  const bad = ineligibleCustomer(g);
  if (bad) add(g, { name: `Outside eligibility (${bad.desc})`, description: 'The customer or account does not satisfy the conditions.', category: 'ELIGIBILITY',
    scenario: sc(balanceSteps(g, acc, () => top * 1.5), { customer: bad.customer, accounts: bad.accounts }), expected: { pointsByRule: { [g.code]: 0 } } });
}

function capPointsText(g: GenCtx) {
  const l = g.def.limits;
  return (l.capPointsPerPeriod ?? null) !== null || (l.capPointsLifetime ?? null) !== null || g.budget !== null;
}

// ---------------------------------------------------------------------
// Combined goals
// ---------------------------------------------------------------------
function genCombined(source: RuleSource, g: GenCtx) {
  const comps = g.def.combined!.components;
  const frags: { code: string; def: RuleDefinition; tpl: TxnTemplate; ctx: GenCtx }[] = [];
  comps.forEach((c, i) => {
    const s = source.rule(c.ruleCode);
    if (!s) return;
    const tpl = isBalanceMetric(s.def.metric?.type) ? buildAccountTemplate(s.def, g.ref, `ACC-C${i + 1}`) : buildTemplate(s.def, g.ref, `ACC-C${i + 1}`);
    if (!tpl.ok) g.notes.push(`Component ${c.ruleCode}: ${tpl.notes.join(' ')}`);
    frags.push({ code: c.ruleCode, def: s.def, tpl, ctx: { ...g, code: c.ruleCode, def: s.def, tpl, cases: [] } });
  });
  if (frags.length !== comps.length || frags.some((f) => !f.tpl.ok)) {
    g.notes.push('Combined scenarios were not generated because a component rule could not be translated into a scenario.');
    return;
  }
  const reach = (f: (typeof frags)[number], tierNo: number, idx: number): SimStep[] | null => {
    const T = f.def.tiers[Math.max(0, tierNo - 1)].threshold;
    const fc = f.ctx;
    if (isBalanceMetric(f.def.metric?.type)) {
      const m = f.def.metric!.type;
      if (m === 'BALANCE_GROWTH') {
        return [
          ...balanceSteps(fc, f.tpl.account.ref, () => 10000, { from: addDays(g.period.start, -1), to: addDays(g.period.end, -1) }),
          { kind: 'BALANCE', account: f.tpl.account.ref, date: g.period.end, balance: 10000 + T * (f.def.metric?.operator === 'GT' ? 1.1 : 1) },
        ];
      }
      return balanceSteps(fc, f.tpl.account.ref, () => T * (f.def.metric?.operator === 'GT' ? 1.1 : 1));
    }
    const units = metricUnitsOf(f.def);
    const value = f.def.metric?.operator === 'GT' ? (units === 'COUNT' ? T + 1 : T + 0.01) : T;
    const amounts = valueAmounts(fc, value);
    return amounts ? txnSteps(fc, `C${idx + 1}`, amounts, { tpl: f.tpl }) : null;
  };
  const parts = frags.map((f, i) => ({ f, steps: reach(f, comps[i].minTier, i) }));
  if (parts.some((p) => !p.steps)) {
    g.notes.push('Combined scenarios skipped: a component goal cannot be reached within its per-transaction limits.');
    return;
  }
  const hasBalance = frags.some((f) => isBalanceMetric(f.def.metric?.type));
  const asOf = hasBalance ? addDays(g.period.end, 1) : g.period.end;
  const accounts = frags.map((f) => f.tpl.account);
  const customer = frags[0].tpl.customer;
  const m = comps.length;
  const expectFor = (met: number): SimExpected => {
    const tier = reachedTier(g.def, met);
    return { pointsByRule: { [g.code]: tierPoints(g, tier) }, achievedTier: { [g.code]: tier }, noDuplicateAwards: true };
  };
  const mkScenario = (idx: number[]) => ({
    timezone: g.def.period.timezone, customer, accounts, asOf,
    steps: idx.flatMap((i) => parts[i].steps!) as SimStep[],
  });
  add(g, { name: `All ${m} component goals met`, description: 'Meeting every component earns the combined reward.', category: 'COMBINED', scenario: mkScenario(parts.map((_, i) => i)), expected: expectFor(m) });
  add(g, { name: 'No component goal met', description: 'Nothing happens.', category: 'NEGATIVE', scenario: { timezone: g.def.period.timezone, customer, accounts, asOf, steps: [] }, expected: expectFor(0) });
  if (m > 1) {
    parts.forEach((p, i) => {
      add(g, { name: `Only ${p.f.code} met`, description: `Meeting one of ${m} components reaches the combined tier for ${1} component(s).`, category: 'COMBINED', scenario: mkScenario([i]), expected: expectFor(1) });
    });
    if (m > 2) add(g, { name: `${m - 1} of ${m} components met`, description: 'Partial achievement.', category: 'COMBINED', scenario: mkScenario(parts.slice(0, m - 1).map((_, i) => i)), expected: expectFor(m - 1) });
  }
  // Reversal of a transaction-based component after the combined reward was granted.
  const txnPart = parts.findIndex((p) => !isBalanceMetric(p.f.def.metric?.type) && p.steps!.some((s) => s.kind === 'TXN'));
  if (txnPart >= 0 && g.def.handling.reversal === 'CLAWBACK') {
    const last = [...parts[txnPart].steps!].reverse().find((s) => s.kind === 'TXN') as SimTxnStep;
    const full = mkScenario(parts.map((_, i) => i));
    full.steps = [...full.steps, { kind: 'REVERSAL', id: `${last.id}-REV`, original: last.id, at: `${g.period.end}T23:00`, label: `${last.id} reversed` }];
    add(g, { name: 'Reversal of a component transaction withdraws the combined reward', description: 'The component is no longer met, so the combined tier is lost and its points reversed.', category: 'REVERSAL',
      scenario: full, expected: { ...expectFor(m - 1) } });
  }
  add(g, { name: 'Blocked customer earns nothing', description: 'Customers that are not ACTIVE are never rewarded.', category: 'ELIGIBILITY',
    scenario: { ...mkScenario(parts.map((_, i) => i)), customer: { ...customer, status: 'BLOCKED' } }, expected: expectFor(0) });
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------
export function generateMatrix(source: RuleSource, input: SimRuleRef): MatrixResult {
  seq = 0;
  const stored = input.definition === undefined ? source.rule(input.ruleCode, input.versionNo) : undefined;
  const def = input.definition !== undefined ? normalizeDefinition(input.definition) : stored?.def;
  if (!def) return { ruleCode: input.ruleCode, versionNo: input.versionNo ?? 0, cases: [], notes: [`Rule ${input.ruleCode} was not found.`] };
  const versionNo = stored?.versionNo ?? (source.rule(input.ruleCode)?.versionNo ?? 0) + 1;
  const ref = refData(source);
  const campaign = def.campaignCode ? source.campaign(def.campaignCode) : undefined;
  const campaignWindow = campaign ? { code: campaign.campaign_code, start: campaign.start_date, end: campaign.end_date } : null;
  const froms = [def.effective.from, campaign?.start_date].filter(Boolean) as string[];
  const tos = [def.effective.to, campaign?.end_date].filter(Boolean) as string[];
  const winFrom = froms.length ? froms.sort().at(-1)! : null;
  const winTo = tos.length ? tos.sort()[0] : null;
  const notes: string[] = [];
  if (def.period.type === 'CAMPAIGN' && !campaignWindow) return { ruleCode: input.ruleCode, versionNo, cases: [], notes: ['A CAMPAIGN period needs a campaign.'] };
  const { period, next } = pickPeriod(def, campaignWindow, winFrom);
  if (winTo && period.end > winTo) notes.push(`The test period ${period.key} extends beyond the rule window (${winTo}); some boundary cases are skipped.`);
  if (daysBetween(period.start, period.end) > 400) {
    return { ruleCode: input.ruleCode, versionNo, cases: [], notes: ['The period is too long to generate scenarios automatically.'] };
  }
  const balanceRule = isBalanceMetric(def.metric?.type);
  const tpl = def.kind === 'COMBINED'
    ? ({ ok: true, notes: [], type: 'PURCHASE', channel: 'MOBILE_APP', drCr: 'D', attributes: {}, minAmount: 1, maxAmount: null, account: { ref: 'ACC-MAIN', productCode: 'SAV_REGULAR' }, family: 'SAVINGS', instrumentType: null, customer: {} } as TxnTemplate)
    : balanceRule ? buildAccountTemplate(def, ref) : buildTemplate(def, ref);
  notes.push(...tpl.notes);
  const g: GenCtx = {
    code: input.ruleCode, versionNo, def, ref, tpl, period, next, winFrom, winTo, budget: campaign?.points_budget ?? null, campaignWindow, notes, cases: [],
  };
  if (!tpl.ok) {
    notes.push('No scenarios were generated automatically for this rule.');
    return { ruleCode: input.ruleCode, versionNo, cases: [], notes };
  }
  if (def.tiers.length === 0 && def.kind !== 'PER_EVENT') {
    return { ruleCode: input.ruleCode, versionNo, cases: [], notes: [...notes, 'The rule has no tiers.'] };
  }
  if (input.definition !== undefined) g.cases.forEach((c) => (c.rules = [{ ruleCode: input.ruleCode, definition: input.definition }]));
  if (def.kind === 'COMBINED') genCombined(source, g);
  else if (def.kind === 'PER_EVENT') genPerEvent(g);
  else if (balanceRule) genBalance(g);
  else genTxnGoal(g);
  const rules: SimRuleRef[] = input.definition !== undefined ? [{ ruleCode: input.ruleCode, definition: input.definition }] : [{ ruleCode: input.ruleCode, versionNo }];
  for (const c of g.cases) c.rules = rules;
  return { ruleCode: input.ruleCode, versionNo, cases: g.cases, notes };
}

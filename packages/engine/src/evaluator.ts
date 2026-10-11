import type { Db } from './db';
import { evalNode, type NodeResult, type Facts } from './conditions';
import {
  accountFacts,
  customerFacts,
  instrumentTypeOf,
  loadAccount,
  loadCustomerContext,
  txnFacts,
  type CustomerContext,
  type EngineCtx,
  type TxnRow,
} from './context';
import { computeBalanceMetric, ensureProgress, getProgress, reconcileContribution, tierReached, type ProgressRow } from './aggregate';
import { postLedger, reversibleAwards, slotAwardCount, slotNet, type LedgerEntry } from './ledger';
import { createNudge, fmtMetric } from './nudge';
import { getLiveRules, type LiveRule } from './ruleRepo';
import { addDays, localDate, periodOf, type Period } from './time';
import { MxpError, toMinor, uid } from './util';

// ---------------------------------------------------------------------
// Pass state
// ---------------------------------------------------------------------
export type Trigger = 'TXN' | 'SNAPSHOT' | 'PERIOD_CLOSE' | 'REPLAY' | 'COMBINED';
type Outcome =
  | 'INELIGIBLE'
  | 'NOT_QUALIFYING'
  | 'IN_PROGRESS'
  | 'ACHIEVED'
  | 'AWARDED'
  | 'REVERSED'
  | 'NO_CHANGE'
  | 'CAPPED'
  | 'SUPPRESSED'
  | 'DATA_UNAVAILABLE'
  | 'PERIOD_CLOSED'
  | 'ERROR';

export interface EvalDraft {
  evaluationId: string;
  rule: LiveRule;
  customerId: string;
  periodKey: string | null;
  txnId: string | null;
  trigger: Trigger;
  eligible: boolean;
  outcome: Outcome;
  reasonCode: string;
  reasonText: string;
  metricValue: number | null;
  pointsTarget: number | null;
  pointsDelta: number;
  trace: Record<string, unknown>;
  progress?: ProgressRow;
  valueIncreased?: boolean;
}

interface PlanItem {
  draft: EvalDraft;
  slot: string;
  tierNo: number | null;
  label: string | null;
  target: number;
  allowDown: boolean;
  upBlock?: { code: string; text: string };
  // computed during resolution
  net: number;
  delta: number;
  action: 'NONE' | 'AWARD' | 'REVERSE';
  grant: number;
  blocked?: { code: string; text: string; outcome: Outcome };
  posted: LedgerEntry[];
}

export interface Pass {
  ctx: EngineCtx;
  eventId: string | null;
  trigger: Trigger;
  drafts: EvalDraft[];
  plans: PlanItem[];
  /** rule|period -> whether the period lost progress in this pass */
  touched: Map<string, { ruleId: string; periodKey: string; negative: boolean; customerId: string }>;
  filter?: (r: LiveRule) => boolean;
}

export interface PassResult {
  evaluations: EvalDraft[];
  ledger: LedgerEntry[];
}

function newPass(ctx: EngineCtx, eventId: string | null, trigger: Trigger, filter?: (r: LiveRule) => boolean): Pass {
  return { ctx, eventId, trigger, drafts: [], plans: [], touched: new Map(), filter };
}

const todayIn = (ctx: EngineCtx, tz: string) => localDate(ctx.clock.now().toISOString(), tz);

function newDraft(pass: Pass, rule: LiveRule, customerId: string, periodKey: string | null, txnId: string | null, partial: Partial<EvalDraft> = {}): EvalDraft {
  const d: EvalDraft = {
    evaluationId: uid(),
    rule,
    customerId,
    periodKey,
    txnId,
    trigger: pass.trigger,
    eligible: false,
    outcome: 'NOT_QUALIFYING',
    reasonCode: 'NOT_EVALUATED',
    reasonText: '',
    metricValue: null,
    pointsTarget: null,
    pointsDelta: 0,
    trace: {},
    ...partial,
  };
  pass.drafts.push(d);
  return d;
}

function markTouched(pass: Pass, rule: LiveRule, customerId: string, periodKey: string, negative: boolean) {
  const k = `${rule.ruleId}|${periodKey}`;
  const cur = pass.touched.get(k);
  pass.touched.set(k, { ruleId: rule.ruleId, periodKey, negative: negative || !!cur?.negative, customerId });
}

// ---------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------
function enrolled(ctx: EngineCtx, rule: LiveRule, customerId: string): { ok: boolean; reason?: string } {
  const c = rule.campaign;
  if (!c) return { ok: true };
  const { db, clock } = ctx;
  const row = db.get<{ status: string }>('SELECT status FROM customer_enrollment WHERE customer_id = ? AND campaign_id = ?', customerId, c.campaign_id);
  if (row) return row.status === 'ENROLLED' ? { ok: true } : { ok: false, reason: 'OPTED_OUT' };
  if (c.enrollment_mode === 'OPT_IN') return { ok: false, reason: 'NOT_ENROLLED' };
  db.run(`INSERT OR IGNORE INTO customer_enrollment(customer_id, campaign_id, status, source, enrolled_at) VALUES (?,?,?,?,?)`, customerId, c.campaign_id, 'ENROLLED', 'AUTO', clock.now().toISOString());
  return { ok: true };
}

function inWindow(rule: LiveRule, date: string): boolean {
  return (!rule.windowFrom || date >= rule.windowFrom) && (!rule.windowTo || date <= rule.windowTo);
}

// ---------------------------------------------------------------------
// Transaction-driven evaluation
// ---------------------------------------------------------------------
export function processTransaction(ctx: EngineCtx, txnId: string, eventId: string | null, trigger: Trigger = 'TXN', filter?: (r: LiveRule) => boolean): PassResult {
  const { db, clock } = ctx;
  const txn = db.get<TxnRow>('SELECT * FROM txn_master WHERE txn_id = ?', txnId);
  if (!txn) throw new MxpError('NOT_FOUND', `Transaction ${txnId} not found.`, 404);
  const pass = newPass(ctx, eventId, trigger, filter);
  if (!txn.is_reversal) {
    const cc = loadCustomerContext(db, txn.customer_id, todayIn(ctx, 'Asia/Kolkata'));
    if (!cc) throw new MxpError('NOT_FOUND', `Customer ${txn.customer_id} not found.`, 404);
    const account = loadAccount(db, txn.account_id);
    const instType = instrumentTypeOf(db, txn.instrument_ref);
    for (const rule of getLiveRules(db)) {
      if (rule.isBalance || rule.def.kind === 'COMBINED') continue;
      if (filter && !filter(rule)) continue;
      evaluateTxnForRule(pass, rule, txn, cc, account, instType);
    }
    evaluateCombined(pass, txn.customer_id);
  }
  const result = resolveAndPost(pass);
  db.run(`UPDATE txn_master SET processing_status = 'EVALUATED', last_evaluated_at = ? WHERE txn_id = ?`, clock.now().toISOString(), txnId);
  return result;
}

function basisDate(txn: TxnRow, rule: LiveRule): string {
  const tz = rule.def.period.timezone;
  if (rule.def.period.dateBasis === 'POSTING_DATE' && txn.posting_date) return txn.posting_date;
  return localDate(txn.txn_ts, tz);
}

function evaluateTxnForRule(
  pass: Pass,
  rule: LiveRule,
  txn: TxnRow,
  cc: CustomerContext,
  account: ReturnType<typeof loadAccount>,
  instType: string | null,
) {
  const { ctx } = pass;
  const { db, clock, config } = ctx;
  const def = rule.def;
  const tz = def.period.timezone;
  const hasContribs = (db.value<number>('SELECT COUNT(*) FROM goal_contribution WHERE txn_id = ? AND rule_version_id = ?', txn.txn_id, rule.ruleVersionId) ?? 0) > 0;
  const inScope =
    (def.scope.channels.length === 0 || def.scope.channels.includes(txn.channel_code)) &&
    (def.scope.productCodes.length === 0 || def.scope.productCodes.includes(txn.product_code ?? ''));
  if (!inScope && !hasContribs) return;

  const date = basisDate(txn, rule);
  const facts: Facts = {
    ...txnFacts(txn, tz, instType),
    ...accountFacts(account, date),
    ...customerFacts(cc),
  };
  const elig = evalNode(def.eligibility, facts);
  const qual = evalNode(def.qualifying, facts);
  const period = periodOf(date, def.period.type, rule.campaignWindow);

  // Why (not) counted -- first failing check wins.
  let reasonCode = 'QUALIFIED';
  let reasonText = 'Transaction meets all conditions.';
  let counts = true;
  const fail = (c: string, t: string) => {
    if (counts) {
      counts = false;
      reasonCode = c;
      reasonText = t;
    }
  };
  if (!inScope) fail('OUT_OF_SCOPE', 'Channel or product is outside the rule scope.');
  if (cc.customer.status !== 'ACTIVE') fail('CUSTOMER_NOT_ACTIVE', `Customer status is ${cc.customer.status}.`);
  if (!elig.pass) fail('INELIGIBLE', 'Customer or account eligibility conditions not met.');
  if (counts) {
    const en = enrolled(ctx, rule, txn.customer_id);
    if (!en.ok) fail(en.reason ?? 'NOT_ENROLLED', 'Customer is not enrolled in the campaign.');
  }
  if (!inWindow(rule, date)) fail('OUTSIDE_EFFECTIVE_WINDOW', `Transaction date ${date} is outside the rule's effective window.`);
  if (!qual.pass) fail('CONDITIONS_NOT_MET', 'Qualifying conditions not met.');
  const st = txn.status;
  const statusCounts =
    (st === 'POSTED' || st === 'PARTIALLY_REFUNDED') ? def.handling.countStatuses.includes('POSTED') : st === 'PENDING' ? def.handling.countStatuses.includes('PENDING') : true;
  if (!statusCounts) fail('STATUS_NOT_COUNTED', `Transactions with status ${st} do not count for this rule.`);

  let amountMinor = 0;
  let count = 0;
  if (counts) {
    if (st === 'REVERSED' || st === 'REFUNDED' || st === 'FAILED') {
      reasonCode = 'REVERSED_OR_REFUNDED';
      reasonText = `Transaction is ${st}; its contribution is withdrawn.`;
    } else {
      count = 1;
      amountMinor = st === 'PARTIALLY_REFUNDED' ? txn.amount_minor - txn.refunded_minor : txn.amount_minor;
      if (st === 'PARTIALLY_REFUNDED') {
        reasonCode = 'PARTIALLY_REFUNDED';
        reasonText = `Counted net of the ${txn.refunded_minor / 100} refunded.`;
      }
    }
  }

  const changes = reconcileContribution(db, clock, rule, txn.customer_id, txn.txn_id, pass.eventId, { period, amountMinor, count });
  const draftBase: Partial<EvalDraft> = {
    eligible: elig.pass,
    reasonCode,
    reasonText,
    trace: config.storeTrace
      ? {
          txn: { id: txn.txn_id, sourceTxnId: txn.source_txn_id, amount: txn.amount_minor / 100, status: st, date },
          period: period.key,
          eligibility: elig,
          qualifying: qual,
          contribution: { amount: amountMinor / 100, count, changes: changes.map((c) => ({ period: c.periodKey, amountDelta: c.amountDelta / 100, countDelta: c.countDelta })) },
        }
      : {},
  };

  const touchedKeys = new Set<string>(changes.map((c) => c.periodKey));
  if (count > 0) touchedKeys.add(period.key);
  if (touchedKeys.size === 0) {
    newDraft(pass, rule, txn.customer_id, period.key, txn.txn_id, {
      ...draftBase,
      outcome: !elig.pass || cc.customer.status !== 'ACTIVE' ? 'INELIGIBLE' : 'NOT_QUALIFYING',
    });
    return;
  }

  for (const key of touchedKeys) {
    const change = changes.find((c) => c.periodKey === key);
    const negative = !!change && (change.amountDelta < 0 || change.countDelta < 0);
    const per = key === period.key ? period : periodFromProgress(db, txn.customer_id, rule, key, rule.def.period.type);
    const progress = ensureProgress(db, clock, txn.customer_id, rule, per);
    const closedLate = todayIn(ctx, tz) > addDays(per.end, def.period.lateGraceDays);
    const refreshed = refreshProgress(ctx, rule, progress, closedLate);
    const draft = newDraft(pass, rule, txn.customer_id, key, txn.txn_id, {
      ...draftBase,
      metricValue: refreshed.metric_value,
      progress: refreshed,
      valueIncreased: !!change && (change.amountDelta > 0 || change.countDelta > 0),
      reasonCode: key === period.key ? reasonCode : 'PERIOD_CHANGED',
      reasonText: key === period.key ? reasonText : `Transaction moved out of period ${key}.`,
    });
    markTouched(pass, rule, txn.customer_id, key, negative);
    const upBlock = closedLate ? { code: 'PERIOD_CLOSED', text: `Period ${key} closed on ${per.end}; late data cannot add rewards.` } : undefined;

    if (def.kind === 'PER_EVENT') {
      const target = perEventPoints(rule, key === period.key ? amountMinor : 0, key === period.key ? count : 0);
      pass.plans.push(planItem(draft, `txn:${txn.txn_id}`, null, null, target, negative, upBlock));
    } else {
      pass.plans.push(...tierPlans(draft, rule, refreshed, negative, upBlock));
    }
  }
}

function periodFromProgress(db: Db, customerId: string, rule: LiveRule, key: string, type: Period['type']): Period {
  const row = db.get<{ period_start: string; period_end: string }>('SELECT period_start, period_end FROM goal_progress WHERE customer_id = ? AND rule_version_id = ? AND period_key = ?', customerId, rule.ruleVersionId, key);
  if (!row) throw new MxpError('NOT_FOUND', `Progress ${key} not found.`);
  return { type, key, start: row.period_start, end: row.period_end };
}

function perEventPoints(rule: LiveRule, amountMinor: number, count: number): number {
  const pe = rule.def.perEvent;
  if (!pe || count <= 0) return 0;
  if (pe.mode === 'FIXED') return pe.points;
  const unit = toMinor(pe.perAmount ?? 1);
  return Math.floor(amountMinor / unit) * pe.points;
}

/** Recomputes metric value, achieved tier and status for a txn-metric progress row. */
/** Open rows are IN_PROGRESS/ACHIEVED; closed rows keep their closed state but track the credited tier. */
function statusFor(current: string, tier: number): string {
  if (current === 'CLOSED_SUPERSEDED') return current;
  if (current.startsWith('CLOSED')) return tier > 0 ? 'CLOSED_ACHIEVED' : 'CLOSED_NOT_ACHIEVED';
  return tier > 0 ? 'ACHIEVED' : 'IN_PROGRESS';
}

function refreshProgress(ctx: EngineCtx, rule: LiveRule, p: ProgressRow, closedLate = false): ProgressRow {
  const { db, clock } = ctx;
  const metric = rule.def.metric?.type;
  const value = metric === 'SUM' ? p.txn_sum_minor : p.txn_count;
  let tier = rule.def.kind === 'GOAL' ? tierReached(rule, value) : 0;
  // Late data on a closed period updates the figures but can never raise the credited tier (it cannot earn a reward).
  if (closedLate) tier = Math.min(tier, p.achieved_tier);
  const status = statusFor(p.status, tier);
  db.run('UPDATE goal_progress SET metric_value = ?, achieved_tier = ?, status = ?, updated_at = ? WHERE progress_id = ?', value, tier, status, clock.now().toISOString(), p.progress_id);
  return getProgress(db, p.customer_id, p.rule_version_id, p.period_key)!;
}

function planItem(draft: EvalDraft, slot: string, tierNo: number | null, label: string | null, target: number, allowDown: boolean, upBlock?: PlanItem['upBlock']): PlanItem {
  return { draft, slot, tierNo, label, target, allowDown, upBlock, net: 0, delta: 0, action: 'NONE', grant: 0, posted: [] };
}

function tierPlans(draft: EvalDraft, rule: LiveRule, p: ProgressRow, allowDown: boolean, upBlock?: PlanItem['upBlock']): PlanItem[] {
  const reached = tierReached(rule, p.metric_value);
  if (rule.def.tierMode === 'HIGHEST_ONLY') {
    const target = reached > 0 ? rule.tiers[reached - 1].points : 0;
    return [planItem(draft, 'best', reached || null, reached ? rule.tiers[reached - 1].label : null, target, allowDown, upBlock)];
  }
  return rule.tiers.map((t) => planItem(draft, `tier:${t.tierNo}`, t.tierNo, t.label, t.tierNo <= reached ? t.points : 0, allowDown, upBlock));
}

// ---------------------------------------------------------------------
// Combined goals: metric = number of component goals currently met
// ---------------------------------------------------------------------
function evaluateCombined(pass: Pass, customerId: string) {
  const { ctx } = pass;
  const { db, clock } = ctx;
  const combined = getLiveRules(db).filter((r) => r.def.kind === 'COMBINED' && (!pass.filter || pass.filter(r)));
  if (combined.length === 0) return;
  const cc = loadCustomerContext(db, customerId, clock.now().toISOString().slice(0, 10));
  if (!cc) return;
  const snapshot = [...pass.touched.values()].filter((t) => t.customerId === customerId);
  for (const rule of combined) {
    const keys = new Map<string, boolean>(); // periodKey -> negative
    for (const t of snapshot) {
      if (rule.components.some((c) => c.ruleId === t.ruleId)) keys.set(t.periodKey, !!keys.get(t.periodKey) || t.negative);
    }
    for (const [periodKey, negative] of keys) {
      const compRow = db.get<{ period_start: string }>(
        `SELECT gp.period_start FROM goal_progress gp JOIN rule_version v ON v.rule_version_id = gp.rule_version_id
          WHERE gp.customer_id = ? AND gp.period_key = ? AND gp.rule_id IN (${rule.components.map(() => '?').join(',')}) LIMIT 1`,
        customerId, periodKey, ...rule.components.map((c) => c.ruleId),
      );
      if (!compRow) continue;
      const period = periodOf(compRow.period_start, rule.def.period.type, rule.campaignWindow);
      if (period.key !== periodKey) continue;
      evaluateCombinedPeriod(pass, rule, cc, period, negative);
    }
  }
}

function evaluateCombinedPeriod(pass: Pass, rule: LiveRule, cc: CustomerContext, period: Period, negative: boolean) {
  const { ctx } = pass;
  const { db, clock, config } = ctx;
  const customerId = cc.customer.customer_id;
  const elig = evalNode(rule.def.eligibility, customerFacts(cc));
  const draft = newDraft(pass, rule, customerId, period.key, null, { trigger: 'COMBINED', eligible: elig.pass, trace: config.storeTrace ? { eligibility: elig } : {} });
  if (cc.customer.status !== 'ACTIVE' || !elig.pass) {
    Object.assign(draft, { outcome: 'INELIGIBLE', reasonCode: 'INELIGIBLE', reasonText: 'Customer is not eligible for this combined goal.' });
    return;
  }
  const en = enrolled(ctx, rule, customerId);
  if (!en.ok) {
    Object.assign(draft, { outcome: 'INELIGIBLE', reasonCode: en.reason, reasonText: 'Customer is not enrolled in the campaign.' });
    return;
  }
  if (period.end < (rule.windowFrom ?? '0000') || period.start > (rule.windowTo ?? '9999')) {
    Object.assign(draft, { outcome: 'NOT_QUALIFYING', reasonCode: 'OUTSIDE_EFFECTIVE_WINDOW', reasonText: 'Period is outside the rule window.' });
    return;
  }
  const detail: unknown[] = [];
  let met = 0;
  for (const c of rule.components) {
    const row = db.get<{ achieved_tier: number; status: string }>(
      `SELECT gp.achieved_tier, gp.status FROM goal_progress gp JOIN rule_version v ON v.rule_version_id = gp.rule_version_id
        WHERE gp.customer_id = ? AND gp.rule_id = ? AND gp.period_key = ? AND v.status = 'ACTIVE'`,
      customerId, c.ruleId, period.key,
    );
    const ok = !!row && row.achieved_tier >= c.minTier && row.status !== 'DATA_UNAVAILABLE';
    if (ok) met++;
    detail.push({ rule: c.ruleCode, minTier: c.minTier, achievedTier: row?.achieved_tier ?? 0, met: ok });
  }
  const progress = ensureProgress(db, clock, customerId, rule, period);
  const tier = tierReached(rule, met);
  const closed = progress.status.startsWith('CLOSED');
  db.run(
    'UPDATE goal_progress SET metric_value = ?, txn_count = ?, achieved_tier = ?, status = ?, updated_at = ? WHERE progress_id = ?',
    met, met, tier, statusFor(progress.status, tier), clock.now().toISOString(), progress.progress_id,
  );
  const refreshed = getProgress(db, customerId, rule.ruleVersionId, period.key)!;
  Object.assign(draft, {
    metricValue: met,
    progress: refreshed,
    reasonCode: 'COMBINED_EVALUATED',
    reasonText: `${met} of ${rule.components.length} component goals met.`,
    trace: { ...draft.trace, components: detail },
    outcome: tier > 0 ? 'ACHIEVED' : 'IN_PROGRESS',
  });
  pass.plans.push(...tierPlans(draft, rule, refreshed, negative));
}

// ---------------------------------------------------------------------
// Balance-driven evaluation
// ---------------------------------------------------------------------
export function processSnapshot(ctx: EngineCtx, snapshotId: string, eventId: string | null, filter?: (r: LiveRule) => boolean): PassResult {
  const { db } = ctx;
  const snap = db.get<{ account_id: string; as_of_date: string }>('SELECT account_id, as_of_date FROM balance_snapshot WHERE snapshot_id = ?', snapshotId);
  if (!snap) throw new MxpError('NOT_FOUND', 'Snapshot not found.', 404);
  const account = loadAccount(db, snap.account_id)!;
  const pass = newPass(ctx, eventId, 'SNAPSHOT', filter);
  const cc = loadCustomerContext(db, account.customer_id, snap.as_of_date);
  if (cc) {
    for (const rule of getLiveRules(db)) {
      if (!rule.isBalance || (filter && !filter(rule))) continue;
      const qualifies = evalNode(rule.def.qualifying, { ...accountFacts(account, snap.as_of_date), ...customerFacts(cc) }).pass;
      if (!qualifies) continue;
      const period = periodOf(snap.as_of_date, rule.def.period.type, rule.campaignWindow);
      evaluateBalancePeriod(pass, rule, cc, period);
    }
    evaluateCombined(pass, account.customer_id);
  }
  const res = resolveAndPost(pass);
  const closed = runPeriodClose(ctx, { customerId: account.customer_id });
  return { evaluations: [...res.evaluations, ...closed.evaluations], ledger: [...res.ledger, ...closed.ledger] };
}

function evaluateBalancePeriod(pass: Pass, rule: LiveRule, cc: CustomerContext, period: Period) {
  const { ctx } = pass;
  const { db, clock, config } = ctx;
  const customerId = cc.customer.customer_id;
  const today = todayIn(ctx, rule.def.period.timezone);
  const elig = evalNode(rule.def.eligibility, customerFacts(cc));
  const draft = newDraft(pass, rule, customerId, period.key, null, { eligible: elig.pass, trace: config.storeTrace ? { eligibility: elig, period: period.key } : {} });
  if (cc.customer.status !== 'ACTIVE' || !elig.pass) {
    Object.assign(draft, { outcome: 'INELIGIBLE', reasonCode: 'INELIGIBLE', reasonText: 'Customer is not eligible for this goal.' });
    return;
  }
  const en = enrolled(ctx, rule, customerId);
  if (!en.ok) {
    Object.assign(draft, { outcome: 'INELIGIBLE', reasonCode: en.reason, reasonText: 'Customer is not enrolled in the campaign.' });
    return;
  }
  if (period.end < (rule.windowFrom ?? '0000') || period.start > (rule.windowTo ?? '9999')) {
    Object.assign(draft, { outcome: 'NOT_QUALIFYING', reasonCode: 'OUTSIDE_EFFECTIVE_WINDOW', reasonText: 'Period is outside the rule window.' });
    return;
  }
  const res = computeBalanceMetric(db, rule, customerId, period, today);
  const progress = ensureProgress(db, clock, customerId, rule, period);
  const now = clock.now().toISOString();
  const note = res.missing.length ? `${res.note}. Missing: ${res.missing.join(', ')}` : res.note;
  draft.trace = { ...draft.trace, balance: { ...res, value: res.value === null ? null : res.value / 100 } };
  const closed = progress.status.startsWith('CLOSED');

  if (!res.final) {
    db.run('UPDATE goal_progress SET metric_value = ?, achieved_tier = 0, status = ?, data_note = ?, updated_at = ? WHERE progress_id = ?', res.value ?? 0, closed ? progress.status : 'IN_PROGRESS', note, now, progress.progress_id);
    Object.assign(draft, { outcome: 'IN_PROGRESS', reasonCode: 'PERIOD_OPEN', reasonText: `Period still open; ${note}.`, metricValue: res.value, progress: getProgress(db, customerId, rule.ruleVersionId, period.key) });
    return;
  }
  if (!res.complete) {
    db.run('UPDATE goal_progress SET metric_value = ?, achieved_tier = 0, status = ?, data_note = ?, updated_at = ? WHERE progress_id = ?', res.value ?? 0, 'DATA_UNAVAILABLE', note, now, progress.progress_id);
    Object.assign(draft, {
      outcome: 'DATA_UNAVAILABLE',
      reasonCode: res.value === null ? 'NO_BALANCE_DATA' : 'INSUFFICIENT_BALANCE_DATA',
      reasonText: `Balance data is incomplete, so no reward was decided. ${note}`,
      metricValue: res.value,
      progress: getProgress(db, customerId, rule.ruleVersionId, period.key),
    });
    return;
  }
  const tier = tierReached(rule, res.value!);
  db.run(
    'UPDATE goal_progress SET metric_value = ?, achieved_tier = ?, status = ?, data_note = ?, updated_at = ? WHERE progress_id = ?',
    res.value, tier, statusFor(progress.status, tier), note, now, progress.progress_id,
  );
  const refreshed = getProgress(db, customerId, rule.ruleVersionId, period.key)!;
  Object.assign(draft, {
    outcome: tier > 0 ? 'ACHIEVED' : 'IN_PROGRESS',
    reasonCode: tier > 0 ? 'THRESHOLD_MET' : 'THRESHOLD_NOT_MET',
    reasonText: note,
    metricValue: res.value,
    progress: refreshed,
  });
  markTouched(pass, rule, customerId, period.key, true);
  // Balance results come straight from authoritative data, so they may also take rewards back.
  pass.plans.push(...tierPlans(draft, rule, refreshed, true));
}

// ---------------------------------------------------------------------
// Period close (nightly job and lazy close)
// ---------------------------------------------------------------------
export function runPeriodClose(ctx: EngineCtx, opts: { customerId?: string } = {}): PassResult {
  const { db, clock } = ctx;
  const live = new Map(getLiveRules(db).map((r) => [r.ruleVersionId, r]));
  const rows = db.all<ProgressRow>(
    `SELECT * FROM goal_progress WHERE status IN ('IN_PROGRESS','ACHIEVED','DATA_UNAVAILABLE') ${opts.customerId ? 'AND customer_id = ?' : ''} ORDER BY customer_id, period_end`,
    ...(opts.customerId ? [opts.customerId] : []),
  );
  const all: PassResult = { evaluations: [], ledger: [] };
  const byCustomer = new Map<string, ProgressRow[]>();
  for (const r of rows) {
    const rule = live.get(r.rule_version_id);
    if (!rule) continue;
    if (todayIn(ctx, rule.def.period.timezone) <= r.period_end) continue;
    if (!byCustomer.has(r.customer_id)) byCustomer.set(r.customer_id, []);
    byCustomer.get(r.customer_id)!.push(r);
  }
  for (const [customerId, list] of byCustomer) {
    ctx.db.tx(() => {
      const pass = newPass(ctx, null, 'PERIOD_CLOSE');
      const cc = loadCustomerContext(db, customerId, clock.now().toISOString().slice(0, 10));
      for (const r of list) {
        const rule = live.get(r.rule_version_id)!;
        if (rule.isBalance && cc) {
          const period = periodOf(r.period_start, rule.def.period.type, rule.campaignWindow);
          evaluateBalancePeriod(pass, rule, cc, period);
        }
      }
      evaluateCombined(pass, customerId);
      const res = resolveAndPost(pass);
      all.evaluations.push(...res.evaluations);
      all.ledger.push(...res.ledger);
      // Now mark rows closed.
      const closePass = newPass(ctx, null, 'PERIOD_CLOSE');
      for (const r of list) {
        const rule = live.get(r.rule_version_id)!;
        const today = todayIn(ctx, rule.def.period.timezone);
        const grace = rule.isBalance || rule.def.kind === 'COMBINED' ? 0 : rule.def.period.lateGraceDays;
        if (today <= addDays(r.period_end, grace)) continue;
        const cur = getProgress(db, customerId, r.rule_version_id, r.period_key)!;
        if (cur.status === 'DATA_UNAVAILABLE') continue;
        const status = cur.achieved_tier > 0 ? 'CLOSED_ACHIEVED' : 'CLOSED_NOT_ACHIEVED';
        db.run('UPDATE goal_progress SET status = ?, updated_at = ? WHERE progress_id = ?', status, clock.now().toISOString(), cur.progress_id);
        newDraft(closePass, rule, customerId, r.period_key, null, {
          eligible: true,
          outcome: 'PERIOD_CLOSED',
          reasonCode: status,
          reasonText: `Period ${r.period_key} closed with ${rule.def.metric ? fmtMetric(rule, cur.metric_value) : `${cur.metric_value}`} (tier ${cur.achieved_tier}).`,
          metricValue: cur.metric_value,
          trace: { periodEnd: r.period_end },
        });
      }
      all.evaluations.push(...writeDrafts(closePass));
    });
  }
  return all;
}

// ---------------------------------------------------------------------
// Resolution: frequency, conflicts, caps, posting
// ---------------------------------------------------------------------
function resolveAndPost(pass: Pass): PassResult {
  const { ctx } = pass;
  const { db, clock } = ctx;
  const items = pass.plans;
  const ledger: LedgerEntry[] = [];

  // 1. Net and delta per slot.
  for (const it of items) {
    const { rule, customerId, periodKey } = it.draft;
    it.net = slotNet(db, customerId, rule.ruleId, periodKey!, it.slot);
    it.delta = it.target - it.net;
  }
  const targetByDraft = new Map<EvalDraft, number>();
  for (const it of items) targetByDraft.set(it.draft, (targetByDraft.get(it.draft) ?? 0) + it.target);
  for (const [d, t] of targetByDraft) d.pointsTarget = t;

  // 2. Downward moves.
  for (const it of items.filter((i) => i.delta < 0)) {
    if (it.allowDown && it.draft.rule.def.handling.reversal === 'CLAWBACK') it.action = 'REVERSE';
    else {
      it.blocked = {
        code: it.draft.rule.def.handling.reversal === 'GRANDFATHER' ? 'GRANDFATHERED' : 'NOT_REVERSAL_DRIVEN',
        text: it.draft.rule.def.handling.reversal === 'GRANDFATHER' ? 'Reward kept: rule policy is GRANDFATHER.' : 'Points are only taken back when progress falls.',
        outcome: 'NO_CHANGE',
      };
    }
  }

  // 3. Upward candidates: period lock, frequency.
  const periodNetCache = new Map<string, number>();
  const periodNet = (rule: LiveRule, customerId: string, periodKey: string) => {
    const k = `${rule.ruleId}|${customerId}|${periodKey}`;
    if (!periodNetCache.has(k)) {
      periodNetCache.set(k, db.value<number>('SELECT COALESCE(SUM(points),0) FROM xp_ledger WHERE customer_id = ? AND rule_id = ? AND period_key = ?', customerId, rule.ruleId, periodKey) ?? 0);
    }
    return periodNetCache.get(k)!;
  };
  let cands = items.filter((i) => i.delta > 0);
  for (const it of cands) {
    const { rule, customerId, periodKey } = it.draft;
    if (it.upBlock) {
      it.blocked = { ...it.upBlock, outcome: 'PERIOD_CLOSED' };
      continue;
    }
    if (periodNet(rule, customerId, periodKey!) <= 0) {
      const others = db.all<{ period_key: string }>(
        `SELECT period_key FROM xp_ledger WHERE customer_id = ? AND rule_id = ? AND period_key <> ? GROUP BY period_key HAVING SUM(points) > 0`,
        customerId, rule.ruleId, periodKey,
      );
      const lim = rule.def.limits;
      if (lim.frequency === 'ONCE' && others.length > 0) {
        it.blocked = { code: 'FREQUENCY_ONCE', text: `Already rewarded in period ${others[0].period_key}; this rule rewards once per customer.`, outcome: 'CAPPED' };
      } else if (lim.maxOccurrences && others.length >= lim.maxOccurrences) {
        it.blocked = { code: 'FREQUENCY_MAX', text: `Maximum of ${lim.maxOccurrences} rewarded periods reached.`, outcome: 'CAPPED' };
      }
    }
  }
  cands = cands.filter((c) => !c.blocked);

  // 4. Exclusive conflict groups.
  const live = getLiveRules(db);
  const groupKey = (it: PlanItem) => {
    const c = it.draft.rule.def.conflict;
    return c.policy !== 'CUMULATIVE' && c.group ? `${c.group}|${it.draft.customerId}|${it.draft.periodKey}` : null;
  };
  const buckets = new Map<string, PlanItem[]>();
  for (const it of cands) {
    const k = groupKey(it);
    if (k) {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(it);
    }
  }
  for (const [, members] of buckets) {
    const first = members[0];
    const { customerId, periodKey } = first.draft;
    const group = first.draft.rule.def.conflict.group!;
    const groupRules = live.filter((r) => r.def.conflict.group === group);
    const ids = groupRules.map((r) => r.ruleId);
    const existing = db.all<{ rule_id: string }>(
      `SELECT rule_id FROM xp_ledger WHERE customer_id = ? AND period_key = ? AND rule_id IN (${ids.map(() => '?').join(',')}) GROUP BY rule_id HAVING SUM(points) > 0`,
      customerId, periodKey, ...ids,
    );
    const ruleIds = [...new Set(members.map((m) => m.draft.rule.ruleId))];
    const blockedRules = new Set<string>();
    for (const rid of ruleIds) {
      const other = existing.find((e) => e.rule_id !== rid);
      if (other) {
        const winner = groupRules.find((r) => r.ruleId === other.rule_id)?.ruleCode ?? other.rule_id;
        blockedRules.add(rid);
        for (const m of members.filter((x) => x.draft.rule.ruleId === rid)) {
          m.blocked = { code: 'CONFLICT_EXISTING', text: `Exclusive group "${group}": ${winner} already rewarded this customer for ${periodKey}.`, outcome: 'SUPPRESSED' };
        }
      }
    }
    const open = ruleIds.filter((r) => !blockedRules.has(r));
    if (open.length > 1) {
      const policy = first.draft.rule.def.conflict.policy;
      const score = (rid: string) => {
        const rule = members.find((m) => m.draft.rule.ruleId === rid)!.draft.rule;
        const pts = members.filter((m) => m.draft.rule.ruleId === rid).reduce((a, m) => a + m.delta, 0);
        return { rid, rule, pts };
      };
      const ranked = open.map(score).sort((a, b) => {
        if (policy === 'EXCLUSIVE_HIGHEST_POINTS' && a.pts !== b.pts) return b.pts - a.pts;
        if (a.rule.def.priority !== b.rule.def.priority) return b.rule.def.priority - a.rule.def.priority;
        return a.rule.ruleCode.localeCompare(b.rule.ruleCode);
      });
      const winner = ranked[0];
      for (const r of ranked.slice(1)) {
        for (const m of members.filter((x) => x.draft.rule.ruleId === r.rid)) {
          m.blocked = {
            code: 'CONFLICT_EXCLUDED',
            text: `Exclusive group "${group}" (${policy}): ${winner.rule.ruleCode} wins over ${r.rule.ruleCode} (${policy === 'EXCLUSIVE_HIGHEST_POINTS' ? `${winner.pts} vs ${r.pts} points` : `priority ${winner.rule.def.priority} vs ${r.rule.def.priority}`}).`,
            outcome: 'SUPPRESSED',
          };
        }
      }
    }
  }
  cands = cands.filter((c) => !c.blocked);

  // 5. Caps and budget, in a deterministic order.
  cands.sort((a, b) => b.draft.rule.def.priority - a.draft.rule.def.priority || a.draft.rule.ruleCode.localeCompare(b.draft.rule.ruleCode) || a.slot.localeCompare(b.slot));
  const grantedPeriod = new Map<string, number>();
  const grantedLife = new Map<string, number>();
  const grantedCampaign = new Map<string, number>();
  for (const it of cands) {
    const { rule, customerId, periodKey } = it.draft;
    const lim = rule.def.limits;
    let grant = it.delta;
    let cappedBy: string | null = null;
    if (lim.capPointsPerPeriod !== null) {
      const used = periodNet(rule, customerId, periodKey!) + (grantedPeriod.get(`${rule.ruleId}|${customerId}|${periodKey}`) ?? 0);
      const room = Math.max(0, lim.capPointsPerPeriod - used);
      if (room < grant) {
        grant = room;
        cappedBy = `period cap of ${lim.capPointsPerPeriod}`;
      }
    }
    if (lim.capPointsLifetime !== null) {
      const life = db.value<number>('SELECT COALESCE(SUM(points),0) FROM xp_ledger WHERE customer_id = ? AND rule_id = ?', customerId, rule.ruleId) ?? 0;
      const room = Math.max(0, lim.capPointsLifetime - life - (grantedLife.get(`${rule.ruleId}|${customerId}`) ?? 0));
      if (room < grant) {
        grant = room;
        cappedBy = `lifetime cap of ${lim.capPointsLifetime}`;
      }
    }
    const camp = rule.campaign;
    if (camp && camp.points_budget !== null) {
      const spent = db.value<number>('SELECT COALESCE(SUM(points),0) FROM xp_ledger WHERE campaign_id = ?', camp.campaign_id) ?? 0;
      const room = Math.max(0, camp.points_budget - spent - (grantedCampaign.get(camp.campaign_id) ?? 0));
      if (room < grant) {
        grant = room;
        cappedBy = `campaign budget of ${camp.points_budget}`;
      }
    }
    if (grant <= 0) {
      it.blocked = { code: 'CAP_REACHED', text: `No points awarded: ${cappedBy ?? 'cap'} reached.`, outcome: 'CAPPED' };
      continue;
    }
    it.grant = grant;
    it.action = 'AWARD';
    if (cappedBy) it.blocked = { code: 'CAPPED_PARTIAL', text: `Awarded ${grant} of ${it.delta} points: ${cappedBy} reached.`, outcome: 'CAPPED' };
    grantedPeriod.set(`${rule.ruleId}|${customerId}|${periodKey}`, (grantedPeriod.get(`${rule.ruleId}|${customerId}|${periodKey}`) ?? 0) + grant);
    grantedLife.set(`${rule.ruleId}|${customerId}`, (grantedLife.get(`${rule.ruleId}|${customerId}`) ?? 0) + grant);
    if (camp) grantedCampaign.set(camp.campaign_id, (grantedCampaign.get(camp.campaign_id) ?? 0) + grant);
  }

  // 6. Post: reversals first, then awards.
  for (const it of items.filter((i) => i.action === 'REVERSE')) {
    const { rule, customerId, periodKey, txnId } = it.draft;
    let remaining = -it.delta;
    for (const a of reversibleAwards(db, customerId, rule.ruleId, periodKey!, it.slot)) {
      if (remaining <= 0) break;
      const open = a.points - a.reversed;
      if (open <= 0) continue;
      const take = Math.min(open, remaining);
      const entry = postLedger(db, clock, {
        customerId,
        entryType: 'REVERSAL',
        points: -take,
        ruleId: rule.ruleId,
        ruleVersionId: a.rule_version_id,
        campaignId: a.campaign_id,
        periodKey,
        slot: it.slot,
        tierNo: a.tier_no,
        sourceTxnId: txnId,
        sourceEventId: pass.eventId,
        evaluationId: it.draft.evaluationId,
        reversesLedgerId: a.ledger_id,
        reasonCode: it.draft.trigger === 'SNAPSHOT' || it.draft.trigger === 'PERIOD_CLOSE' ? 'BALANCE_RESTATED' : 'TXN_REVERSED_OR_REFUNDED',
        reasonText: it.draft.reasonText,
        idempotencyKey: `RV|${a.ledger_id}|${a.reversed}`,
      });
      if (entry) {
        it.posted.push(entry);
        ledger.push(entry);
        remaining -= take;
      }
    }
  }
  for (const it of items.filter((i) => i.action === 'AWARD')) {
    const { rule, customerId, periodKey, txnId } = it.draft;
    const n = slotAwardCount(db, customerId, rule.ruleId, periodKey!, it.slot) + 1;
    const entry = postLedger(db, clock, {
      customerId,
      entryType: 'AWARD',
      points: it.grant,
      ruleId: rule.ruleId,
      ruleVersionId: rule.ruleVersionId,
      campaignId: rule.campaign?.campaign_id ?? null,
      periodKey,
      slot: it.slot,
      tierNo: it.tierNo,
      sourceTxnId: txnId,
      sourceEventId: pass.eventId,
      evaluationId: it.draft.evaluationId,
      reasonCode: rule.def.kind === 'PER_EVENT' ? 'PER_EVENT_REWARD' : 'GOAL_TIER_REACHED',
      reasonText: it.label ? `${rule.def.name}: ${it.label}` : rule.def.name,
      idempotencyKey: `AW|${customerId}|${rule.ruleId}|${periodKey}|${it.slot}|${n}`,
    });
    if (entry) {
      it.posted.push(entry);
      ledger.push(entry);
    }
  }

  // 7. Outcome per evaluation, then nudges.
  const byDraft = new Map<EvalDraft, PlanItem[]>();
  for (const it of items) {
    if (!byDraft.has(it.draft)) byDraft.set(it.draft, []);
    byDraft.get(it.draft)!.push(it);
  }
  for (const [d, its] of byDraft) {
    const posted = its.flatMap((i) => i.posted);
    d.pointsDelta = posted.reduce((a, e) => a + e.points, 0);
    const blocked = its.find((i) => i.blocked && i.blocked.code !== 'GRANDFATHERED' && i.blocked.code !== 'NOT_REVERSAL_DRIVEN') ?? its.find((i) => i.blocked);
    d.trace = {
      ...d.trace,
      slots: its.map((i) => ({ slot: i.slot, tier: i.tierNo, targetPoints: i.target, ledgerNet: i.net, delta: i.delta, action: i.action, granted: i.grant, note: i.blocked?.text })),
    };
    const awarded = posted.filter((e) => e.points > 0).reduce((a, e) => a + e.points, 0);
    if (awarded > 0) {
      d.outcome = 'AWARDED';
      d.reasonCode = blocked?.blocked?.code === 'CAPPED_PARTIAL' ? 'CAPPED_PARTIAL' : 'REWARD_ISSUED';
      d.reasonText = `${awarded} points awarded. ${blocked?.blocked?.text ?? ''}`.trim();
    } else if (posted.some((e) => e.points < 0)) {
      d.outcome = 'REVERSED';
      d.reasonCode = 'REWARD_REVERSED';
      d.reasonText = `${-d.pointsDelta} points reversed: ${d.reasonText}`;
    } else if (blocked?.blocked) {
      d.outcome = blocked.blocked.code === 'GRANDFATHERED' || blocked.blocked.code === 'NOT_REVERSAL_DRIVEN' ? 'NO_CHANGE' : blocked.blocked.outcome;
      d.reasonCode = blocked.blocked.code;
      d.reasonText = blocked.blocked.text;
    } else if (d.rule.def.kind === 'PER_EVENT') {
      d.outcome = (d.pointsTarget ?? 0) > 0 ? 'NO_CHANGE' : 'NOT_QUALIFYING';
    } else {
      d.outcome = d.progress && d.progress.achieved_tier > 0 ? 'ACHIEVED' : 'IN_PROGRESS';
    }
  }
  emitNudges(pass, byDraft);
  return { evaluations: writeDrafts(pass), ledger };
}

function writeDrafts(pass: Pass): EvalDraft[] {
  const { db, clock } = pass.ctx;
  const now = clock.now().toISOString();
  for (const d of pass.drafts) {
    db.run(
      `INSERT INTO rule_evaluation(evaluation_id, trigger_event_id, trigger_kind, txn_id, customer_id, rule_id, rule_version_id, period_key, evaluated_at, outcome,
         eligible, metric_value, points_target, points_delta, reason_code, reason_text, trace_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      d.evaluationId, pass.eventId, d.trigger, d.txnId, d.customerId, d.rule.ruleId, d.rule.ruleVersionId, d.periodKey, now, d.outcome, d.eligible ? 1 : 0,
      d.metricValue, d.pointsTarget, d.pointsDelta, d.reasonCode, d.reasonText.slice(0, 500), pass.ctx.config.storeTrace ? JSON.stringify(d.trace) : null,
    );
  }
  return pass.drafts;
}

// ---------------------------------------------------------------------
// Nudges
// ---------------------------------------------------------------------
function emitNudges(pass: Pass, byDraft: Map<EvalDraft, PlanItem[]>) {
  const { ctx } = pass;
  for (const [d, items] of byDraft) {
    const rule = d.rule;
    for (const it of items) {
      for (const e of it.posted) {
        if (e.points > 0) {
          createNudge(ctx, {
            customerId: d.customerId, rule, periodKey: d.periodKey!, type: 'TIER_ACHIEVED', dedupeKey: `TA|${e.ledger_id}`,
            vars: { points: e.points, tier: it.label ?? it.tierNo ?? '' },
          });
        } else {
          createNudge(ctx, {
            customerId: d.customerId, rule, periodKey: d.periodKey!, type: 'REWARD_REVERSED', dedupeKey: `RV|${e.ledger_id}`,
            vars: { points: -e.points },
          });
        }
      }
    }
    // Progress / near-target nudges for goals that moved forward.
    if (rule.def.kind === 'GOAL' && d.valueIncreased && d.progress && !d.progress.status.startsWith('CLOSED') && d.trigger !== 'REPLAY') {
      const value = d.progress.metric_value;
      const next = rule.tiers.find((t) => t.threshold > value || (rule.def.metric?.operator === 'GT' && t.threshold >= value));
      if (next && value > 0) {
        const pct = value / next.threshold;
        const near = rule.def.nudges.nearTargetPct / 100;
        const vars = {
          progress: fmtMetric(rule, value),
          target: fmtMetric(rule, next.threshold),
          remaining: fmtMetric(rule, next.threshold - value),
          points: next.points,
        };
        if (pct >= near) {
          createNudge(ctx, { customerId: d.customerId, rule, periodKey: d.periodKey!, type: 'NEAR_TARGET', dedupeKey: `NEAR|${d.customerId}|${rule.ruleId}|${d.periodKey}|${next.tierNo}`, vars });
        } else if (pct >= 0.5) {
          createNudge(ctx, { customerId: d.customerId, rule, periodKey: d.periodKey!, type: 'PROGRESS', dedupeKey: `PROG|${d.customerId}|${rule.ruleId}|${d.periodKey}|${next.tierNo}`, vars });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------
// Replay (backfill, preview, rebuild): same code path as live processing
// ---------------------------------------------------------------------
export function replayTransactions(
  ctx: EngineCtx,
  opts: { customerIds?: string[]; fromDate?: string; filter?: (r: LiveRule) => boolean } = {},
): { transactions: number; ledgerEntries: number } {
  const { db } = ctx;
  const where: string[] = ['is_reversal = 0'];
  const args: any[] = [];
  if (opts.customerIds?.length) {
    where.push(`customer_id IN (${opts.customerIds.map(() => '?').join(',')})`);
    args.push(...opts.customerIds);
  }
  if (opts.fromDate) {
    where.push('txn_ts >= ?');
    args.push(opts.fromDate);
  }
  const txns = db.all<{ txn_id: string }>(`SELECT txn_id FROM txn_master WHERE ${where.join(' AND ')} ORDER BY txn_ts, txn_id`, ...args);
  let entries = 0;
  for (const t of txns) {
    const r = db.tx(() => processTransaction(ctx, t.txn_id, null, 'REPLAY', opts.filter));
    entries += r.ledger.length;
  }
  // Balance goals: evaluate every (customer, period) that has snapshots.
  const rules = getLiveRules(db).filter((r) => r.isBalance && (!opts.filter || opts.filter(r)));
  for (const rule of rules) {
    const rows = db.all<{ customer_id: string; as_of_date: string }>(
      `SELECT DISTINCT a.customer_id, s.as_of_date FROM balance_snapshot s JOIN account a ON a.account_id = s.account_id
        ${opts.customerIds?.length ? `WHERE a.customer_id IN (${opts.customerIds.map(() => '?').join(',')})` : ''} ORDER BY s.as_of_date`,
      ...(opts.customerIds ?? []),
    );
    const seen = new Set<string>();
    for (const r of rows) {
      const period = periodOf(r.as_of_date, rule.def.period.type, rule.campaignWindow);
      const k = `${r.customer_id}|${period.key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const res = db.tx(() => {
        const pass = newPass(ctx, null, 'REPLAY', opts.filter);
        const cc = loadCustomerContext(db, r.customer_id, ctx.clock.now().toISOString().slice(0, 10));
        if (cc) evaluateBalancePeriod(pass, rule, cc, period);
        evaluateCombined(pass, r.customer_id);
        return resolveAndPost(pass);
      });
      entries += res.ledger.length;
    }
  }
  const closed = runPeriodClose(ctx);
  return { transactions: txns.length, ledgerEntries: entries + closed.ledger.length };
}

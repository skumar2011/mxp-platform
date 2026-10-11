import type { Db } from './db';
import { evalNode } from './conditions';
import { accountFacts, customerFacts, loadCustomerContext, type AccountRow } from './context';
import type { LiveRule } from './ruleRepo';
import { addDays, eachDay, type Period } from './time';
import { uid, type Clock } from './util';

export interface ProgressRow {
  progress_id: string;
  customer_id: string;
  rule_id: string;
  rule_version_id: string;
  period_key: string;
  period_start: string;
  period_end: string;
  txn_count: number;
  txn_sum_minor: number;
  metric_value: number;
  achieved_tier: number;
  status: string;
  data_note: string | null;
  last_txn_id: string | null;
  updated_at: string;
}

export function getProgress(db: Db, customerId: string, ruleVersionId: string, periodKey: string): ProgressRow | undefined {
  return db.get<ProgressRow>('SELECT * FROM goal_progress WHERE customer_id = ? AND rule_version_id = ? AND period_key = ?', customerId, ruleVersionId, periodKey);
}

export function ensureProgress(db: Db, clock: Clock, customerId: string, rule: LiveRule, period: Period): ProgressRow {
  const cur = getProgress(db, customerId, rule.ruleVersionId, period.key);
  if (cur) return cur;
  db.run(
    `INSERT INTO goal_progress(progress_id, customer_id, rule_id, rule_version_id, period_key, period_start, period_end, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    uid(), customerId, rule.ruleId, rule.ruleVersionId, period.key, period.start, period.end, clock.now().toISOString(),
  );
  return getProgress(db, customerId, rule.ruleVersionId, period.key)!;
}

/**
 * Reconciles the contribution journal for one transaction against the amount/count it should
 * contribute now. Convergent: running it twice with the same inputs writes nothing the second time.
 * Returns the net change applied per period (negative = something was taken back).
 */
export function reconcileContribution(
  db: Db,
  clock: Clock,
  rule: LiveRule,
  customerId: string,
  txnId: string,
  eventId: string | null,
  desired: { period: Period; amountMinor: number; count: number },
): { periodKey: string; amountDelta: number; countDelta: number; period: Period | null }[] {
  const existing = db.all<{ period_key: string; a: number; c: number }>(
    `SELECT period_key, SUM(amount_delta_minor) AS a, SUM(count_delta) AS c FROM goal_contribution
      WHERE txn_id = ? AND rule_version_id = ? GROUP BY period_key`,
    txnId, rule.ruleVersionId,
  );
  const keys = new Set<string>([desired.period.key, ...existing.map((e) => e.period_key)]);
  const out: { periodKey: string; amountDelta: number; countDelta: number; period: Period | null }[] = [];
  for (const key of keys) {
    const cur = existing.find((e) => e.period_key === key);
    const want = key === desired.period.key ? desired : { amountMinor: 0, count: 0 };
    const dA = want.amountMinor - (cur?.a ?? 0);
    const dC = want.count - (cur?.c ?? 0);
    if (dA === 0 && dC === 0) continue;
    const now = clock.now().toISOString();
    db.run(
      `INSERT INTO goal_contribution(customer_id, rule_version_id, period_key, txn_id, entry_type, amount_delta_minor, count_delta, event_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      customerId, rule.ruleVersionId, key, txnId, dC < 0 || (dC === 0 && dA < 0) ? 'REVERSE' : 'APPLY', dA, dC, eventId, now,
    );
    const isDesired = key === desired.period.key;
    if (isDesired) ensureProgress(db, clock, customerId, rule, desired.period);
    db.run(
      `UPDATE goal_progress SET txn_count = txn_count + ?, txn_sum_minor = txn_sum_minor + ?, last_txn_id = ?, updated_at = ?
        WHERE customer_id = ? AND rule_version_id = ? AND period_key = ?`,
      dC, dA, txnId, now, customerId, rule.ruleVersionId, key,
    );
    out.push({ periodKey: key, amountDelta: dA, countDelta: dC, period: isDesired ? desired.period : null });
  }
  return out;
}

export function tierReached(rule: LiveRule, value: number): number {
  const op = rule.def.metric?.operator ?? 'GTE';
  let reached = 0;
  for (const t of rule.tiers) {
    if (op === 'GT' ? value > t.threshold : value >= t.threshold) reached = t.tierNo;
  }
  return reached;
}

// ---------------------------------------------------------------------
// Balance metrics (authoritative snapshots only)
// ---------------------------------------------------------------------
export interface BalanceMetricResult {
  /** Minor units. Null when no usable data exists. */
  value: number | null;
  complete: boolean;
  final: boolean;
  days: number;
  cutoff: string | null;
  missing: string[];
  accounts: string[];
  note: string;
}

interface SnapRow {
  account_id: string;
  as_of_date: string;
  closing_balance_minor: number;
}

/**
 * Computes AVG / MIN balance or balance growth for a customer's qualifying accounts.
 * Balances come only from balance_snapshot; if any required day is missing (and the rule does not
 * carry balances forward) the result is flagged incomplete and no reward may be issued from it.
 */
export function computeBalanceMetric(
  db: Db,
  rule: LiveRule,
  customerId: string,
  period: Period,
  todayLocal: string,
): BalanceMetricResult {
  const metric = rule.def.metric!.type;
  const cc = loadCustomerContext(db, customerId, todayLocal);
  const accounts = db
    .all<AccountRow & { product_family: string }>(
      `SELECT a.*, p.product_family FROM account a JOIN product_ref p ON p.product_code = a.product_code WHERE a.customer_id = ?`,
      customerId,
    )
    .filter((a) => a.opened_on <= period.end && (!a.closed_on || a.closed_on >= period.start))
    .filter((a) => evalNode(rule.def.qualifying, { ...accountFacts(a, period.end), ...(cc ? customerFacts(cc) : {}) }).pass);
  if (accounts.length === 0) {
    return { value: null, complete: false, final: false, days: 0, cutoff: null, missing: [], accounts: [], note: 'No qualifying account for this customer in the period.' };
  }
  const ids = accounts.map((a) => a.account_id);
  const ph = ids.map(() => '?').join(',');
  const latest = db.value<string>(`SELECT MAX(as_of_date) FROM balance_snapshot WHERE account_id IN (${ph}) AND as_of_date <= ?`, ...ids, period.end);
  const final = (latest !== undefined && latest !== null && latest >= period.end) || todayLocal > period.end;
  const cutoff = final ? period.end : (latest ?? null);
  if (!cutoff) {
    return { value: null, complete: false, final, days: 0, cutoff: null, missing: [], accounts: ids, note: 'No balance snapshots received yet.' };
  }
  const carry = rule.def.balancePolicy.gapFill === 'CARRY_FORWARD';
  const lookbackStart = addDays(period.start, -1);
  const snaps = db.all<SnapRow>(
    `SELECT account_id, as_of_date, closing_balance_minor FROM balance_snapshot WHERE account_id IN (${ph}) AND as_of_date >= ? AND as_of_date <= ? ORDER BY as_of_date`,
    ...ids, carry ? '0000-01-01' : lookbackStart, cutoff,
  );
  const byAcct = new Map<string, Map<string, number>>();
  for (const s of snaps) {
    if (!byAcct.has(s.account_id)) byAcct.set(s.account_id, new Map());
    byAcct.get(s.account_id)!.set(s.as_of_date, s.closing_balance_minor);
  }
  const balanceOn = (acct: string, day: string): number | undefined => {
    const m = byAcct.get(acct);
    if (!m) return undefined;
    if (m.has(day)) return m.get(day);
    if (!carry) return undefined;
    let best: string | undefined;
    for (const d of m.keys()) if (d < day && (!best || d > best)) best = d;
    return best ? m.get(best) : undefined;
  };

  const missing: string[] = [];
  const totals: { day: string; total: number }[] = [];
  const days = eachDay(period.start, cutoff);
  for (const day of days) {
    let total = 0;
    let any = false;
    for (const a of accounts) {
      if (a.opened_on > day || (a.closed_on && a.closed_on < day)) continue;
      any = true;
      const b = balanceOn(a.account_id, day);
      if (b === undefined) missing.push(`${day}:${a.account_ref.slice(-4)}`);
      else total += b;
    }
    if (any) totals.push({ day, total });
  }

  let value: number | null = null;
  let note = '';
  if (metric === 'AVG_BALANCE') {
    value = totals.length ? Math.round(totals.reduce((s, t) => s + t.total, 0) / totals.length) : null;
    note = `Average of ${totals.length} daily closing balance(s)`;
  } else if (metric === 'MIN_BALANCE') {
    value = totals.length ? Math.min(...totals.map((t) => t.total)) : null;
    note = `Lowest daily closing balance over ${totals.length} day(s)`;
  } else {
    // BALANCE_GROWTH: closing at cutoff minus opening (day before the period). Accounts opened in the period start from zero.
    let opening = 0;
    let closing = 0;
    for (const a of accounts) {
      if (a.opened_on >= period.start) {
        /* opened within the period: opening balance is zero by definition */
      } else {
        const o = balanceOn(a.account_id, lookbackStart);
        if (o === undefined) missing.push(`${lookbackStart}:${a.account_ref.slice(-4)}`);
        else opening += o;
      }
      const c = balanceOn(a.account_id, cutoff);
      if (c === undefined) missing.push(`${cutoff}:${a.account_ref.slice(-4)}`);
      else closing += c;
    }
    value = closing - opening;
    note = `Closing ${closing / 100} minus opening ${opening / 100}`;
  }
  const uniqueMissing = [...new Set(missing)];
  return {
    value,
    complete: uniqueMissing.length === 0 && value !== null,
    final,
    days: totals.length,
    cutoff,
    missing: uniqueMissing.slice(0, 20),
    accounts: ids,
    note,
  };
}

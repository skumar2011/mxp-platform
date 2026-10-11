import type { Db } from './db';
import { MxpError } from './util';
import { runScenario } from './sim';
import type { RuleSource, SimAccount, SimResult, SimRuleRef, SimScenario, SimStep } from './simtypes';
import { addDays, localDate } from './time';

/**
 * Builds a scenario from a real customer's history (read-only queries) so a rule can be previewed:
 * "what would this rule have paid this customer?". The replay runs in the sandbox; nothing is written to production.
 */
export function scenarioFromCustomer(db: Db, customerRef: string, opts: { fromDate?: string; toDate?: string; maxSteps?: number } = {}): SimScenario {
  const c = db.get<any>('SELECT * FROM customer WHERE customer_ref = ?', customerRef);
  if (!c) throw new MxpError('NOT_FOUND', `Customer ${customerRef} was not found.`, 404);
  const today = localDate(new Date().toISOString(), 'Asia/Kolkata');
  const to = opts.toDate ?? today;
  const from = opts.fromDate ?? addDays(to, -120);
  const max = opts.maxSteps ?? 1500;

  const segments = db.all<{ segment_code: string }>('SELECT segment_code FROM customer_segment WHERE customer_id = ? AND (valid_to IS NULL OR valid_to >= ?)', c.customer_id, to).map((r) => r.segment_code);
  const accounts: SimAccount[] = db
    .all<any>('SELECT a.*, (SELECT instrument_type FROM instrument i WHERE i.account_id = a.account_id LIMIT 1) AS inst FROM account a WHERE a.customer_id = ?', c.customer_id)
    .map((a) => ({ ref: a.account_ref, productCode: a.product_code, openedOn: a.opened_on, status: a.status, instrumentType: a.inst ?? 'NONE' }));

  const steps: (SimStep & { _ts: string })[] = [];
  const txns = db.all<any>(
    `SELECT t.*, a.account_ref, o.source_txn_id AS original_source FROM txn_master t LEFT JOIN account a ON a.account_id = t.account_id
       LEFT JOIN txn_master o ON o.txn_id = t.original_txn_id
      WHERE t.customer_id = ? AND substr(t.txn_ts,1,10) BETWEEN ? AND ? ORDER BY t.txn_ts, t.rowid`,
    c.customer_id, from, to,
  );
  for (const t of txns) {
    if (t.is_reversal) {
      steps.push({ kind: t.txn_type === 'REVERSAL' ? 'REVERSAL' : 'REFUND', id: t.source_txn_id, original: t.original_source, at: t.txn_ts, amount: t.amount_minor / 100, _ts: t.txn_ts });
    } else {
      steps.push({
        kind: 'TXN', id: t.source_txn_id, at: t.txn_ts, type: t.txn_type, channel: t.channel_code, amount: t.amount_minor / 100, drCr: t.dr_cr, status: 'POSTED', category: t.category_code ?? undefined,
        accountRef: t.account_ref ?? undefined, instrumentRef: t.instrument_ref && t.account_ref ? `${t.account_ref}-INS` : undefined, productCode: t.product_code ?? undefined, mcc: t.mcc ?? undefined,
        merchantId: t.merchant_id ?? undefined, merchantName: t.merchant_name ?? undefined, postingDate: t.posting_date ?? undefined, attributes: JSON.parse(t.attributes_json || '{}'), _ts: t.txn_ts,
      });
    }
  }
  const snaps = db.all<any>(
    `SELECT b.*, a.account_ref FROM balance_snapshot b JOIN account a ON a.account_id = b.account_id WHERE a.customer_id = ? AND b.as_of_date BETWEEN ? AND ? ORDER BY b.as_of_date`,
    c.customer_id, addDays(from, -1), to,
  );
  for (const s of snaps) steps.push({ kind: 'BALANCE', account: s.account_ref, date: s.as_of_date, balance: s.closing_balance_minor / 100, _ts: `${s.as_of_date}T23:59:00.000Z` });
  steps.sort((a, b) => a._ts.localeCompare(b._ts));
  if (steps.length > max) throw new MxpError('TOO_MUCH_HISTORY', `This customer has ${steps.length} events in the window; narrow the date range (limit ${max}).`, 422);

  // A reversal must come after its original in the replay even if timestamps tie.
  const out = steps.map(({ _ts, ...rest }) => rest as SimStep);
  return {
    timezone: 'Asia/Kolkata',
    customer: { ref: customerRef, type: c.customer_type, kycStatus: c.kyc_status, status: c.status, segments, nudgeConsent: !!c.nudge_consent },
    accounts,
    steps: out,
    asOf: to,
  };
}

export function previewForCustomer(db: Db, source: RuleSource, rule: SimRuleRef, customerRef: string, opts: { fromDate?: string; toDate?: string; includeActive?: boolean } = {}): SimResult {
  const scenario = scenarioFromCustomer(db, customerRef, opts);
  return runScenario(source, { name: `Preview for ${customerRef}`, rules: [rule], includeActive: opts.includeActive, scenario });
}

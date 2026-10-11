import type { Actor } from './audit';
import { audit, verifyAuditChain } from './audit';
import type { EngineCtx } from './context';
import { MxpError, toMinor, uid } from './util';

export interface ReconBreak {
  type: string;
  entity: string;
  expected: string;
  actual: string;
  detail?: string;
}

export interface ReconSummary {
  runId: string;
  status: 'PASSED' | 'FAILED';
  checks: { type: string; checked: number; breaks: number }[];
  breaks: ReconBreak[];
}

/**
 * Daily integrity checks. Every projection is compared with the journal it is derived from,
 * and the pipeline is checked for work that is stuck.
 */
export function runReconciliation(ctx: EngineCtx, actor: Actor, minutesStuck = 15): ReconSummary {
  const { db, clock } = ctx;
  const runId = uid();
  const started = clock.now().toISOString();
  db.run(`INSERT INTO reconciliation_run(run_id, run_type, started_at, status, run_by) VALUES (?,?,?,?,?)`, runId, 'DAILY', started, 'RUNNING', actor.username);
  const breaks: ReconBreak[] = [];
  const checks: ReconSummary['checks'] = [];
  const check = (type: string, checked: number, found: ReconBreak[]) => {
    checks.push({ type, checked, breaks: found.length });
    breaks.push(...found);
  };

  // 1. XP balance projection equals the ledger.
  {
    const rows = db.all<any>(
      `SELECT c.customer_id, c.customer_ref, COALESCE(a.balance,0) AS projected, COALESCE(l.s,0) AS ledger
         FROM customer c LEFT JOIN xp_account a ON a.customer_id = c.customer_id
         LEFT JOIN (SELECT customer_id, SUM(points) AS s FROM xp_ledger GROUP BY customer_id) l ON l.customer_id = c.customer_id`,
    );
    check('LEDGER_BALANCE', rows.length, rows.filter((r) => r.projected !== r.ledger).map((r) => ({
      type: 'LEDGER_BALANCE', entity: r.customer_ref, expected: String(r.ledger), actual: String(r.projected), detail: 'xp_account differs from SUM(xp_ledger)',
    })));
  }

  // 2. Goal progress projection equals its contribution journal.
  {
    const rows = db.all<any>(
      `SELECT gp.customer_id, gp.rule_version_id, gp.period_key, gp.txn_count, gp.txn_sum_minor,
              COALESCE(SUM(c.count_delta),0) AS jc, COALESCE(SUM(c.amount_delta_minor),0) AS ja, v.kind
         FROM goal_progress gp JOIN rule_version v ON v.rule_version_id = gp.rule_version_id
         LEFT JOIN goal_contribution c ON c.customer_id = gp.customer_id AND c.rule_version_id = gp.rule_version_id AND c.period_key = gp.period_key
        WHERE v.metric_type IN ('COUNT','SUM') OR v.kind = 'PER_EVENT' GROUP BY gp.progress_id`,
    );
    check('PROGRESS_VS_JOURNAL', rows.length, rows.filter((r) => r.txn_count !== r.jc || r.txn_sum_minor !== r.ja).map((r) => ({
      type: 'PROGRESS_VS_JOURNAL', entity: `${r.customer_id}/${r.period_key}`, expected: `${r.jc}/${r.ja}`, actual: `${r.txn_count}/${r.txn_sum_minor}`, detail: 'goal_progress differs from goal_contribution',
    })));
  }

  // 3. Contributions agree with the transaction master (status and refunds).
  {
    const rows = db.all<any>(
      `SELECT t.txn_id, t.source_txn_id, t.status, t.amount_minor, t.refunded_minor, c.rule_version_id, SUM(c.amount_delta_minor) AS net, SUM(c.count_delta) AS cnt
         FROM goal_contribution c JOIN txn_master t ON t.txn_id = c.txn_id GROUP BY c.txn_id, c.rule_version_id`,
    );
    const bad = rows.filter((r) => {
      if (['REVERSED', 'REFUNDED', 'FAILED'].includes(r.status)) return r.net !== 0 || r.cnt !== 0;
      if (r.status === 'PARTIALLY_REFUNDED') return r.net !== 0 && r.net !== r.amount_minor - r.refunded_minor;
      return r.net !== 0 && r.net !== r.amount_minor;
    });
    check('JOURNAL_VS_MASTER', rows.length, bad.map((r) => ({
      type: 'JOURNAL_VS_MASTER', entity: r.source_txn_id, expected: `status ${r.status}`, actual: `net contribution ${r.net / 100}`, detail: 'contribution does not match transaction state',
    })));
  }

  // 4. Reversals never exceed the award they reverse; no award key is duplicated.
  {
    const rows = db.all<any>(
      `SELECT a.ledger_id, a.points, COALESCE(-SUM(r.points),0) AS reversed FROM xp_ledger a LEFT JOIN xp_ledger r ON r.reverses_ledger_id = a.ledger_id
        WHERE a.entry_type = 'AWARD' GROUP BY a.ledger_id`,
    );
    check('REVERSAL_INTEGRITY', rows.length, rows.filter((r) => r.reversed > r.points).map((r) => ({
      type: 'REVERSAL_INTEGRITY', entity: `ledger ${r.ledger_id}`, expected: `<= ${r.points}`, actual: String(r.reversed), detail: 'reversed more than awarded',
    })));
  }

  // 5. Campaign budgets.
  {
    const rows = db.all<any>(
      `SELECT c.campaign_code, c.points_budget, COALESCE((SELECT SUM(points) FROM xp_ledger WHERE campaign_id = c.campaign_id),0) AS issued FROM campaign c WHERE c.points_budget IS NOT NULL`,
    );
    check('CAMPAIGN_BUDGET', rows.length, rows.filter((r) => r.issued > r.points_budget).map((r) => ({
      type: 'CAMPAIGN_BUDGET', entity: r.campaign_code, expected: `<= ${r.points_budget}`, actual: String(r.issued), detail: 'budget exceeded',
    })));
  }

  // 6. Batch control totals.
  {
    const rows = db.all<any>(`SELECT * FROM ingestion_batch WHERE status = 'MISMATCH'`);
    check('BATCH_CONTROL', rows.length, rows.map((b) => ({
      type: 'BATCH_CONTROL', entity: b.file_name ?? b.batch_id, expected: `${b.control_count ?? '-'} rows / ${(b.control_amount_minor ?? 0) / 100}`,
      actual: `${b.accepted_count + b.duplicate_count + b.rejected_count} rows / ${b.accepted_amount_minor / 100}`, detail: 'file totals differ from what was ingested',
    })));
  }

  // 7. Pipeline health.
  {
    const cutoff = new Date(clock.now().getTime() - minutesStuck * 60000).toISOString();
    const stuck = db.all<any>(
      `SELECT event_id, source_event_id, processing_status, received_at FROM ingestion_event WHERE processing_status IN ('RECEIVED','NORMALIZED','PROCESSING','FAILED') AND received_at < ?`,
      cutoff,
    );
    const dead = db.all<any>(`SELECT event_id, source_event_id, error_code FROM ingestion_event WHERE processing_status = 'DEAD_LETTER'`);
    const pendingTxn = db.all<any>(`SELECT source_txn_id FROM txn_master WHERE processing_status = 'PENDING_EVAL' AND updated_at < ?`, cutoff);
    check('PIPELINE_STUCK', stuck.length, stuck.map((e) => ({ type: 'PIPELINE_STUCK', entity: e.source_event_id, expected: 'PROCESSED', actual: e.processing_status, detail: `since ${e.received_at}` })));
    check('DEAD_LETTERS', dead.length, dead.map((e) => ({ type: 'DEAD_LETTERS', entity: e.source_event_id, expected: 'PROCESSED', actual: 'DEAD_LETTER', detail: e.error_code ?? '' })));
    check('TXN_NOT_EVALUATED', pendingTxn.length, pendingTxn.map((t) => ({ type: 'TXN_NOT_EVALUATED', entity: t.source_txn_id, expected: 'EVALUATED', actual: 'PENDING_EVAL' })));
  }

  // 8. Audit chain.
  {
    const a = verifyAuditChain(db);
    check('AUDIT_CHAIN', a.checked, a.ok ? [] : [{ type: 'AUDIT_CHAIN', entity: `audit ${a.brokenAt}`, expected: 'intact hash chain', actual: 'broken', detail: 'audit_log was altered' }]);
  }

  const status = breaks.length ? 'FAILED' : 'PASSED';
  db.tx(() => {
    for (const b of breaks) {
      db.run('INSERT INTO reconciliation_break(run_id, break_type, entity_ref, expected, actual, detail) VALUES (?,?,?,?,?,?)', runId, b.type, b.entity, b.expected, b.actual, b.detail ?? null);
    }
    db.run(
      'UPDATE reconciliation_run SET finished_at = ?, status = ?, checked = ?, breaks = ? WHERE run_id = ?',
      clock.now().toISOString(), status, checks.reduce((a, c) => a + c.checked, 0), breaks.length, runId,
    );
    audit(db, clock, actor, 'RECONCILIATION_RUN', 'reconciliation_run', runId, null, { status, breaks: breaks.length });
  });
  return { runId, status, checks, breaks };
}

export interface SourceEntry {
  sourceTxnId: string;
  amount: number | string;
  status?: string;
}

/**
 * Compares the master with a control file from a source system (for sources that cannot stream).
 * Matching rows are marked MATCHED, differing rows MISMATCH; missing and unexpected rows are reported.
 */
export function reconcileAgainstSource(ctx: EngineCtx, actor: Actor, sourceSystem: string, entries: SourceEntry[], dateFrom?: string, dateTo?: string) {
  const { db, clock } = ctx;
  if (entries.length > 50000) throw new MxpError('TOO_MANY', 'Reconcile at most 50,000 rows per call.');
  const now = clock.now().toISOString();
  const missing: string[] = [];
  const mismatched: { sourceTxnId: string; expected: string; actual: string }[] = [];
  let matched = 0;
  const seen = new Set<string>();
  db.tx(() => {
    for (const e of entries) {
      seen.add(e.sourceTxnId);
      const t = db.get<any>('SELECT txn_id, amount_minor, status FROM txn_master WHERE source_system = ? AND source_txn_id = ?', sourceSystem, e.sourceTxnId);
      if (!t) {
        missing.push(e.sourceTxnId);
        continue;
      }
      const sameAmount = t.amount_minor === toMinor(e.amount);
      const sameStatus = !e.status || t.status === e.status;
      if (sameAmount && sameStatus) {
        matched++;
        db.run(`UPDATE txn_master SET recon_status = 'MATCHED', recon_at = ? WHERE txn_id = ?`, now, t.txn_id);
      } else {
        mismatched.push({ sourceTxnId: e.sourceTxnId, expected: `${e.amount} ${e.status ?? ''}`.trim(), actual: `${t.amount_minor / 100} ${t.status}` });
        db.run(`UPDATE txn_master SET recon_status = 'MISMATCH', recon_at = ? WHERE txn_id = ?`, now, t.txn_id);
      }
    }
  });
  let unexpected: string[] = [];
  if (dateFrom && dateTo) {
    unexpected = db
      .all<{ source_txn_id: string }>(
        `SELECT source_txn_id FROM txn_master WHERE source_system = ? AND substr(txn_ts,1,10) BETWEEN ? AND ? AND is_reversal = 0`,
        sourceSystem, dateFrom, dateTo,
      )
      .map((r) => r.source_txn_id)
      .filter((id) => !seen.has(id));
  }
  audit(db, clock, actor, 'SOURCE_RECONCILIATION', 'source_system', sourceSystem, null, { rows: entries.length, matched, missing: missing.length, mismatched: mismatched.length, unexpected: unexpected.length });
  return { rows: entries.length, matched, missingInMxp: missing, mismatched, unexpectedInMxp: unexpected };
}

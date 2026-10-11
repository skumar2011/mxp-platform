import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MxpError, audit, decideAdjustment, requestAdjustment, verifyAuditChain, customerBalance } from '@mxp/engine';
import type { AppCtx } from '../context';
import { actorOf, need, page, parse, sendCsv, toCsv, userOf, where } from '../util';

const MONEY_METRICS = new Set(['SUM', 'AVG_BALANCE', 'MIN_BALANCE', 'BALANCE_GROWTH']);

export function reportRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db, clock } = ctx;

  // ---------- dashboard ----------
  app.get('/dashboard', async (req) => {
    need(req, 'rules:read');
    const dayAgo = new Date(clock.now().getTime() - 86_400_000).toISOString();
    const rulesByStatus = db.all<any>('SELECT status, COUNT(*) AS n FROM rule_version GROUP BY status');
    const xp = db.get<any>(
      `SELECT COALESCE(SUM(points),0) AS net,
              COALESCE(SUM(CASE WHEN entry_type='AWARD' THEN points END),0) AS awarded,
              COALESCE(-SUM(CASE WHEN entry_type='REVERSAL' THEN points END),0) AS reversed,
              COALESCE(SUM(CASE WHEN entry_type='ADJUSTMENT' THEN points END),0) AS adjusted,
              COUNT(DISTINCT customer_id) AS customers FROM xp_ledger`,
    );
    const daily = db.all<any>(
      `SELECT substr(created_at,1,10) AS day,
              COALESCE(SUM(CASE WHEN points>0 THEN points END),0) AS awarded,
              COALESCE(-SUM(CASE WHEN points<0 THEN points END),0) AS reversed
         FROM xp_ledger GROUP BY day ORDER BY day DESC LIMIT 30`,
    ).reverse();
    const topRules = db.all<any>(
      `SELECT r.rule_code AS ruleCode, SUM(l.points) AS points, COUNT(DISTINCT l.customer_id) AS customers
         FROM xp_ledger l JOIN rule r ON r.rule_id = l.rule_id GROUP BY r.rule_code ORDER BY points DESC LIMIT 8`,
    );
    const outcomes = db.all<any>(`SELECT outcome, COUNT(*) AS n FROM rule_evaluation WHERE evaluated_at >= ? GROUP BY outcome ORDER BY n DESC`, new Date(clock.now().getTime() - 7 * 86_400_000).toISOString());
    const events = db.all<any>('SELECT processing_status AS status, COUNT(*) AS n FROM ingestion_event GROUP BY processing_status');
    const events24 = db.all<any>('SELECT processing_status AS status, COUNT(*) AS n FROM ingestion_event WHERE received_at >= ? GROUP BY processing_status', dayAgo);
    const nudges = db.all<any>('SELECT status, COUNT(*) AS n FROM nudge GROUP BY status');
    const lastRecon = db.get<any>('SELECT * FROM reconciliation_run ORDER BY started_at DESC LIMIT 1');
    const campaigns = db.all<any>(
      `SELECT c.campaign_code AS code, c.name, c.status, c.points_budget AS budget, c.end_date AS endDate,
              COALESCE((SELECT SUM(points) FROM xp_ledger l WHERE l.campaign_id = c.campaign_id),0) AS spent
         FROM campaign c WHERE c.status IN ('ACTIVE','PAUSED') ORDER BY c.end_date`,
    );
    return {
      generatedAt: clock.now().toISOString(),
      env: ctx.cfg.env,
      rulesByStatus,
      pendingApprovals: db.value<number>(`SELECT COUNT(*) FROM rule_version WHERE status = 'PENDING_APPROVAL'`) ?? 0,
      pendingAdjustments: db.value<number>(`SELECT COUNT(*) FROM reward_adjustment WHERE status = 'REQUESTED'`) ?? 0,
      xp, daily, topRules, outcomes, events, events24, nudges, lastRecon, campaigns,
      transactions: {
        total: db.value<number>('SELECT COUNT(*) FROM txn_master WHERE is_reversal = 0') ?? 0,
        awaitingEvaluation: db.value<number>(`SELECT COUNT(*) FROM txn_master WHERE processing_status = 'PENDING_EVAL'`) ?? 0,
        customers: db.value<number>('SELECT COUNT(*) FROM customer') ?? 0,
      },
    };
  });

  // ---------- evaluations (search + export) ----------
  const evalQuery = (q: any) => {
    const w = where([
      [q.customerRef, 'c.customer_ref = ?'],
      [q.ruleCode, 'r.rule_code = ?'],
      [q.outcome, 'e.outcome = ?'],
      [q.period, 'e.period_key = ?'],
      [q.trigger, 'e.trigger_kind = ?'],
      [q.from, 'substr(e.evaluated_at,1,10) >= ?'],
      [q.to, 'substr(e.evaluated_at,1,10) <= ?'],
      [q.q, '(e.reason_text LIKE ? OR e.reason_code LIKE ?)', `%${String(q.q ?? '').slice(0, 60)}%`, `%${String(q.q ?? '').slice(0, 60)}%`],
    ]);
    const base = `FROM rule_evaluation e JOIN customer c ON c.customer_id = e.customer_id JOIN rule r ON r.rule_id = e.rule_id
        JOIN rule_version v ON v.rule_version_id = e.rule_version_id LEFT JOIN txn_master t ON t.txn_id = e.txn_id ${w.sql}`;
    return { base, params: w.params };
  };
  const evalRows = (q: any, limit: number, offset: number) => {
    const { base, params } = evalQuery(q);
    return db
      .all<any>(
        `SELECT e.evaluation_id AS evaluationId, e.evaluated_at AS evaluatedAt, c.customer_ref AS customerRef, r.rule_code AS ruleCode, v.version_no AS versionNo,
                e.trigger_kind AS trigger, e.period_key AS period, e.outcome, e.eligible, e.reason_code AS reasonCode, e.reason_text AS reason,
                e.metric_value AS metricRaw, v.metric_type AS metricType, e.points_target AS pointsTarget, e.points_delta AS pointsDelta, t.source_txn_id AS sourceTxnId
           ${base} ORDER BY e.evaluated_at DESC, e.rowid DESC LIMIT ? OFFSET ?`,
        ...params, limit, offset,
      )
      .map(({ metricRaw, metricType, ...r }) => ({ ...r, eligible: !!r.eligible, metric: metricRaw === null ? null : MONEY_METRICS.has(metricType) ? metricRaw / 100 : metricRaw }));
  };

  app.get('/evaluations', async (req) => {
    need(req, 'rules:read');
    const q = req.query as any;
    const { limit, offset } = page(q);
    const { base, params } = evalQuery(q);
    const total = db.value<number>(`SELECT COUNT(*) ${base}`, ...params) ?? 0;
    return { total, limit, offset, rows: evalRows(q, limit, offset) };
  });

  app.get('/evaluations/export.csv', async (req, reply) => {
    const actor = need(req, 'export');
    const q = req.query as any;
    const rows = evalRows(q, 50_000, 0);
    audit(db, clock, actor, 'EXPORT', 'rule_evaluation', 'evaluations.csv', null, { rows: rows.length, filter: q });
    return sendCsv(reply, `evaluations-${clock.now().toISOString().slice(0, 10)}.csv`, toCsv(
      ['evaluatedAt', 'customerRef', 'ruleCode', 'versionNo', 'trigger', 'period', 'outcome', 'eligible', 'metric', 'pointsTarget', 'pointsDelta', 'reasonCode', 'reason', 'sourceTxnId', 'evaluationId'], rows,
    ));
  });

  app.get('/evaluations/:id', async (req) => {
    need(req, 'rules:read');
    const { id } = req.params as any;
    const e = db.get<any>(
      `SELECT e.*, c.customer_ref, r.rule_code, v.version_no, v.metric_type, t.source_txn_id FROM rule_evaluation e JOIN customer c ON c.customer_id = e.customer_id
         JOIN rule r ON r.rule_id = e.rule_id JOIN rule_version v ON v.rule_version_id = e.rule_version_id LEFT JOIN txn_master t ON t.txn_id = e.txn_id WHERE e.evaluation_id = ?`, id);
    if (!e) throw new MxpError('NOT_FOUND', 'Evaluation not found.', 404);
    const { trace_json, ...rest } = e;
    const ledger = db.all('SELECT ledger_id, entry_type, points, slot, tier_no, reason_code, created_at FROM xp_ledger WHERE evaluation_id = ?', id);
    return { ...rest, trace: trace_json ? JSON.parse(trace_json) : null, ledger };
  });

  // ---------- ledger ----------
  const ledgerRows = (q: any, limit: number, offset: number) => {
    const w = where([
      [q.customerRef, 'c.customer_ref = ?'],
      [q.ruleCode, 'r.rule_code = ?'],
      [q.campaign, 'ca.campaign_code = ?'],
      [q.type, 'l.entry_type = ?'],
      [q.from, 'substr(l.created_at,1,10) >= ?'],
      [q.to, 'substr(l.created_at,1,10) <= ?'],
    ]);
    const base = `FROM xp_ledger l JOIN customer c ON c.customer_id = l.customer_id LEFT JOIN rule r ON r.rule_id = l.rule_id LEFT JOIN campaign ca ON ca.campaign_id = l.campaign_id ${w.sql}`;
    const total = db.value<number>(`SELECT COUNT(*) ${base}`, ...w.params) ?? 0;
    const sum = db.value<number>(`SELECT COALESCE(SUM(l.points),0) ${base}`, ...w.params) ?? 0;
    const rows = db.all<any>(
      `SELECT l.ledger_id AS ledgerId, l.created_at AS createdAt, c.customer_ref AS customerRef, l.entry_type AS entryType, l.points, r.rule_code AS ruleCode,
              ca.campaign_code AS campaign, l.period_key AS period, l.slot, l.tier_no AS tierNo, l.reason_code AS reasonCode, l.reason_text AS reason,
              l.source_txn_id AS sourceTxnId, l.reverses_ledger_id AS reversesLedgerId, l.created_by AS createdBy
         ${base} ORDER BY l.ledger_id DESC LIMIT ? OFFSET ?`,
      ...w.params, limit, offset,
    );
    return { total, sum, rows };
  };
  app.get('/ledger', async (req) => {
    need(req, 'rules:read');
    const q = req.query as any;
    const { limit, offset } = page(q);
    return { limit, offset, ...ledgerRows(q, limit, offset) };
  });
  app.get('/ledger/export.csv', async (req, reply) => {
    const actor = need(req, 'export');
    const q = req.query as any;
    const r = ledgerRows(q, 50_000, 0);
    audit(db, clock, actor, 'EXPORT', 'xp_ledger', 'ledger.csv', null, { rows: r.rows.length, filter: q });
    return sendCsv(reply, `xp-ledger-${clock.now().toISOString().slice(0, 10)}.csv`, toCsv(
      ['ledgerId', 'createdAt', 'customerRef', 'entryType', 'points', 'ruleCode', 'campaign', 'period', 'slot', 'tierNo', 'reasonCode', 'reason', 'sourceTxnId', 'reversesLedgerId', 'createdBy'], r.rows,
    ));
  });

  // ---------- customers ----------
  app.get('/customers', async (req) => {
    need(req, 'customers:read');
    const q = req.query as any;
    const { limit, offset } = page(q, 200);
    const w = where([[q.q, 'c.customer_ref LIKE ?', `%${String(q.q ?? '').slice(0, 40)}%`]]);
    const rows = db.all(
      `SELECT c.customer_ref AS customerRef, c.masked_name AS name, c.status, c.nudge_consent AS nudgeConsent, COALESCE(x.balance,0) AS xpBalance,
              (SELECT COUNT(*) FROM txn_master t WHERE t.customer_id = c.customer_id AND t.is_reversal = 0) AS txns
         FROM customer c LEFT JOIN xp_account x ON x.customer_id = c.customer_id ${w.sql} ORDER BY c.customer_ref LIMIT ? OFFSET ?`,
      ...w.params, limit, offset,
    );
    return { rows };
  });

  app.get('/customers/:ref', async (req) => {
    need(req, 'customers:read');
    const { ref } = req.params as any;
    const c = db.get<any>('SELECT * FROM customer WHERE customer_ref = ?', ref);
    if (!c) throw new MxpError('NOT_FOUND', `Customer ${ref} not found.`, 404);
    const id = c.customer_id;
    return {
      customer: { customerRef: c.customer_ref, name: c.masked_name, status: c.status, type: c.customer_type, kyc: c.kyc_status, nudgeConsent: !!c.nudge_consent },
      xp: { balance: customerBalance(db, id), ...(db.get('SELECT lifetime_earned AS earned, lifetime_reversed AS reversed FROM xp_account WHERE customer_id = ?', id) ?? { earned: 0, reversed: 0 }) },
      segments: db.all<any>('SELECT segment_code FROM customer_segment WHERE customer_id = ?', id).map((s) => s.segment_code),
      accounts: db.all(
        `SELECT a.account_ref AS accountRef, a.product_code AS product, a.account_type AS type, a.status,
                (SELECT closing_balance_minor/100.0 FROM balance_snapshot b WHERE b.account_id = a.account_id ORDER BY as_of_date DESC LIMIT 1) AS latestBalance,
                (SELECT as_of_date FROM balance_snapshot b WHERE b.account_id = a.account_id ORDER BY as_of_date DESC LIMIT 1) AS balanceDate
           FROM account a WHERE a.customer_id = ? ORDER BY a.account_ref`, id),
      progress: db.all<any>(
        `SELECT r.rule_code AS ruleCode, v.version_no AS versionNo, v.name, v.metric_type AS metricType, p.period_key AS period, p.status, p.metric_value AS metricRaw,
                p.achieved_tier AS achievedTier, p.txn_count AS txnCount, p.data_note AS note,
                COALESCE((SELECT SUM(points) FROM xp_ledger l WHERE l.customer_id = p.customer_id AND l.rule_id = p.rule_id AND l.period_key = p.period_key),0) AS points
           FROM goal_progress p JOIN rule r ON r.rule_id = p.rule_id JOIN rule_version v ON v.rule_version_id = p.rule_version_id
          WHERE p.customer_id = ? ORDER BY p.period_start DESC, r.rule_code`, id,
      ).map(({ metricRaw, metricType, ...p }) => ({ ...p, metric: MONEY_METRICS.has(metricType) ? metricRaw / 100 : metricRaw })),
      ledger: db.all(
        `SELECT l.ledger_id AS ledgerId, l.created_at AS createdAt, l.entry_type AS entryType, l.points, r.rule_code AS ruleCode, l.period_key AS period, l.reason_text AS reason
           FROM xp_ledger l LEFT JOIN rule r ON r.rule_id = l.rule_id WHERE l.customer_id = ? ORDER BY l.ledger_id DESC LIMIT 50`, id),
      nudges: db.all('SELECT created_at AS createdAt, nudge_type AS type, channel, status, message, suppress_reason AS suppressReason FROM nudge WHERE customer_id = ? ORDER BY created_at DESC LIMIT 30', id),
      transactions: db.all(
        `SELECT t.source_txn_id AS sourceTxnId, t.txn_ts AS at, t.txn_type AS type, t.channel_code AS channel, t.amount_minor/100.0 AS amount, t.status, t.is_reversal AS isReversal, t.merchant_name AS merchant, t.category_code AS category
           FROM txn_master t WHERE t.customer_id = ? ORDER BY t.txn_ts DESC LIMIT 50`, id),
    };
  });

  // ---------- adjustments (maker-checker) ----------
  app.get('/adjustments', async (req) => {
    need(req, 'rules:read');
    const q = req.query as any;
    const w = where([[q.status, 'a.status = ?']]);
    return {
      rows: db.all(
        `SELECT a.adjustment_id AS adjustmentId, c.customer_ref AS customerRef, a.points, a.reason, a.status, a.requested_by AS requestedBy, a.requested_at AS requestedAt,
                a.decided_by AS decidedBy, a.decided_at AS decidedAt, a.decision_note AS decisionNote
           FROM reward_adjustment a JOIN customer c ON c.customer_id = a.customer_id ${w.sql} ORDER BY a.requested_at DESC LIMIT 200`, ...w.params),
    };
  });
  app.post('/adjustments', async (req, reply) => {
    const actor = need(req, 'adjust:request');
    const b = parse(z.object({ customerRef: z.string().min(1).max(64), points: z.number().int(), reason: z.string().min(5).max(500) }), req.body);
    return reply.code(201).send(requestAdjustment(engineCtx(), actor, b.customerRef, b.points, b.reason));
  });
  app.post('/adjustments/:id/decide', async (req) => {
    const actor = need(req, 'adjust:approve');
    const { id } = req.params as any;
    const b = parse(z.object({ approve: z.boolean(), note: z.string().max(500).optional() }), req.body);
    return decideAdjustment(engineCtx(), actor, id, b.approve, b.note);
  });
  const engineCtx = () => ctx.engine.ctx;

  // ---------- nudges ----------
  app.get('/nudges', async (req) => {
    need(req, 'rules:read');
    const q = req.query as any;
    const { limit, offset } = page(q);
    const w = where([[q.status, 'n.status = ?'], [q.type, 'n.nudge_type = ?'], [q.customerRef, 'c.customer_ref = ?']]);
    const total = db.value<number>(`SELECT COUNT(*) FROM nudge n JOIN customer c ON c.customer_id = n.customer_id ${w.sql}`, ...w.params) ?? 0;
    const rows = db.all(
      `SELECT n.nudge_id AS nudgeId, n.created_at AS createdAt, c.customer_ref AS customerRef, r.rule_code AS ruleCode, n.nudge_type AS type, n.channel, n.status, n.message, n.suppress_reason AS suppressReason
         FROM nudge n JOIN customer c ON c.customer_id = n.customer_id LEFT JOIN rule r ON r.rule_id = n.rule_id ${w.sql} ORDER BY n.created_at DESC, n.rowid DESC LIMIT ? OFFSET ?`, ...w.params, limit, offset);
    return { total, rows };
  });

  // ---------- audit ----------
  const auditRows = (q: any, limit: number, offset: number) => {
    const w = where([
      [q.entityType, 'entity_type = ?'],
      [q.entityId, 'entity_id = ?'],
      [q.actor, 'actor = ?'],
      [q.action, 'action = ?'],
      [q.from, 'substr(occurred_at,1,10) >= ?'],
      [q.to, 'substr(occurred_at,1,10) <= ?'],
    ]);
    const total = db.value<number>(`SELECT COUNT(*) FROM audit_log ${w.sql}`, ...w.params) ?? 0;
    const rows = db.all(
      `SELECT audit_id AS auditId, occurred_at AS occurredAt, actor, actor_roles AS roles, action, entity_type AS entityType, entity_id AS entityId, reason, before_json AS before, after_json AS after
         FROM audit_log ${w.sql} ORDER BY audit_id DESC LIMIT ? OFFSET ?`, ...w.params, limit, offset);
    return { total, rows };
  };
  app.get('/audit', async (req) => {
    need(req, 'audit:read');
    const q = req.query as any;
    const { limit, offset } = page(q);
    return { limit, offset, ...auditRows(q, limit, offset) };
  });
  app.get('/audit/export.csv', async (req, reply) => {
    const actor = need(req, 'export');
    if (!(userOf(req).roles.some((r) => ['AUDITOR', 'SYSTEM_ADMIN'].includes(r)))) throw new MxpError('FORBIDDEN', 'Audit export is limited to auditors and administrators.', 403);
    const r = auditRows(req.query as any, 50_000, 0);
    audit(db, clock, actor, 'EXPORT', 'audit_log', 'audit.csv', null, { rows: r.rows.length });
    return sendCsv(reply, `audit-${clock.now().toISOString().slice(0, 10)}.csv`, toCsv(['auditId', 'occurredAt', 'actor', 'roles', 'action', 'entityType', 'entityId', 'reason', 'before', 'after'], r.rows as any[]));
  });
  app.get('/audit/verify', async (req) => {
    need(req, 'audit:read');
    return verifyAuditChain(db);
  });
}

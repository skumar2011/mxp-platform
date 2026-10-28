import { localParts, type Effect, type Evaluation, type MxpEvent, type ProcessResult } from '@mxp/rules';
import { audit } from './audit';
import type { Catalog } from './catalog';
import type { Db } from './db';
import type { Participation } from './participation';
import { SqliteStateStore } from './store';
import { hashJson, MxpError, uid, type Actor, type Clock } from './util';

export interface EventInput {
  sourceSystem?: string;
  /** Id in the source system; redelivery of the same id is a no-op. */
  sourceEventId?: string;
  type: string;
  /** Optional when accountId is provided (derived from the account). */
  customerId?: string;
  /** Required — transactions are account-based. */
  accountId: string;
  timestamp: string;
  /** sourceEventId of the event being reversed (same source system). */
  reversalOf?: string | null;
  sourceChannel?: string | null;
  dwhBatchId?: string | null;
  [attr: string]: unknown;
}

export interface DwhRow {
  sourceEventId: string;
  type: string;
  accountId: string;
  customerId?: string;
  timestamp: string;
  reversalOf?: string | null;
  sourceChannel?: string | null;
  [attr: string]: unknown;
}

const SKIP_PERSIST = new Set(['OUT_OF_SCOPE', 'NOT_EFFECTIVE']);
const RESERVED = new Set(['sourceSystem', 'sourceEventId', 'type', 'customerId', 'accountId', 'timestamp', 'reversalOf', 'id', 'sourceChannel', 'dwhBatchId']);

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
  status: 'PROCESSED' | 'FAILED';
  decision: string;
  points: number;
  evaluations: Evaluation[];
  effects: Effect[];
  error?: string;
}

export class Runtime {
  constructor(private db: Db, private clock: Clock, private catalog: Catalog, private part: Participation) {}

  private now() {
    return this.clock.now().toISOString();
  }

  store() {
    return new SqliteStateStore(this.db, () => this.now());
  }

  private resolveAccount(accountId: string, customerId?: string) {
    const a = this.db.get<any>('SELECT * FROM account WHERE account_id = ? OR account_ref = ?', accountId, accountId);
    if (!a) throw new MxpError('UNKNOWN_ACCOUNT', `Account ${accountId} not found.`, 422);
    if (customerId) {
      const c = this.part.customerRow(customerId);
      if (a.customer_id !== c.customer_id) throw new MxpError('ACCOUNT_MISMATCH', `Account ${accountId} does not belong to customer ${customerId}.`, 422);
    }
    return a;
  }

  private toEvent(input: EventInput, customerId: string, accountId: string): { event: MxpEvent; source: string; sourceId: string } {
    if (!input.type) throw new MxpError('INVALID_EVENT', 'type is required.', 422);
    if (!input.timestamp || Number.isNaN(new Date(input.timestamp).getTime())) throw new MxpError('INVALID_EVENT', 'timestamp must be an ISO-8601 instant.', 422);
    if (!accountId) throw new MxpError('INVALID_EVENT', 'accountId is required — transactions are account-based.', 422);
    const source = input.sourceSystem || 'API';
    const sourceId = input.sourceEventId || uid();
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (!RESERVED.has(k)) attrs[k] = v;
    const event: MxpEvent = {
      ...attrs,
      id: `${source}:${sourceId}`,
      type: input.type,
      customerId,
      accountId,
      timestamp: new Date(input.timestamp).toISOString(),
      reversalOf: input.reversalOf ? `${source}:${input.reversalOf}` : null,
    };
    return { event, source, sourceId };
  }

  /** Ingests a business event: stores it, runs every live rule in date range, persists effects. */
  ingest(input: EventInput, actor: Actor): IngestResult {
    const acct = this.resolveAccount(input.accountId, input.customerId);
    const customerId = acct.customer_id;
    const { event, source, sourceId } = this.toEvent(input, customerId, acct.account_id);
    const prior = this.db.get<any>('SELECT event_id, status, payload_hash FROM "transaction" WHERE source_system = ? AND source_event_id = ?', source, sourceId);
    if (prior?.status === 'FAILED') this.db.run('DELETE FROM "transaction" WHERE event_id = ?', prior.event_id);
    else if (prior) {
      if (prior.payload_hash !== hashJson(event)) throw new MxpError('EVENT_CONFLICT', `Event ${source}:${sourceId} was already received with different content.`, 409);
      return { eventId: prior.event_id, duplicate: true, status: prior.status, decision: 'ALLOW', points: 0, evaluations: [], effects: [] };
    }
    if (event.reversalOf && !this.db.get('SELECT 1 FROM "transaction" WHERE event_id = ?', event.reversalOf)) throw new MxpError('UNKNOWN_REVERSAL', `reversalOf ${input.reversalOf} is not a known event from ${source}.`, 422);
    const { engine, releaseId } = this.catalog.engine();
    try {
      return this.db.tx(() => {
        this.db.run(
          `INSERT INTO "transaction"(event_id, source_system, source_event_id, event_type, customer_id, account_id, occurred_at, reversal_of, payload_json, payload_hash, received_at, status, pack_hash, dwh_batch_id, source_channel)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'RECEIVED',?,?,?)`,
          event.id, source, sourceId, event.type, customerId, acct.account_id, event.timestamp, event.reversalOf ?? null, JSON.stringify(event), hashJson(event), this.now(), releaseId,
          input.dwhBatchId ?? null, input.sourceChannel ?? null,
        );
        const ctx = this.part.contextFor(customerId, { accountId: acct.account_id, asOf: event.timestamp });
        const res = engine.process(event, ctx, this.store());
        this.persist(res, releaseId, actor, { eventId: event.id, accountId: acct.account_id, occurredAt: event.timestamp, tz: String(ctx.customer.timezone ?? engine.pack.timezone) });
        this.db.run(`UPDATE "transaction" SET status = 'PROCESSED', processed_at = ? WHERE event_id = ?`, this.now(), event.id);
        return { eventId: event.id, duplicate: false, status: 'PROCESSED' as const, decision: res.decision, points: res.points, evaluations: res.evaluations, effects: res.effects };
      });
    } catch (e) {
      if (e instanceof MxpError) throw e;
      const msg = (e as Error).message;
      this.db.run(
        `INSERT INTO "transaction"(event_id, source_system, source_event_id, event_type, customer_id, account_id, occurred_at, reversal_of, payload_json, payload_hash, received_at, status, error_text, pack_hash, dwh_batch_id, source_channel)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'FAILED',?,?,?,?)`,
        event.id, source, sourceId, event.type, customerId, acct.account_id, event.timestamp, event.reversalOf ?? null, JSON.stringify(event), hashJson(event), this.now(), msg, releaseId,
        input.dwhBatchId ?? null, input.sourceChannel ?? null,
      );
      return { eventId: event.id, duplicate: false, status: 'FAILED', decision: 'ALLOW', points: 0, evaluations: [], effects: [], error: msg };
    }
  }

  /**
   * Daily DWH sync: upsert warehouse rows for a business date, evaluate new/changed events,
   * then optionally generate performance nudges.
   */
  syncFromDwh(businessDate: string, rows: DwhRow[], actor: Actor, opts: { sourceSystem?: string; evaluate?: boolean; performanceNudges?: boolean } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new MxpError('INVALID_DATE', 'businessDate must be YYYY-MM-DD.', 422);
    const source = opts.sourceSystem ?? 'DWH';
    const batchId = uid();
    const started = this.now();
    this.db.run(
      `INSERT INTO dwh_batch(batch_id, business_date, source_system, row_count, status, started_at) VALUES (?,?,?,?,'RUNNING',?)`,
      batchId, businessDate, source, rows.length, started,
    );
    let inserted = 0, updated = 0, skipped = 0, failed = 0;
    const toEvaluate: EventInput[] = [];
    try {
      for (const row of rows) {
        try {
          if (!row.accountId || !row.sourceEventId || !row.type || !row.timestamp) {
            failed++;
            continue;
          }
          const acct = this.resolveAccount(row.accountId, row.customerId);
          const input: EventInput = {
            ...row,
            sourceSystem: source,
            sourceEventId: row.sourceEventId,
            accountId: acct.account_id,
            customerId: acct.customer_id,
            dwhBatchId: batchId,
            sourceChannel: row.sourceChannel ?? (typeof row.channel === 'string' ? row.channel : null),
          };
          const { event } = this.toEvent(input, acct.customer_id, acct.account_id);
          const prior = this.db.get<any>('SELECT event_id, status, payload_hash FROM "transaction" WHERE source_system = ? AND source_event_id = ?', source, row.sourceEventId);
          if (prior) {
            if (prior.payload_hash === hashJson(event) && prior.status === 'PROCESSED') {
              skipped++;
              continue;
            }
            // Payload changed or prior failed — delete and re-ingest (ledger uses idempotency keys).
            this.db.run('DELETE FROM "transaction" WHERE event_id = ?', prior.event_id);
            updated++;
          } else {
            inserted++;
          }
          toEvaluate.push(input);
        } catch {
          failed++;
        }
      }
      const results: IngestResult[] = [];
      if (opts.evaluate !== false) {
        for (const e of toEvaluate) results.push(this.ingest(e, actor));
      }
      const evalFailed = results.filter((r) => r.status === 'FAILED').length;
      failed += evalFailed;
      this.db.run(
        `UPDATE dwh_batch SET inserted = ?, updated = ?, skipped = ?, failed = ?, status = 'COMPLETED', finished_at = ? WHERE batch_id = ?`,
        inserted, updated, skipped, failed, this.now(), batchId,
      );
      audit(this.db, this.clock, actor, 'DWH_SYNC', 'dwh_batch', batchId, { businessDate, inserted, updated, skipped, failed, evaluated: results.length });
      let nudges: { customerId: string; message: string }[] = [];
      if (opts.performanceNudges !== false) nudges = this.generatePerformanceNudges(actor, businessDate);
      return { batchId, businessDate, inserted, updated, skipped, failed, evaluated: results.length, points: results.reduce((s, r) => s + r.points, 0), performanceNudges: nudges.length };
    } catch (e) {
      this.db.run(`UPDATE dwh_batch SET status = 'FAILED', failed = ?, finished_at = ?, error_text = ? WHERE batch_id = ?`, failed, this.now(), (e as Error).message, batchId);
      throw e;
    }
  }

  /** Pre-authorisation check for a proposed transaction. Nothing is posted; the decision is logged. */
  check(input: EventInput & { requestId?: string }) {
    const t0 = performance.now();
    const acct = this.resolveAccount(input.accountId, input.customerId);
    const { event } = this.toEvent({ ...input, sourceSystem: 'CHECK', sourceEventId: input.requestId ?? uid() }, acct.customer_id, acct.account_id);
    const { engine, releaseId } = this.catalog.engine();
    const ctx = this.part.contextFor(acct.customer_id, { accountId: acct.account_id, asOf: event.timestamp });
    const res = engine.check(event, ctx, this.store());
    const reasons = res.evaluations.filter((e) => e.family === 'SPEND_CONTROL' && e.decision && e.decision !== 'ALLOW').map((e) => ({ rule: e.ruleCode, decision: e.decision, message: e.message }));
    const latency = performance.now() - t0;
    const amount = typeof event.amount === 'number' ? Math.round(event.amount * 100) : null;
    const id = uid();
    this.db.run(
      'INSERT INTO control_decision(decision_id, request_id, customer_id, account_id, event_type, amount_minor, payload_json, decision, reasons_json, pack_hash, decided_at, latency_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, input.requestId ?? null, acct.customer_id, acct.account_id, event.type, amount, JSON.stringify(event), res.decision, JSON.stringify(reasons), releaseId, this.now(), Math.round(latency * 100) / 100,
    );
    return { decisionId: id, decision: res.decision, reasons, evaluations: res.evaluations.filter((e) => e.family === 'SPEND_CONTROL' && !SKIP_PERSIST.has(e.outcome)), latencyMs: latency };
  }

  /** Closes windows that ended before `asOf` (default: today in the pack timezone). */
  closeWindows(actor: Actor, asOf?: string) {
    const { engine, releaseId } = this.catalog.engine();
    const date = asOf ?? localParts(this.now(), engine.pack.timezone).date;
    return this.db.tx(() => {
      const res = engine.close(date, this.store(), (cid) => this.part.contextFor(cid));
      this.persist(res, releaseId, actor, { tz: engine.pack.timezone });
      audit(this.db, this.clock, actor, 'WINDOWS_CLOSE', 'rule_state', date, { closed: res.evaluations.length, points: res.points });
      return { asOf: date, closed: res.evaluations.length, points: res.points, evaluations: res.evaluations };
    });
  }

  /**
   * Nudge customers based on overall points performance across accounts
   * (not a single rule). One message per customer per asOf day.
   */
  generatePerformanceNudges(actor: Actor, asOf?: string) {
    const { engine } = this.catalog.engine();
    const day = asOf ?? localParts(this.now(), engine.pack.timezone).date;
    const since = day.slice(0, 8) + '01'; // month-to-date
    const rows = this.db.all<{ customer_id: string; display_name: string; pts: number; accounts: number }>(
      `SELECT c.customer_id, c.display_name, COALESCE(SUM(l.points),0) AS pts, COUNT(DISTINCT l.account_id) AS accounts
       FROM customer c
       LEFT JOIN points_ledger l ON l.customer_id = c.customer_id AND l.earned_on >= ? AND l.earned_on <= ? AND l.points > 0
       WHERE c.status = 'ACTIVE'
       GROUP BY c.customer_id`,
      since, day,
    );
    const out: { customerId: string; message: string }[] = [];
    const now = this.now();
    for (const r of rows) {
      let message: string;
      if (r.pts <= 0) message = `${r.display_name.split(' ')[0]}, you have not earned Money XP points yet this month. Pick a mission or set a spend control to start.`;
      else if (r.pts < 100) message = `Good start — ${r.pts} points this month across ${r.accounts} account(s). Keep going to unlock more rewards.`;
      else if (r.pts < 500) message = `Nice progress — ${r.pts} points this month. You are building strong money habits.`;
      else message = `Excellent — ${r.pts} points this month across ${r.accounts} account(s). You are among our top performers.`;
      const dedupe = `PERFORMANCE|${r.customer_id}|${day}`;
      const ins = this.db.run(
        "INSERT INTO nudge(nudge_id, customer_id, account_id, rule_code, kind, message, dedupe_key, status, created_at) VALUES (?,?,NULL,NULL,'PERFORMANCE',?,?,'PENDING',?) ON CONFLICT(dedupe_key) DO NOTHING",
        uid(), r.customer_id, message, dedupe, now,
      );
      if (ins.changes) out.push({ customerId: r.customer_id, message });
    }
    if (out.length) audit(this.db, this.clock, actor, 'PERFORMANCE_NUDGES', 'nudge', day, { count: out.length });
    return out;
  }

  private persist(res: ProcessResult, releaseId: string | null, actor: Actor, src: { eventId?: string; accountId?: string | null; occurredAt?: string; tz: string }) {
    const now = this.now();
    const eventId = src.eventId;
    const eventDay = src.occurredAt ? localParts(src.occurredAt, src.tz).date : null;
    const earnedOn = (f: { ruleCode: string; subjectKey: string; windowKey: string }) =>
      eventDay
      ?? this.db.value<string>("SELECT window_end FROM rule_state WHERE prefix = 'w|' AND rule_code = ? AND customer_id = ? AND window_key = ?", f.ruleCode, f.subjectKey.split(/[/#]/)[0], f.windowKey)
      ?? localParts(now, src.tz).date;
    for (const e of res.evaluations) {
      if (SKIP_PERSIST.has(e.outcome)) continue;
      const accountId = src.accountId ?? (e as Evaluation & { accountId?: string }).accountId ?? null;
      this.db.run(
        `INSERT INTO rule_evaluation(evaluation_id, event_id, trigger_kind, rule_code, rule_version_no, family, customer_id, account_id, subject_key, setting_id, window_key, outcome, decision,
          measure_before, measure_after, target_value, points, message, trace_json, pack_hash, evaluated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        uid(), e.eventId ?? eventId ?? null, e.trigger, e.ruleCode, e.ruleVersion, e.family, e.customerId, accountId, e.subjectKey, e.settingId ?? null, e.windowKey ?? null, e.outcome, e.decision ?? null,
        e.before ?? null, e.after ?? null, e.target ?? null, e.points, e.message, e.trace || e.issues ? JSON.stringify({ ...e.trace, issues: e.issues }) : null, releaseId, now,
      );
    }
    for (const f of res.effects) {
      const accountId = f.accountId ?? src.accountId ?? this.primaryAccount(f.customerId);
      if (f.type === 'AWARD' || f.type === 'CLAWBACK') {
        if (!accountId) throw new MxpError('NO_ACCOUNT', `Cannot post points for ${f.customerId} without an account.`, 422);
        const r = this.db.run(
          `INSERT INTO points_ledger(account_id, customer_id, entry_type, points, family, rule_code, rule_version_no, window_key, slot, event_id, idempotency_key, reason, earned_on, created_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`,
          accountId, f.customerId, f.type, f.points, f.family, f.ruleCode, f.ruleVersion, f.windowKey, f.slot, f.eventId ?? eventId ?? null, f.idempotencyKey, f.reason, earnedOn(f), actor.username, now,
        );
        if (r.changes) this.post(accountId, f.customerId, f.points, now);
      } else if (f.type === 'NUDGE') {
        this.db.run(
          "INSERT INTO nudge(nudge_id, customer_id, account_id, rule_code, kind, message, dedupe_key, status, created_at) VALUES (?,?,?,?,?,?,?,'PENDING',?) ON CONFLICT(dedupe_key) DO NOTHING",
          uid(), f.customerId, accountId, f.ruleCode, f.kind, f.message, f.dedupeKey, now,
        );
      }
    }
  }

  private primaryAccount(customerId: string): string | null {
    return (
      this.db.value<string>(
        `SELECT account_id FROM account WHERE customer_id = ? AND status = 'ACTIVE'
         ORDER BY CASE product_family WHEN 'SAVINGS' THEN 0 WHEN 'CURRENT' THEN 1 ELSE 2 END, opened_on LIMIT 1`,
        customerId,
      ) ?? null
    );
  }

  private post(accountId: string, customerId: string, points: number, now: string) {
    this.db.run(
      `INSERT INTO points_account(account_id, customer_id, balance, lifetime_earned, lifetime_clawed, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET balance = balance + excluded.balance, lifetime_earned = lifetime_earned + excluded.lifetime_earned,
        lifetime_clawed = lifetime_clawed + excluded.lifetime_clawed, updated_at = excluded.updated_at`,
      accountId, customerId, points, points > 0 ? points : 0, points < 0 ? -points : 0, now,
    );
  }

  /** Manual points correction at account level (OPERATIONS). */
  adjust(accountId: string, points: number, reason: string, actor: Actor) {
    const acct = this.resolveAccount(accountId);
    if (!Number.isInteger(points) || points === 0) throw new MxpError('INVALID_POINTS', 'Points must be a non-zero integer.', 422);
    if (!reason || reason.trim().length < 5) throw new MxpError('REASON_REQUIRED', 'Give a reason (at least 5 characters).', 422);
    const now = this.now();
    this.db.tx(() => {
      const today = localParts(now, this.catalog.engine().engine.pack.timezone).date;
      this.db.run(
        `INSERT INTO points_ledger(account_id, customer_id, entry_type, points, idempotency_key, reason, earned_on, created_by, created_at) VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?)`,
        acct.account_id, acct.customer_id, points, `ADJ|${uid()}`, reason.trim(), today, actor.username, now,
      );
      this.post(acct.account_id, acct.customer_id, points, now);
      audit(this.db, this.clock, actor, 'POINTS_ADJUST', 'account', acct.account_id, { points, reason, customerId: acct.customer_id });
    });
  }

  /** Re-derives points_account from the ledger and reports differences. */
  reconcile() {
    return this.db.all<any>(
      `SELECT a.account_id, a.customer_id, a.balance, COALESCE(SUM(l.points),0) AS ledger
       FROM points_account a LEFT JOIN points_ledger l ON l.account_id = a.account_id
       GROUP BY a.account_id HAVING a.balance <> COALESCE(SUM(l.points),0)`,
    );
  }
}

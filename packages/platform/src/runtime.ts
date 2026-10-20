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
  customerId: string;
  accountId?: string | null;
  timestamp: string;
  /** sourceEventId of the event being reversed (same source system). */
  reversalOf?: string | null;
  [attr: string]: unknown;
}

const SKIP_PERSIST = new Set(['OUT_OF_SCOPE', 'NOT_EFFECTIVE']);
const RESERVED = new Set(['sourceSystem', 'sourceEventId', 'type', 'customerId', 'accountId', 'timestamp', 'reversalOf', 'id']);

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

  private toEvent(input: EventInput, customerId: string): { event: MxpEvent; source: string; sourceId: string } {
    if (!input.type) throw new MxpError('INVALID_EVENT', 'type is required.', 422);
    if (!input.timestamp || Number.isNaN(new Date(input.timestamp).getTime())) throw new MxpError('INVALID_EVENT', 'timestamp must be an ISO-8601 instant.', 422);
    const source = input.sourceSystem || 'API';
    const sourceId = input.sourceEventId || uid();
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (!RESERVED.has(k)) attrs[k] = v;
    const event: MxpEvent = {
      ...attrs,
      id: `${source}:${sourceId}`,
      type: input.type,
      customerId,
      accountId: input.accountId ?? null,
      timestamp: new Date(input.timestamp).toISOString(),
      reversalOf: input.reversalOf ? `${source}:${input.reversalOf}` : null,
    };
    return { event, source, sourceId };
  }

  /** Ingests a business event: stores it in the inbox, runs every live rule, persists the effects. Idempotent per source id. */
  ingest(input: EventInput, actor: Actor): IngestResult {
    const c = this.part.customerRow(input.customerId);
    const { event, source, sourceId } = this.toEvent(input, c.customer_id);
    const prior = this.db.get<any>('SELECT event_id, status, payload_hash FROM "transaction" WHERE source_system = ? AND source_event_id = ?', source, sourceId);
    if (prior?.status === 'FAILED') this.db.run('DELETE FROM "transaction" WHERE event_id = ?', prior.event_id); // retry
    else if (prior) {
      if (prior.payload_hash !== hashJson(event)) throw new MxpError('EVENT_CONFLICT', `Event ${source}:${sourceId} was already received with different content.`, 409);
      return { eventId: prior.event_id, duplicate: true, status: prior.status, decision: 'ALLOW', points: 0, evaluations: [], effects: [] };
    }
    if (event.reversalOf && !this.db.get('SELECT 1 FROM "transaction" WHERE event_id = ?', event.reversalOf)) throw new MxpError('UNKNOWN_REVERSAL', `reversalOf ${input.reversalOf} is not a known event from ${source}.`, 422);
    const { engine, releaseId } = this.catalog.engine();
    try {
      return this.db.tx(() => {
        this.db.run(`INSERT INTO "transaction"(event_id, source_system, source_event_id, event_type, customer_id, account_id, occurred_at, reversal_of, payload_json, payload_hash, received_at, status, pack_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'RECEIVED',?)`, event.id, source, sourceId, event.type, c.customer_id, event.accountId ?? null, event.timestamp, event.reversalOf ?? null, JSON.stringify(event), hashJson(event), this.now(), releaseId);
        const ctx = this.part.contextFor(c.customer_id, { accountId: event.accountId, asOf: event.timestamp });
        const res = engine.process(event, ctx, this.store());
        this.persist(res, releaseId, actor, { eventId: event.id, occurredAt: event.timestamp, tz: String(ctx.customer.timezone ?? engine.pack.timezone) });
        this.db.run(`UPDATE "transaction" SET status = 'PROCESSED', processed_at = ? WHERE event_id = ?`, this.now(), event.id);
        return { eventId: event.id, duplicate: false, status: 'PROCESSED' as const, decision: res.decision, points: res.points, evaluations: res.evaluations, effects: res.effects };
      });
    } catch (e) {
      if (e instanceof MxpError) throw e;
      const msg = (e as Error).message;
      this.db.run(`INSERT INTO "transaction"(event_id, source_system, source_event_id, event_type, customer_id, account_id, occurred_at, reversal_of, payload_json, payload_hash, received_at, status, error_text, pack_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'FAILED',?,?)`, event.id, source, sourceId, event.type, c.customer_id, event.accountId ?? null, event.timestamp, event.reversalOf ?? null, JSON.stringify(event), hashJson(event), this.now(), msg, releaseId);
      return { eventId: event.id, duplicate: false, status: 'FAILED', decision: 'ALLOW', points: 0, evaluations: [], effects: [], error: msg };
    }
  }

  /** Pre-authorisation check for a proposed transaction. Nothing is posted; the decision is logged. */
  check(input: EventInput & { requestId?: string }) {
    const t0 = performance.now();
    const c = this.part.customerRow(input.customerId);
    const { event } = this.toEvent({ ...input, sourceSystem: 'CHECK', sourceEventId: input.requestId ?? uid() }, c.customer_id);
    const { engine, releaseId } = this.catalog.engine();
    const ctx = this.part.contextFor(c.customer_id, { accountId: event.accountId, asOf: event.timestamp });
    const res = engine.check(event, ctx, this.store());
    const reasons = res.evaluations.filter((e) => e.family === 'SPEND_CONTROL' && e.decision && e.decision !== 'ALLOW').map((e) => ({ rule: e.ruleCode, decision: e.decision, message: e.message }));
    const latency = performance.now() - t0;
    const amount = typeof event.amount === 'number' ? Math.round(event.amount * 100) : null;
    const id = uid();
    this.db.run('INSERT INTO control_decision(decision_id, request_id, customer_id, event_type, amount_minor, payload_json, decision, reasons_json, pack_hash, decided_at, latency_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, input.requestId ?? null, c.customer_id, event.type, amount, JSON.stringify(event), res.decision, JSON.stringify(reasons), releaseId, this.now(), Math.round(latency * 100) / 100);
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
   * Writes evaluations and effects. Points carry a business date (earned_on): the event's local
   * date, or the window end for rewards paid when a window closes, so reporting by day is right
   * even when events arrive late or windows are closed in a batch.
   */
  private persist(res: ProcessResult, releaseId: string | null, actor: Actor, src: { eventId?: string; occurredAt?: string; tz: string }) {
    const now = this.now();
    const eventId = src.eventId;
    const eventDay = src.occurredAt ? localParts(src.occurredAt, src.tz).date : null;
    const earnedOn = (f: { ruleCode: string; subjectKey: string; windowKey: string }) => eventDay
      ?? this.db.value<string>("SELECT window_end FROM rule_state WHERE prefix = 'w|' AND rule_code = ? AND customer_id = ? AND window_key = ?", f.ruleCode, f.subjectKey.split(/[/#]/)[0], f.windowKey)
      ?? localParts(now, src.tz).date;
    const evalIds = new Map<string, string>();
    for (const e of res.evaluations) {
      if (SKIP_PERSIST.has(e.outcome)) continue;
      const id = uid();
      evalIds.set(`${e.ruleCode}|${e.subjectKey}`, id);
      this.db.run(`INSERT INTO rule_evaluation(evaluation_id, event_id, trigger_kind, rule_code, rule_version_no, family, customer_id, subject_key, setting_id, window_key, outcome, decision,
          measure_before, measure_after, target_value, points, message, trace_json, pack_hash, evaluated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, e.eventId ?? eventId ?? null, e.trigger, e.ruleCode, e.ruleVersion, e.family, e.customerId, e.subjectKey, e.settingId ?? null, e.windowKey ?? null, e.outcome, e.decision ?? null,
        e.before ?? null, e.after ?? null, e.target ?? null, e.points, e.message, e.trace || e.issues ? JSON.stringify({ ...e.trace, issues: e.issues }) : null, releaseId, now);
    }
    for (const f of res.effects) {
      if (f.type === 'AWARD' || f.type === 'CLAWBACK') {
        const r = this.db.run(`INSERT INTO points_ledger(customer_id, entry_type, points, family, rule_code, rule_version_no, window_key, slot, event_id, idempotency_key, reason, earned_on, created_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING`,
          f.customerId, f.type, f.points, f.family, f.ruleCode, f.ruleVersion, f.windowKey, f.slot, f.eventId ?? eventId ?? null, f.idempotencyKey, f.reason, earnedOn(f), actor.username, now);
        if (r.changes) this.post(f.customerId, f.points, now);
      } else if (f.type === 'BREACH') {
        this.db.run('INSERT INTO spend_control_breach(breach_id, evaluation_id, customer_id, rule_code, setting_id, window_key, event_id, limit_value, measured_value, action, occurred_at, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          uid(), evalIds.get(`${f.ruleCode}|${f.subjectKey}`) ?? null, f.customerId, f.ruleCode, f.settingId, f.windowKey, f.eventId ?? eventId ?? null, f.limit, f.value, f.action, src.occurredAt ?? now, now);
      } else if (f.type === 'NUDGE') {
        this.db.run("INSERT INTO nudge(nudge_id, customer_id, rule_code, kind, message, dedupe_key, status, created_at) VALUES (?,?,?,?,?,?,'PENDING',?) ON CONFLICT(dedupe_key) DO NOTHING",
          uid(), f.customerId, f.ruleCode, f.kind, f.message, f.dedupeKey, now);
      }
    }
  }

  private post(customerId: string, points: number, now: string) {
    this.db.run(`INSERT INTO points_account(customer_id, balance, lifetime_earned, lifetime_clawed, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET balance = balance + excluded.balance, lifetime_earned = lifetime_earned + excluded.lifetime_earned,
        lifetime_clawed = lifetime_clawed + excluded.lifetime_clawed, updated_at = excluded.updated_at`,
      customerId, points, points > 0 ? points : 0, points < 0 ? -points : 0, now);
  }

  /** Manual points correction (OPERATIONS). */
  adjust(customerId: string, points: number, reason: string, actor: Actor) {
    const c = this.part.customerRow(customerId);
    if (!Number.isInteger(points) || points === 0) throw new MxpError('INVALID_POINTS', 'Points must be a non-zero integer.', 422);
    if (!reason || reason.trim().length < 5) throw new MxpError('REASON_REQUIRED', 'Give a reason (at least 5 characters).', 422);
    const now = this.now();
    this.db.tx(() => {
      const today = localParts(now, this.catalog.engine().engine.pack.timezone).date;
      this.db.run(`INSERT INTO points_ledger(customer_id, entry_type, points, idempotency_key, reason, earned_on, created_by, created_at) VALUES (?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?)`, c.customer_id, points, `ADJ|${uid()}`, reason.trim(), today, actor.username, now);
      this.post(c.customer_id, points, now);
      audit(this.db, this.clock, actor, 'POINTS_ADJUST', 'customer', c.customer_id, { points, reason });
    });
  }

  /** Re-derives points_account from the ledger and reports differences. */
  reconcile() {
    return this.db.all<any>(`SELECT a.customer_id, a.balance, COALESCE(SUM(l.points),0) AS ledger FROM points_account a LEFT JOIN points_ledger l ON l.customer_id = a.customer_id
      GROUP BY a.customer_id HAVING a.balance <> COALESCE(SUM(l.points),0)`);
  }
}

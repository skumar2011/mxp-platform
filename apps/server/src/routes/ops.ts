import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MxpError, audit, closeBatch, openBatch, reconcileAgainstSource, replayEvent, runReconciliation } from '@mxp/engine';
import type { AppCtx } from '../context';
import { actorOf, need, page, parse, where } from '../util';

export function opsRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db, engine, clock } = ctx;
  const ec = engine.ctx;

  // ---------- ingestion ----------
  /**
   * Accepts canonical events from a source system. Authenticated either by an API key bound to a source system
   * (machine-to-machine) or by a signed-in operator. MXP only records the events; it never posts or alters a financial transaction.
   */
  app.post('/ingest', { config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (req, reply) => {
    const client = (req as any).apiClient as { clientId: string; sourceSystem: string } | undefined;
    if (!client) need(req, 'ops:write');
    const body = parse(z.object({ events: z.array(z.unknown()).min(1).max(1000), batchId: z.string().optional(), processNow: z.boolean().optional() }), req.body);
    let events = body.events;
    const results: any[] = [];
    if (client) {
      const ok: unknown[] = [];
      for (const e of events) {
        if ((e as any)?.sourceSystem !== client.sourceSystem) {
          results.push({ sourceEventId: (e as any)?.sourceEventId ?? null, status: 'REJECTED', errors: [{ code: 'SOURCE_MISMATCH', message: `This API key may only submit events for ${client.sourceSystem}.` }] });
        } else ok.push(e);
      }
      events = ok;
    }
    const ingested = events.length ? engine.ingest(events, { batchId: body.batchId }) : [];
    results.push(...ingested);
    const inline = body.processNow ?? !ctx.cfg.worker;
    const work = inline ? engine.drain() : undefined;
    const summary = {
      received: body.events.length,
      accepted: results.filter((r) => r.status === 'ACCEPTED').length,
      duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
      rejected: results.filter((r) => r.status === 'REJECTED').length,
      suspended: results.filter((r) => r.status === 'SUSPENDED').length,
    };
    return reply.code(summary.rejected && !summary.accepted && !summary.duplicates ? 422 : 202).send({ summary, results, work });
  });

  app.post('/ingest/batches', async (req, reply) => {
    need(req, 'ops:write');
    const b = parse(z.object({ sourceSystem: z.string().min(1).max(32), channel: z.string().optional(), fileName: z.string().max(200).optional(), controlCount: z.number().int().nonnegative().optional(), controlAmount: z.union([z.number(), z.string()]).optional() }), req.body);
    const id = openBatch(ec, { ...b, mode: 'BATCH' });
    return reply.code(201).send({ batchId: id });
  });
  app.post('/ingest/batches/:id/close', async (req) => {
    need(req, 'ops:write');
    return closeBatch(ec, (req.params as any).id);
  });
  app.get('/ingest/batches', async (req) => {
    need(req, 'ops:read');
    return { rows: db.all('SELECT * FROM ingestion_batch ORDER BY created_at DESC LIMIT 100') };
  });

  app.get('/events', async (req) => {
    need(req, 'ops:read');
    const q = req.query as any;
    const { limit, offset } = page(q);
    const w = where([
      [q.status, 'e.processing_status = ?'],
      [q.source, 'e.source_system = ?'],
      [q.type, 'e.event_type = ?'],
      [q.q, 'e.source_event_id LIKE ?', `%${String(q.q ?? '').slice(0, 60)}%`],
    ]);
    const total = db.value<number>(`SELECT COUNT(*) FROM ingestion_event e ${w.sql}`, ...w.params) ?? 0;
    const rows = db.all(
      `SELECT e.event_id AS eventId, e.source_system AS sourceSystem, e.source_event_id AS sourceEventId, e.event_type AS eventType, e.processing_status AS status,
              e.attempts, e.delivery_count AS deliveries, e.received_at AS receivedAt, e.processed_at AS processedAt, e.error_code AS errorCode, e.last_error AS lastError, e.next_attempt_at AS nextAttemptAt
         FROM ingestion_event e ${w.sql} ORDER BY e.received_at DESC, e.rowid DESC LIMIT ? OFFSET ?`, ...w.params, limit, offset);
    return { total, rows };
  });

  app.get('/events/:id', async (req) => {
    need(req, 'ops:read');
    const { id } = req.params as any;
    const e = db.get<any>('SELECT * FROM ingestion_event WHERE event_id = ?', id);
    if (!e) throw new MxpError('NOT_FOUND', 'Event not found.', 404);
    const { payload_json, ...rest } = e;
    return { ...rest, payload: JSON.parse(payload_json), history: db.all('SELECT stage, outcome, detail, at FROM ingestion_event_history WHERE event_id = ? ORDER BY rowid', id) };
  });

  app.post('/events/:id/replay', async (req) => {
    const actor = need(req, 'ops:write');
    return replayEvent(ec, actor, (req.params as any).id);
  });

  // ---------- operations ----------
  app.post('/ops/process', async (req) => {
    need(req, 'ops:write');
    return engine.drain();
  });

  app.post('/ops/close-periods', async (req) => {
    const actor = need(req, 'ops:write');
    const r = engine.closePeriods();
    audit(db, clock, actor, 'PERIOD_CLOSE_RUN', 'system', 'period-close', null, r as any);
    return r;
  });

  app.post('/ops/nudges/dispatch', async (req) => {
    need(req, 'ops:write');
    return engine.dispatchNudges();
  });

  app.post('/ops/rules/:code/backfill', async (req) => {
    const actor = need(req, 'ops:write');
    const { code } = req.params as any;
    const r = engine.backfillRule(code);
    audit(db, clock, actor, 'RULE_BACKFILL', 'rule', code, null, r as any);
    return r;
  });

  app.post('/ops/reconcile', async (req) => {
    const actor = need(req, 'ops:write');
    const b = parse(z.object({ minutesStuck: z.number().int().min(1).max(1440).optional() }), req.body ?? {});
    return runReconciliation(ec, actor, b.minutesStuck);
  });

  app.get('/ops/reconciliation', async (req) => {
    need(req, 'ops:read');
    const runs = db.all('SELECT * FROM reconciliation_run ORDER BY started_at DESC LIMIT 30');
    const q = req.query as any;
    const runId = q.runId ?? (runs[0] as any)?.run_id;
    const breaks = runId ? db.all('SELECT * FROM reconciliation_break WHERE run_id = ? ORDER BY break_id LIMIT 500', runId) : [];
    return { runs, runId: runId ?? null, breaks };
  });

  app.post('/ops/reconcile-source', async (req) => {
    const actor = need(req, 'ops:write');
    const b = parse(
      z.object({
        sourceSystem: z.string().min(1).max(32),
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        entries: z.array(z.object({ sourceTxnId: z.string(), amount: z.union([z.number(), z.string()]), status: z.string().optional() })).max(50_000),
      }),
      req.body,
    );
    return reconcileAgainstSource(ec, actor, b.sourceSystem, b.entries, b.dateFrom, b.dateTo);
  });

  app.get('/ops/health', async (req) => {
    need(req, 'ops:read');
    const now = clock.now().toISOString();
    return {
      queueDepth: db.value<number>(`SELECT COUNT(*) FROM ingestion_event WHERE processing_status IN ('RECEIVED','NORMALIZED','PROCESSING')`) ?? 0,
      suspended: db.value<number>(`SELECT COUNT(*) FROM ingestion_event WHERE processing_status = 'SUSPENDED'`) ?? 0,
      deadLetters: db.value<number>(`SELECT COUNT(*) FROM ingestion_event WHERE processing_status = 'DEAD_LETTER'`) ?? 0,
      oldestPending: db.value<string>(`SELECT MIN(received_at) FROM ingestion_event WHERE processing_status IN ('RECEIVED','NORMALIZED','PROCESSING')`),
      txnAwaitingEvaluation: db.value<number>(`SELECT COUNT(*) FROM txn_master WHERE processing_status = 'PENDING_EVAL'`) ?? 0,
      nudgesPending: db.value<number>(`SELECT COUNT(*) FROM nudge WHERE status = 'ELIGIBLE'`) ?? 0,
      workerEnabled: ctx.cfg.worker,
      now,
    };
  });
}

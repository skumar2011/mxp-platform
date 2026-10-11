import type { Actor } from './audit';
import { audit } from './audit';
import type { EngineCtx } from './context';
import { processSnapshot, processTransaction, runPeriodClose } from './evaluator';
import { addHistory, normalizeEvent } from './ingest';
import { MxpError } from './util';

export interface WorkSummary {
  processed: number;
  failed: number;
  deadLettered: number;
  retriedSuspended: number;
}

/** Processes events waiting for evaluation, with retry and dead-letter handling. */
export function processPending(ctx: EngineCtx, limit = 200): WorkSummary {
  const { db, clock, config } = ctx;
  const summary: WorkSummary = { processed: 0, failed: 0, deadLettered: 0, retriedSuspended: 0 };
  const now = () => clock.now().toISOString();

  // 1. Suspended events whose retry time has come (missing reference data, original not yet arrived).
  const suspended = db.all<{ event_id: string }>(
    `SELECT event_id FROM ingestion_event WHERE processing_status = 'SUSPENDED' AND next_attempt_at <= ? ORDER BY received_at, rowid LIMIT ?`,
    now(), limit,
  );
  for (const s of suspended) {
    normalizeEvent(ctx, s.event_id);
    summary.retriedSuspended++;
  }
  // 2. Events that were stored but never normalised (crash between steps).
  for (const r of db.all<{ event_id: string }>(`SELECT event_id FROM ingestion_event WHERE processing_status = 'RECEIVED' ORDER BY received_at, rowid LIMIT ?`, limit)) {
    normalizeEvent(ctx, r.event_id);
  }
  // 3. Evaluate.
  const work = db.all<any>(
    `SELECT * FROM ingestion_event WHERE processing_status IN ('NORMALIZED','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY received_at, rowid LIMIT ?`,
    now(), limit,
  );
  for (const ev of work) {
    db.run(`UPDATE ingestion_event SET processing_status = 'PROCESSING' WHERE event_id = ?`, ev.event_id);
    try {
      db.tx(() => {
        if (ev.event_type === 'TRANSACTION' && ev.txn_id) processTransaction(ctx, ev.txn_id, ev.event_id, 'TXN');
        else if (ev.event_type === 'BALANCE_SNAPSHOT' && ev.snapshot_id) processSnapshot(ctx, ev.snapshot_id, ev.event_id);
        db.run(`UPDATE ingestion_event SET processing_status = 'PROCESSED', processed_at = ?, error_code = NULL, last_error = NULL WHERE event_id = ?`, now(), ev.event_id);
        addHistory(db, ev.event_id, 'EVALUATE', 'OK', null, now());
      });
      summary.processed++;
    } catch (e: any) {
      const attempts = ev.attempts + 1;
      const dead = attempts >= config.maxAttempts;
      const next = new Date(clock.now().getTime() + config.retryBaseSeconds * 1000 * 2 ** (attempts - 1)).toISOString();
      db.run(
        `UPDATE ingestion_event SET processing_status = ?, attempts = ?, error_code = ?, last_error = ?, next_attempt_at = ? WHERE event_id = ?`,
        dead ? 'DEAD_LETTER' : 'FAILED', attempts, e?.code ?? 'EVALUATION_ERROR', String(e?.message ?? e).slice(0, 1000), dead ? null : next, ev.event_id,
      );
      addHistory(db, ev.event_id, dead ? 'DEAD_LETTER' : 'RETRY', e?.code ?? 'EVALUATION_ERROR', String(e?.message ?? e).slice(0, 500), now());
      if (dead) summary.deadLettered++;
      else summary.failed++;
    }
  }
  return summary;
}

/** Runs the worker until the queue is empty (or the safety limit is reached). */
export function drain(ctx: EngineCtx, maxRounds = 50): WorkSummary {
  const total: WorkSummary = { processed: 0, failed: 0, deadLettered: 0, retriedSuspended: 0 };
  for (let i = 0; i < maxRounds; i++) {
    const r = processPending(ctx);
    total.processed += r.processed;
    total.failed += r.failed;
    total.deadLettered += r.deadLettered;
    total.retriedSuspended += r.retriedSuspended;
    if (r.processed === 0 && r.retriedSuspended === 0) break;
  }
  return total;
}

/** Re-submits a dead-lettered, failed or rejected event after the cause has been fixed. */
export function replayEvent(ctx: EngineCtx, actor: Actor, eventId: string) {
  const { db, clock } = ctx;
  const ev = db.get<any>('SELECT * FROM ingestion_event WHERE event_id = ?', eventId);
  if (!ev) throw new MxpError('NOT_FOUND', 'Event not found.', 404);
  if (!['DEAD_LETTER', 'FAILED', 'REJECTED', 'SUSPENDED'].includes(ev.processing_status)) {
    throw new MxpError('NOT_REPLAYABLE', `Event is ${ev.processing_status}; only failed, rejected, suspended or dead-lettered events can be replayed.`, 409);
  }
  db.tx(() => {
    db.run(`UPDATE ingestion_event SET processing_status = 'RECEIVED', attempts = 0, next_attempt_at = NULL, error_code = NULL, last_error = NULL WHERE event_id = ?`, eventId);
    addHistory(db, eventId, 'REPLAY', 'REQUESTED', `by ${actor.username}`, clock.now().toISOString());
    audit(db, clock, actor, 'EVENT_REPLAY', 'ingestion_event', eventId, { status: ev.processing_status }, { status: 'RECEIVED' });
  });
  const r = normalizeEvent(ctx, eventId);
  return { ...r, drained: drain(ctx) };
}

export { runPeriodClose };

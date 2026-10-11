import { z } from 'zod';
import type { Db } from './db';
import type { EngineCtx } from './context';
import { MxpError, canonicalJson, sha256, toMinor, uid } from './util';

// ---------------------------------------------------------------------
// Canonical event contract (versioned; see docs/05-api-contracts.md)
// ---------------------------------------------------------------------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const TxnPayloadSchema = z.object({
  sourceTxnId: z.string().min(1).max(128),
  customerRef: z.string().min(1).max(64),
  accountRef: z.string().min(1).max(64).optional(),
  instrumentRef: z.string().min(1).max(64).optional(),
  productCode: z.string().max(32).optional(),
  txnType: z.string().min(1).max(32),
  categoryCode: z.string().max(32).optional(),
  channel: z.string().min(1).max(32),
  amount: z.union([z.number(), z.string()]),
  currency: z.string().length(3).default('INR'),
  drCr: z.enum(['D', 'C']),
  txnTimestamp: z.string().min(10),
  postingDate: isoDate.optional(),
  status: z.enum(['PENDING', 'POSTED', 'REVERSED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'FAILED']),
  refundedAmount: z.union([z.number(), z.string()]).optional(),
  merchantId: z.string().max(64).optional(),
  merchantName: z.string().max(256).optional(),
  mcc: z.string().regex(/^\d{4}$/, 'MCC must be 4 digits').optional(),
  originalSourceTxnId: z.string().max(128).optional(),
  reversalIndicator: z.boolean().optional(),
  referenceNo: z.string().max(64).optional(),
  attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type TxnPayload = z.infer<typeof TxnPayloadSchema>;

export const SnapshotPayloadSchema = z.object({
  accountRef: z.string().min(1).max(64),
  asOfDate: isoDate,
  closingBalance: z.union([z.number(), z.string()]),
  currency: z.string().length(3).default('INR'),
});
export type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

export const EnvelopeSchema = z.object({
  eventType: z.enum(['TRANSACTION', 'BALANCE_SNAPSHOT']),
  sourceSystem: z.string().min(1).max(32),
  sourceEventId: z.string().min(1).max(160),
  eventTime: z.string().optional(),
  transaction: z.unknown().optional(),
  snapshot: z.unknown().optional(),
});

export interface ErrorItem {
  code: string;
  message: string;
  path?: string;
}

export interface IngestResult {
  sourceEventId: string | null;
  eventId?: string;
  status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'SUSPENDED';
  processingStatus?: string;
  txnId?: string;
  errors?: ErrorItem[];
}

export interface IngestOptions {
  batchId?: string;
}

const STATUS_RANK: Record<string, number> = { PENDING: 1, POSTED: 2, PARTIALLY_REFUNDED: 3, REFUNDED: 4, REVERSED: 4, FAILED: 4 };
const REVERSING_TYPES = new Set(['REVERSAL', 'REFUND']);

function zodErrors(e: z.ZodError): ErrorItem[] {
  return e.issues.map((i) => ({ code: 'INVALID_FIELD', path: i.path.join('.'), message: i.message }));
}

export function addHistory(db: Db, eventId: string, stage: string, outcome: string, detail: string | null, at: string) {
  db.run('INSERT INTO ingestion_event_history(event_id, stage, outcome, detail, at) VALUES (?,?,?,?,?)', eventId, stage, outcome, detail, at);
}

// ---------------------------------------------------------------------
// Batches (for sources that deliver files rather than streams)
// ---------------------------------------------------------------------
export interface BatchInput {
  sourceSystem: string;
  channel?: string;
  mode?: 'STREAM' | 'BATCH';
  fileName?: string;
  controlCount?: number;
  controlAmount?: number | string;
}

export function openBatch(ctx: EngineCtx, i: BatchInput): string {
  const id = uid();
  ctx.db.run(
    `INSERT INTO ingestion_batch(batch_id, source_system, channel_code, mode, file_name, control_count, control_amount_minor, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, i.sourceSystem, i.channel ?? null, i.mode ?? 'BATCH', i.fileName ?? null, i.controlCount ?? null,
    i.controlAmount === undefined ? null : toMinor(i.controlAmount), 'OPEN', ctx.clock.now().toISOString(),
  );
  return id;
}

export function closeBatch(ctx: EngineCtx, batchId: string) {
  const { db, clock } = ctx;
  const b = db.get<any>('SELECT * FROM ingestion_batch WHERE batch_id = ?', batchId);
  if (!b) throw new MxpError('NOT_FOUND', 'Batch not found.', 404);
  const accepted = b.accepted_count + b.duplicate_count;
  let status: 'RECONCILED' | 'MISMATCH' = 'RECONCILED';
  if (b.control_count !== null && b.control_count !== accepted + b.rejected_count) status = 'MISMATCH';
  if (b.control_amount_minor !== null && b.control_amount_minor !== b.accepted_amount_minor) status = 'MISMATCH';
  db.run('UPDATE ingestion_batch SET status = ?, closed_at = ? WHERE batch_id = ?', status, clock.now().toISOString(), batchId);
  return db.get<any>('SELECT * FROM ingestion_batch WHERE batch_id = ?', batchId);
}

// ---------------------------------------------------------------------
// Ingest: validate, deduplicate, persist raw, normalise into the master
// ---------------------------------------------------------------------
export function ingestEvents(ctx: EngineCtx, events: unknown[], opts: IngestOptions = {}): IngestResult[] {
  const results = events.map((e) => ingestOne(ctx, e, opts));
  if (opts.batchId) {
    const { db } = ctx;
    const count = (s: IngestResult['status']) => results.filter((r) => r.status === s).length;
    const amount = results.reduce((a, r) => a + (r.status === 'ACCEPTED' ? acceptedAmount(db, r) : 0), 0);
    db.run(
      `UPDATE ingestion_batch SET received_count = received_count + ?, accepted_count = accepted_count + ?, rejected_count = rejected_count + ?,
         duplicate_count = duplicate_count + ?, accepted_amount_minor = accepted_amount_minor + ? WHERE batch_id = ?`,
      results.length, count('ACCEPTED') + count('SUSPENDED'), count('REJECTED'), count('DUPLICATE'), amount, opts.batchId,
    );
  }
  return results;
}

function acceptedAmount(db: Db, r: IngestResult): number {
  if (!r.eventId) return 0;
  const row = db.get<{ payload_json: string; event_type: string }>('SELECT payload_json, event_type FROM ingestion_event WHERE event_id = ?', r.eventId);
  if (!row || row.event_type !== 'TRANSACTION') return 0;
  try {
    const p = JSON.parse(row.payload_json).transaction;
    return toMinor(p.amount);
  } catch {
    return 0;
  }
}

function ingestOne(ctx: EngineCtx, raw: unknown, opts: IngestOptions): IngestResult {
  const { db, clock } = ctx;
  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success) {
    return { sourceEventId: (raw as any)?.sourceEventId ?? null, status: 'REJECTED', errors: zodErrors(env.error) };
  }
  const e = env.data;
  const now = clock.now().toISOString();
  const hash = sha256(canonicalJson(raw));
  const existing = db.get<any>(
    'SELECT * FROM ingestion_event WHERE source_system = ? AND source_event_id = ?',
    e.sourceSystem, e.sourceEventId,
  );

  if (existing) {
    const retriable = ['REJECTED', 'SUSPENDED', 'FAILED', 'DEAD_LETTER'].includes(existing.processing_status);
    if (existing.payload_hash === hash || (!retriable && existing.payload_hash !== hash)) {
      db.run('UPDATE ingestion_event SET delivery_count = delivery_count + 1, last_delivered_at = ? WHERE event_id = ?', now, existing.event_id);
      if (existing.payload_hash !== hash) {
        addHistory(db, existing.event_id, 'INGEST', 'CONFLICTING_DUPLICATE', 'Same source event id redelivered with different content; original kept.', now);
        return {
          sourceEventId: e.sourceEventId, eventId: existing.event_id, status: 'REJECTED',
          errors: [{ code: 'CONFLICTING_DUPLICATE', message: 'This source event id was already processed with different content.' }],
        };
      }
      addHistory(db, existing.event_id, 'INGEST', 'DUPLICATE', 'Redelivery ignored', now);
      return { sourceEventId: e.sourceEventId, eventId: existing.event_id, status: 'DUPLICATE', processingStatus: existing.processing_status, txnId: existing.txn_id ?? undefined };
    }
    // A corrected resubmission of a rejected / failed event: reprocess in place.
    db.run(
      `UPDATE ingestion_event SET payload_json = ?, payload_hash = ?, processing_status = 'RECEIVED', attempts = 0, next_attempt_at = NULL,
         error_code = NULL, last_error = NULL, delivery_count = delivery_count + 1, last_delivered_at = ? WHERE event_id = ?`,
      canonicalJson(raw), hash, now, existing.event_id,
    );
    addHistory(db, existing.event_id, 'INGEST', 'RESUBMITTED', 'Corrected payload received', now);
    return normalizeEvent(ctx, existing.event_id);
  }

  const eventId = uid();
  db.run(
    `INSERT INTO ingestion_event(event_id, batch_id, source_system, source_event_id, event_type, payload_json, payload_hash, received_at,
       last_delivered_at, processing_status, correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    eventId, opts.batchId ?? null, e.sourceSystem, e.sourceEventId, e.eventType, canonicalJson(raw), hash, now, now, 'RECEIVED',
    ctx.correlationId ?? uid(),
  );
  addHistory(db, eventId, 'INGEST', 'RECEIVED', null, now);
  return normalizeEvent(ctx, eventId);
}

// ---------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------
class Reject extends Error {
  constructor(readonly errors: ErrorItem[]) {
    super(errors[0]?.message);
  }
}
class Suspend extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function normalizeEvent(ctx: EngineCtx, eventId: string): IngestResult {
  const { db, clock } = ctx;
  const ev = db.get<any>('SELECT * FROM ingestion_event WHERE event_id = ?', eventId)!;
  const now = clock.now().toISOString();
  const raw = JSON.parse(ev.payload_json);
  try {
    const txnId = db.tx(() => {
      if (ev.event_type === 'TRANSACTION') return normalizeTransaction(ctx, ev, raw);
      normalizeSnapshot(ctx, ev, raw);
      return undefined;
    });
    db.run(`UPDATE ingestion_event SET processing_status = 'NORMALIZED', error_code = NULL, last_error = NULL WHERE event_id = ? AND processing_status <> 'PROCESSED'`, eventId);
    addHistory(db, eventId, 'NORMALIZE', 'OK', null, now);
    const cur = db.get<any>('SELECT processing_status, txn_id FROM ingestion_event WHERE event_id = ?', eventId)!;
    return { sourceEventId: ev.source_event_id, eventId, status: 'ACCEPTED', processingStatus: cur.processing_status, txnId: txnId ?? cur.txn_id ?? undefined };
  } catch (err) {
    if (err instanceof Reject) {
      const msg = err.errors.map((x) => `${x.code}: ${x.message}`).join('; ');
      db.run(`UPDATE ingestion_event SET processing_status = 'REJECTED', error_code = ?, last_error = ?, processed_at = ? WHERE event_id = ?`, err.errors[0].code, msg.slice(0, 1000), now, eventId);
      addHistory(db, eventId, 'NORMALIZE', 'REJECTED', msg.slice(0, 500), now);
      return { sourceEventId: ev.source_event_id, eventId, status: 'REJECTED', processingStatus: 'REJECTED', errors: err.errors };
    }
    if (err instanceof Suspend) {
      const attempts = ev.attempts + 1;
      if (attempts >= ctx.config.maxAttempts) {
        db.run(`UPDATE ingestion_event SET processing_status = 'DEAD_LETTER', attempts = ?, error_code = ?, last_error = ?, next_attempt_at = NULL WHERE event_id = ?`, attempts, err.code, err.message, eventId);
        addHistory(db, eventId, 'DEAD_LETTER', err.code, err.message, now);
        return { sourceEventId: ev.source_event_id, eventId, status: 'SUSPENDED', processingStatus: 'DEAD_LETTER', errors: [{ code: err.code, message: err.message }] };
      }
      const next = new Date(clock.now().getTime() + ctx.config.retryBaseSeconds * 1000 * 2 ** (attempts - 1)).toISOString();
      db.run(`UPDATE ingestion_event SET processing_status = 'SUSPENDED', attempts = ?, error_code = ?, last_error = ?, next_attempt_at = ? WHERE event_id = ?`, attempts, err.code, err.message, next, eventId);
      addHistory(db, eventId, 'NORMALIZE', 'SUSPENDED', `${err.code}: ${err.message}`, now);
      return { sourceEventId: ev.source_event_id, eventId, status: 'SUSPENDED', processingStatus: 'SUSPENDED', errors: [{ code: err.code, message: err.message }] };
    }
    throw err;
  }
}

function checkRef(db: Db, table: string, col: string, value: string | undefined, label: string, errs: ErrorItem[]) {
  if (value && !db.get(`SELECT 1 FROM ${table} WHERE ${col} = ?`, value)) {
    errs.push({ code: 'UNKNOWN_REFERENCE', path: label, message: `Unknown ${label} "${value}".` });
  }
}

function normalizeTransaction(ctx: EngineCtx, ev: any, raw: any): string {
  const { db, clock, config } = ctx;
  const now = clock.now();
  const parsed = TxnPayloadSchema.safeParse(raw.transaction);
  if (!parsed.success) throw new Reject(zodErrors(parsed.error).map((x) => ({ ...x, path: `transaction.${x.path}` })));
  const p = parsed.data;
  const errs: ErrorItem[] = [];

  if (p.currency !== 'INR') errs.push({ code: 'UNSUPPORTED_CURRENCY', path: 'currency', message: `Only INR is supported (got ${p.currency}).` });
  let amountMinor = 0;
  try {
    amountMinor = toMinor(p.amount);
    if (amountMinor < 0) errs.push({ code: 'INVALID_AMOUNT', path: 'amount', message: 'Amount must be zero or positive; use drCr for direction.' });
    if (amountMinor > 1e12) errs.push({ code: 'INVALID_AMOUNT', path: 'amount', message: 'Amount exceeds the supported maximum.' });
  } catch {
    errs.push({ code: 'INVALID_AMOUNT', path: 'amount', message: `Amount "${p.amount}" is not a number.` });
  }
  const ts = new Date(p.txnTimestamp);
  if (Number.isNaN(ts.getTime())) errs.push({ code: 'INVALID_TIMESTAMP', path: 'txnTimestamp', message: `Invalid timestamp "${p.txnTimestamp}".` });
  else if (ts.getTime() > now.getTime() + config.futureToleranceMinutes * 60000) {
    errs.push({ code: 'FUTURE_DATED', path: 'txnTimestamp', message: 'Transaction timestamp is in the future.' });
  }
  const reversing = REVERSING_TYPES.has(p.txnType) || p.reversalIndicator === true;
  if (reversing && !p.originalSourceTxnId) errs.push({ code: 'ORIGINAL_REQUIRED', path: 'originalSourceTxnId', message: 'Reversals and refunds must reference the original transaction.' });
  if (p.status === 'PARTIALLY_REFUNDED' && p.refundedAmount === undefined) {
    errs.push({ code: 'REFUND_AMOUNT_REQUIRED', path: 'refundedAmount', message: 'PARTIALLY_REFUNDED needs refundedAmount.' });
  }
  checkRef(db, 'channel_ref', 'channel_code', p.channel, 'channel', errs);
  checkRef(db, 'txn_type_ref', 'txn_type_code', p.txnType, 'txnType', errs);
  checkRef(db, 'txn_category_ref', 'category_code', p.categoryCode, 'categoryCode', errs);
  checkRef(db, 'product_ref', 'product_code', p.productCode, 'productCode', errs);
  if (errs.length) throw new Reject(errs);

  const customer = db.get<any>('SELECT * FROM customer WHERE customer_ref = ?', p.customerRef);
  if (!customer) throw new Suspend('UNKNOWN_CUSTOMER', `Customer ${p.customerRef} is not in reference data yet.`);
  let account: any;
  if (p.accountRef) {
    account = db.get<any>('SELECT * FROM account WHERE account_ref = ?', p.accountRef);
    if (!account) throw new Suspend('UNKNOWN_ACCOUNT', `Account ${p.accountRef} is not in reference data yet.`);
    if (account.customer_id !== customer.customer_id) {
      throw new Reject([{ code: 'ACCOUNT_CUSTOMER_MISMATCH', message: 'The account does not belong to the stated customer.' }]);
    }
  }
  const instrument = p.instrumentRef ? db.get<any>('SELECT * FROM instrument WHERE instrument_ref = ?', p.instrumentRef) : undefined;
  const productCode = p.productCode ?? account?.product_code ?? instrument?.product_code ?? null;
  const tsIso = ts.toISOString();
  const nowIso = now.toISOString();
  const attrs = JSON.stringify(p.attributes ?? {});
  const existing = db.get<any>('SELECT * FROM txn_master WHERE source_system = ? AND source_txn_id = ?', ev.source_system, p.sourceTxnId);

  // ---- Reversal / refund records ------------------------------------
  if (reversing) {
    const original = db.get<any>('SELECT * FROM txn_master WHERE source_system = ? AND source_txn_id = ?', ev.source_system, p.originalSourceTxnId);
    if (!original) throw new Suspend('ORIGINAL_NOT_FOUND', `Original transaction ${p.originalSourceTxnId} has not arrived yet.`);
    if (original.customer_id !== customer.customer_id) throw new Reject([{ code: 'ORIGINAL_CUSTOMER_MISMATCH', message: 'The original transaction belongs to another customer.' }]);
    if (existing) {
      // Idempotent replay of an already applied reversal record.
      db.run('UPDATE ingestion_event SET txn_id = ? WHERE event_id = ?', original.txn_id, ev.event_id);
      return original.txn_id;
    }
    if (!['PENDING', 'POSTED', 'PARTIALLY_REFUNDED'].includes(original.status)) {
      throw new Reject([{ code: 'ORIGINAL_NOT_REVERSIBLE', message: `Original transaction is ${original.status}; it cannot be reversed or refunded again.` }]);
    }
    const isFull = p.txnType === 'REVERSAL';
    const remaining = original.amount_minor - original.refunded_minor;
    const effective = isFull ? remaining : amountMinor;
    if (effective > remaining) throw new Reject([{ code: 'REFUND_EXCEEDS_ORIGINAL', message: `Refund of ${effective / 100} exceeds the refundable ${remaining / 100}.` }]);
    const reversalTxnId = uid();
    db.run(
      `INSERT INTO txn_master(txn_id, source_system, source_txn_id, customer_id, account_id, instrument_ref, product_code, txn_type, category_code, channel_code,
         amount_minor, currency, dr_cr, txn_ts, posting_date, status, refunded_minor, merchant_id, merchant_name, mcc, original_txn_id, is_reversal, reference_no,
         attributes_json, first_event_id, last_event_id, ingested_at, updated_at, processing_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      reversalTxnId, ev.source_system, p.sourceTxnId, customer.customer_id, account?.account_id ?? original.account_id, p.instrumentRef ?? original.instrument_ref,
      productCode ?? original.product_code, p.txnType, p.categoryCode ?? original.category_code, p.channel, effective, 'INR', p.drCr, tsIso, p.postingDate ?? null,
      'POSTED', 0, p.merchantId ?? original.merchant_id, p.merchantName ?? original.merchant_name, p.mcc ?? original.mcc, original.txn_id, 1, p.referenceNo ?? null,
      attrs, ev.event_id, ev.event_id, nowIso, nowIso, 'EVALUATED',
    );
    const newRefunded = original.refunded_minor + effective;
    const newStatus = isFull ? 'REVERSED' : newRefunded >= original.amount_minor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    db.run('UPDATE txn_master SET status = ?, refunded_minor = ?, last_event_id = ?, updated_at = ?, processing_status = ? WHERE txn_id = ?', newStatus, newRefunded, ev.event_id, nowIso, 'PENDING_EVAL', original.txn_id);
    db.run('INSERT INTO txn_status_history(txn_id, from_status, to_status, refunded_minor, event_id, changed_at) VALUES (?,?,?,?,?,?)', original.txn_id, original.status, newStatus, newRefunded, ev.event_id, nowIso);
    db.run('UPDATE ingestion_event SET txn_id = ? WHERE event_id = ?', original.txn_id, ev.event_id);
    return original.txn_id;
  }

  // ---- Ordinary transaction ------------------------------------------
  if (!existing) {
    const refunded = p.status === 'REVERSED' || p.status === 'REFUNDED' ? amountMinor : p.status === 'PARTIALLY_REFUNDED' ? toMinor(p.refundedAmount!) : 0;
    if (refunded > amountMinor) throw new Reject([{ code: 'REFUND_EXCEEDS_ORIGINAL', path: 'refundedAmount', message: 'Refunded amount exceeds the transaction amount.' }]);
    const txnId = uid();
    db.run(
      `INSERT INTO txn_master(txn_id, source_system, source_txn_id, customer_id, account_id, instrument_ref, product_code, txn_type, category_code, channel_code,
         amount_minor, currency, dr_cr, txn_ts, posting_date, status, refunded_minor, merchant_id, merchant_name, mcc, original_txn_id, is_reversal, reference_no,
         attributes_json, first_event_id, last_event_id, ingested_at, updated_at, processing_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      txnId, ev.source_system, p.sourceTxnId, customer.customer_id, account?.account_id ?? null, p.instrumentRef ?? null, productCode, p.txnType, p.categoryCode ?? null,
      p.channel, amountMinor, 'INR', p.drCr, tsIso, p.postingDate ?? null, p.status, refunded, p.merchantId ?? null, p.merchantName ?? null, p.mcc ?? null, null, 0,
      p.referenceNo ?? null, attrs, ev.event_id, ev.event_id, nowIso, nowIso, 'PENDING_EVAL',
    );
    db.run('INSERT INTO txn_status_history(txn_id, from_status, to_status, refunded_minor, event_id, changed_at) VALUES (?,?,?,?,?,?)', txnId, null, p.status, refunded, ev.event_id, nowIso);
    db.run('UPDATE ingestion_event SET txn_id = ? WHERE event_id = ?', txnId, ev.event_id);
    releaseSuspended(ctx, ev.source_system, p.sourceTxnId);
    return txnId;
  }

  // Update of a known transaction: enforce immutability and forward-only status.
  if (existing.customer_id !== customer.customer_id || existing.dr_cr !== p.drCr || existing.txn_type !== p.txnType) {
    throw new Reject([{ code: 'IMMUTABLE_MISMATCH', message: 'Customer, direction or type differ from the stored transaction.' }]);
  }
  if (existing.status !== 'PENDING' && existing.amount_minor !== amountMinor) {
    throw new Reject([{ code: 'IMMUTABLE_MISMATCH', message: 'Amount differs from the stored transaction (only PENDING amounts may change).' }]);
  }
  db.run('UPDATE ingestion_event SET txn_id = ? WHERE event_id = ?', existing.txn_id, ev.event_id);
  const from = STATUS_RANK[existing.status];
  const to = STATUS_RANK[p.status];
  const bad = existing.status === 'POSTED' && p.status === 'FAILED';
  if (bad) throw new Reject([{ code: 'INVALID_TRANSITION', message: 'A POSTED transaction cannot become FAILED.' }]);
  if (to <= from && !(existing.status === 'PENDING' && p.status === 'PENDING' && existing.amount_minor !== amountMinor)) {
    addHistory(db, ev.event_id, 'NORMALIZE', 'STALE_OR_DUPLICATE', `Status ${p.status} does not advance ${existing.status}; ignored.`, nowIso);
    db.run(`UPDATE ingestion_event SET processing_status = 'PROCESSED', processed_at = ? WHERE event_id = ?`, nowIso, ev.event_id);
    return existing.txn_id;
  }
  const refunded =
    p.status === 'REVERSED' || p.status === 'REFUNDED' ? amountMinor : p.status === 'PARTIALLY_REFUNDED' ? Math.max(existing.refunded_minor, toMinor(p.refundedAmount!)) : existing.refunded_minor;
  if (refunded > amountMinor) throw new Reject([{ code: 'REFUND_EXCEEDS_ORIGINAL', message: 'Refunded amount exceeds the transaction amount.' }]);
  db.run(
    `UPDATE txn_master SET status = ?, amount_minor = ?, refunded_minor = ?, posting_date = COALESCE(?, posting_date), merchant_id = COALESCE(?, merchant_id),
       merchant_name = COALESCE(?, merchant_name), mcc = COALESCE(?, mcc), category_code = COALESCE(?, category_code), last_event_id = ?, updated_at = ?,
       processing_status = 'PENDING_EVAL' WHERE txn_id = ?`,
    p.status, amountMinor, refunded, p.postingDate ?? null, p.merchantId ?? null, p.merchantName ?? null, p.mcc ?? null, p.categoryCode ?? null, ev.event_id, nowIso, existing.txn_id,
  );
  db.run('INSERT INTO txn_status_history(txn_id, from_status, to_status, refunded_minor, event_id, changed_at) VALUES (?,?,?,?,?,?)', existing.txn_id, existing.status, p.status, refunded, ev.event_id, nowIso);
  return existing.txn_id;
}

function normalizeSnapshot(ctx: EngineCtx, ev: any, raw: any) {
  const { db, clock } = ctx;
  const parsed = SnapshotPayloadSchema.safeParse(raw.snapshot);
  if (!parsed.success) throw new Reject(zodErrors(parsed.error).map((x) => ({ ...x, path: `snapshot.${x.path}` })));
  const p = parsed.data;
  const errs: ErrorItem[] = [];
  if (p.currency !== 'INR') errs.push({ code: 'UNSUPPORTED_CURRENCY', path: 'currency', message: 'Only INR is supported.' });
  let bal = 0;
  try {
    bal = toMinor(p.closingBalance);
  } catch {
    errs.push({ code: 'INVALID_AMOUNT', path: 'closingBalance', message: 'closingBalance is not a number.' });
  }
  const today = clock.now().toISOString().slice(0, 10);
  if (p.asOfDate > today) errs.push({ code: 'FUTURE_DATED', path: 'asOfDate', message: 'Snapshot date is in the future.' });
  if (errs.length) throw new Reject(errs);
  const account = db.get<any>('SELECT * FROM account WHERE account_ref = ?', p.accountRef);
  if (!account) throw new Suspend('UNKNOWN_ACCOUNT', `Account ${p.accountRef} is not in reference data yet.`);
  const now = clock.now().toISOString();
  const cur = db.get<any>('SELECT * FROM balance_snapshot WHERE account_id = ? AND as_of_date = ?', account.account_id, p.asOfDate);
  let snapshotId: string;
  if (!cur) {
    snapshotId = uid();
    db.run(
      'INSERT INTO balance_snapshot(snapshot_id, account_id, as_of_date, closing_balance_minor, currency, source_system, event_id, revision, ingested_at) VALUES (?,?,?,?,?,?,?,?,?)',
      snapshotId, account.account_id, p.asOfDate, bal, 'INR', ev.source_system, ev.event_id, 1, now,
    );
  } else {
    snapshotId = cur.snapshot_id;
    if (cur.closing_balance_minor !== bal) {
      db.run('UPDATE balance_snapshot SET closing_balance_minor = ?, revision = revision + 1, event_id = ?, ingested_at = ? WHERE snapshot_id = ?', bal, ev.event_id, now, snapshotId);
      addHistory(db, ev.event_id, 'NORMALIZE', 'RESTATED', `Balance for ${p.asOfDate} restated ${cur.closing_balance_minor / 100} -> ${bal / 100}`, now);
    }
  }
  db.run('UPDATE ingestion_event SET snapshot_id = ? WHERE event_id = ?', snapshotId, ev.event_id);
}

/** A newly arrived original lets its parked reversals retry straight away. */
function releaseSuspended(ctx: EngineCtx, sourceSystem: string, sourceTxnId: string) {
  const { db, clock } = ctx;
  db.run(
    `UPDATE ingestion_event SET next_attempt_at = ? WHERE source_system = ? AND processing_status = 'SUSPENDED'
       AND error_code = 'ORIGINAL_NOT_FOUND' AND payload_json LIKE ?`,
    clock.now().toISOString(), sourceSystem, `%"originalSourceTxnId":${JSON.stringify(sourceTxnId)}%`,
  );
}

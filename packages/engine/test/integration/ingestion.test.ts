import { describe, expect, it } from 'vitest';
import { closeBatch, openBatch, replayEvent } from '../../src/index';
import { cardEvent, emptyEnv, ledgerTotal, ops } from '../helpers';

const T = '2026-10-02T10:00:00+05:30';

describe('ingestion: validation, de-duplication and normalisation', () => {
  it('accepts a valid transaction into the master and evaluates it', () => {
    const { engine, db } = emptyEnv();
    const { results, work } = engine.ingestAndProcess([cardEvent('t1', 10000, T)]);
    expect(results[0]).toMatchObject({ status: 'ACCEPTED' });
    expect(work.processed).toBe(1);
    expect(db.get<any>('SELECT amount_minor, status, processing_status FROM txn_master WHERE source_txn_id = ?', 't1')).toMatchObject({ amount_minor: 1_000_000, status: 'POSTED', processing_status: 'EVALUATED' });
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(300);
  });

  it('treats an identical redelivery as a duplicate and a changed payload under the same id as a conflict', () => {
    const { engine, db } = emptyEnv();
    engine.ingestAndProcess([cardEvent('t1', 10000, T)]);
    const dup = engine.ingestAndProcess([cardEvent('t1', 10000, T)]).results[0];
    expect(dup.status).toBe('DUPLICATE');
    const conflict = engine.ingestAndProcess([cardEvent('t1', 99999, T)]).results[0];
    expect(conflict.status).toBe('REJECTED');
    expect(conflict.errors![0].code).toBe('CONFLICTING_DUPLICATE');
    expect(db.value('SELECT COUNT(*) FROM txn_master WHERE source_txn_id = ?', 't1')).toBe(1);
    expect(db.value('SELECT amount_minor FROM txn_master WHERE source_txn_id = ?', 't1')).toBe(1_000_000);
    expect(ledgerTotal(db, 'CUST-1001')).toBe(300);
  });

  it('the same business transaction sent under a different event id is still one transaction', () => {
    const { engine, db } = emptyEnv();
    const a = cardEvent('t1', 10000, T);
    const b = { ...cardEvent('t1', 10000, T), sourceEventId: 'another-event-id' };
    engine.ingestAndProcess([a, b]);
    expect(db.value('SELECT COUNT(*) FROM txn_master')).toBe(1);
    expect(ledgerTotal(db, 'CUST-1001')).toBe(300);
    expect(db.value("SELECT COUNT(*) FROM xp_ledger WHERE entry_type = 'AWARD'")).toBe(1);
  });

  it('rejects malformed events with specific, actionable errors and stores nothing in the master', () => {
    const { engine, db } = emptyEnv();
    const bad = [
      cardEvent('b1', 100, T, { currency: 'USD' }),
      cardEvent('b2', 100, T, { channel: 'CARRIER_PIGEON' }),
      cardEvent('b3', 'abc' as any, T),
      cardEvent('b4', 100, '2099-01-01T00:00:00Z'),
      cardEvent('b5', 100, T, { txnType: 'REFUND' }), // refund without original
      cardEvent('b6', 100, T, { mcc: '12' }),
      { eventType: 'TRANSACTION', sourceSystem: 'CARDS' },
    ];
    const codes = engine.ingest(bad).map((r) => [r.status, r.errors?.[0].code]);
    expect(codes).toEqual([
      ['REJECTED', 'UNSUPPORTED_CURRENCY'],
      ['REJECTED', 'UNKNOWN_REFERENCE'],
      ['REJECTED', 'INVALID_AMOUNT'],
      ['REJECTED', 'FUTURE_DATED'],
      ['REJECTED', 'ORIGINAL_REQUIRED'],
      ['REJECTED', 'INVALID_FIELD'],
      ['REJECTED', 'INVALID_FIELD'],
    ]);
    expect(db.value('SELECT COUNT(*) FROM txn_master')).toBe(0);
  });

  it('rejects an account that belongs to another customer', () => {
    const { engine } = emptyEnv();
    const r = engine.ingest([cardEvent('x1', 100, T, { customerRef: 'CUST-1002' })])[0];
    expect(r.errors![0].code).toBe('ACCOUNT_CUSTOMER_MISMATCH');
  });

  it('parks events for unknown customers, retries with back-off and releases them once the customer exists', () => {
    const { engine, db, clock } = emptyEnv();
    const ev = cardEvent('late-ref', 12000, T, { customerRef: 'CUST-9999', accountRef: 'CCA-9999', instrumentRef: 'CARD-9999' });
    const r = engine.ingestAndProcess([ev]).results[0];
    expect(r).toMatchObject({ status: 'SUSPENDED', processingStatus: 'SUSPENDED' });
    expect(r.errors![0].code).toBe('UNKNOWN_CUSTOMER');
    // Reference data arrives.
    const cid = 'c-9999';
    db.run("INSERT INTO customer(customer_id, customer_ref, masked_name, created_at, updated_at) VALUES (?,?,?,?,?)", cid, 'CUST-9999', 'N*** X', '2026-10-01', '2026-10-01');
    db.run("INSERT INTO account(account_id, customer_id, account_ref, product_code, account_type, opened_on, created_at) VALUES ('a-9999', ?, 'CCA-9999', 'CC_GOLD', 'CREDIT_CARD', '2024-01-01', '2026-10-01')", cid);
    db.run("INSERT INTO instrument(instrument_id, customer_id, account_id, instrument_ref, instrument_type, product_code) VALUES ('i-9999', ?, 'a-9999', 'CARD-9999', 'CREDIT_CARD', 'CC_GOLD')", cid);
    // Not yet due.
    expect(engine.drain().retriedSuspended).toBe(0);
    clock.set(new Date(clock.now().getTime() + 5 * 60_000));
    const w = engine.drain();
    expect(w.retriedSuspended).toBeGreaterThan(0);
    expect(db.value("SELECT processing_status FROM ingestion_event WHERE source_event_id = 'late-ref:POSTED'")).toBe('PROCESSED');
    expect(ledgerTotal(db, 'CUST-9999')).toBe(300);
  });

  it('moves an event to the dead-letter queue after the maximum attempts, and replay recovers it', () => {
    const { engine, db, clock } = emptyEnv();
    const ev = cardEvent('dlq', 12000, T, { customerRef: 'CUST-7777', accountRef: 'CCA-7777' });
    engine.ingest([ev]);
    for (let i = 0; i < 12; i++) {
      clock.set(new Date(clock.now().getTime() + 24 * 3600_000));
      engine.drain();
    }
    const row = db.get<any>("SELECT event_id, processing_status, attempts FROM ingestion_event WHERE source_event_id = 'dlq:POSTED'")!;
    expect(row.processing_status).toBe('DEAD_LETTER');
    expect(row.attempts).toBe(engine.ctx.config.maxAttempts);
    // Fix the cause and replay (operations permission is enforced at the API layer).
    db.run("INSERT INTO customer(customer_id, customer_ref, masked_name, created_at, updated_at) VALUES ('c-7', 'CUST-7777', 'Z', '2026-10-01', '2026-10-01')");
    db.run("INSERT INTO account(account_id, customer_id, account_ref, product_code, account_type, opened_on, created_at) VALUES ('a-7', 'c-7', 'CCA-7777', 'CC_GOLD', 'CREDIT_CARD', '2024-01-01', '2026-10-01')");
    db.run("INSERT INTO instrument(instrument_id, customer_id, account_id, instrument_ref, instrument_type) VALUES ('i-7', 'c-7', 'a-7', 'CARD-1001-X', 'CREDIT_CARD')");
    const out = replayEvent(engine.withCorrelation(), ops, row.event_id);
    expect(out.status).toBe('ACCEPTED');
    expect(db.value("SELECT processing_status FROM ingestion_event WHERE event_id = ?", row.event_id)).toBe('PROCESSED');
    expect(db.value("SELECT COUNT(*) FROM audit_log WHERE action = 'EVENT_REPLAY'")).toBe(1);
  });

  it('refuses to replay an event that already succeeded', () => {
    const { engine, db } = emptyEnv();
    engine.ingestAndProcess([cardEvent('ok', 100, T)]);
    const id = db.value<string>("SELECT event_id FROM ingestion_event WHERE source_event_id = 'ok:POSTED'")!;
    expect(() => replayEvent(engine.withCorrelation(), ops, id)).toThrow(/only failed, rejected/);
  });

  it('parks a refund until its original arrives, then applies it', () => {
    const { engine, db } = emptyEnv();
    const refund = {
      eventType: 'TRANSACTION', sourceSystem: 'CARDS', sourceEventId: 'rf:POSTED',
      transaction: { sourceTxnId: 'rf', originalSourceTxnId: 'orig', customerRef: 'CUST-1001', accountRef: 'CCA-1001', txnType: 'REFUND', channel: 'CARD_ONLINE', amount: 4000, drCr: 'C', currency: 'INR', status: 'POSTED', txnTimestamp: '2026-10-04T10:00:00+05:30' },
    };
    expect(engine.ingestAndProcess([refund]).results[0].errors![0].code).toBe('ORIGINAL_NOT_FOUND');
    engine.ingestAndProcess([cardEvent('orig', 12000, T)]);
    engine.drain();
    expect(db.get<any>("SELECT status, refunded_minor FROM txn_master WHERE source_txn_id = 'orig'")).toMatchObject({ status: 'PARTIALLY_REFUNDED', refunded_minor: 400_000 });
    // 12,000 - 4,000 = 8,000 < 10,000 so no reward remains
    expect(ledgerTotal(db, 'CUST-1001', 'CARD_SPEND_10K')).toBe(0);
  });

  it('refuses to refund more than was paid or to reverse the same transaction twice', () => {
    const { engine } = emptyEnv();
    engine.ingestAndProcess([cardEvent('orig', 1000, T)]);
    const mk = (id: string, type: string, amount: number) => ({
      eventType: 'TRANSACTION', sourceSystem: 'CARDS', sourceEventId: `${id}:POSTED`,
      transaction: { sourceTxnId: id, originalSourceTxnId: 'orig', customerRef: 'CUST-1001', accountRef: 'CCA-1001', txnType: type, channel: 'CARD_ONLINE', amount, drCr: 'C', currency: 'INR', status: 'POSTED', txnTimestamp: '2026-10-04T10:00:00+05:30' },
    });
    expect(engine.ingest([mk('r1', 'REFUND', 1500)])[0].errors![0].code).toBe('REFUND_EXCEEDS_ORIGINAL');
    expect(engine.ingest([mk('r2', 'REVERSAL', 1000)])[0].status).toBe('ACCEPTED');
    expect(engine.ingest([mk('r3', 'REVERSAL', 1000)])[0].errors![0].code).toBe('ORIGINAL_NOT_REVERSIBLE');
  });

  it('status only moves forward: a late PENDING does not undo POSTED, and a FAILED cannot follow POSTED', () => {
    const { engine, db } = emptyEnv();
    engine.ingestAndProcess([cardEvent('s1', 11000, T)]);
    const stale = { ...cardEvent('s1', 11000, T, { status: 'PENDING' }), sourceEventId: 's1:PENDING' };
    engine.ingestAndProcess([stale]);
    expect(db.value("SELECT status FROM txn_master WHERE source_txn_id = 's1'")).toBe('POSTED');
    const failed = { ...cardEvent('s1', 11000, T, { status: 'FAILED' }), sourceEventId: 's1:FAILED' };
    expect(engine.ingest([failed])[0].errors![0].code).toBe('INVALID_TRANSITION');
    expect(ledgerTotal(db, 'CUST-1001')).toBe(300);
  });

  it('refuses to change the amount of a posted transaction', () => {
    const { engine } = emptyEnv();
    engine.ingestAndProcess([cardEvent('s1', 11000, T)]);
    const changed = { ...cardEvent('s1', 25000, T), sourceEventId: 's1:POSTED:v2' };
    expect(engine.ingest([changed])[0].errors![0].code).toBe('IMMUTABLE_MISMATCH');
  });

  it('balance snapshots are idempotent and restatements are recorded', () => {
    const { engine, db } = emptyEnv();
    const snap = (id: string, bal: number) => ({ eventType: 'BALANCE_SNAPSHOT', sourceSystem: 'CORE', sourceEventId: id, snapshot: { accountRef: 'SA-1001', asOfDate: '2026-10-01', closingBalance: bal } });
    engine.ingestAndProcess([snap('s-a', 50000)]);
    engine.ingestAndProcess([snap('s-a', 50000)]);
    engine.ingestAndProcess([snap('s-b', 52000)]);
    expect(db.value('SELECT COUNT(*) FROM balance_snapshot')).toBe(1);
    expect(db.get<any>('SELECT closing_balance_minor, revision FROM balance_snapshot')).toMatchObject({ closing_balance_minor: 5_200_000, revision: 2 });
    expect(db.value("SELECT COUNT(*) FROM ingestion_event_history WHERE outcome = 'RESTATED'")).toBe(1);
    expect(engine.ingest([{ ...snap('s-c', 1), snapshot: { accountRef: 'SA-1001', asOfDate: '2099-01-01', closingBalance: 1 } }])[0].errors![0].code).toBe('FUTURE_DATED');
  });

  it('batches reconcile against their control totals', () => {
    const { engine, db } = emptyEnv();
    const ctx = engine.withCorrelation();
    const ok = openBatch(ctx, { sourceSystem: 'CARDS', controlCount: 3, controlAmount: 600 });
    engine.ingest([cardEvent('b1', 100, T), cardEvent('b2', 200, T), cardEvent('b3', 300, T)], { batchId: ok });
    expect(closeBatch(ctx, ok).status).toBe('RECONCILED');
    const bad = openBatch(ctx, { sourceSystem: 'CARDS', controlCount: 3, controlAmount: 700 });
    engine.ingest([cardEvent('c1', 100, T), cardEvent('c2', 200, T)], { batchId: bad });
    const closed = closeBatch(ctx, bad);
    expect(closed.status).toBe('MISMATCH');
    expect(db.value('SELECT COUNT(*) FROM ingestion_batch')).toBe(2);
  });
});

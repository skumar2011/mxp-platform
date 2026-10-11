import type { Db } from './db';
import { audit, type Actor } from './audit';
import type { Ctx } from './campaigns';
import { MxpError, uid, type Clock } from './util';

export interface LedgerEntry {
  ledger_id: number;
  customer_id: string;
  entry_type: 'AWARD' | 'REVERSAL' | 'ADJUSTMENT';
  points: number;
  rule_id: string | null;
  rule_version_id: string | null;
  campaign_id: string | null;
  period_key: string | null;
  slot: string | null;
  tier_no: number | null;
  source_txn_id: string | null;
  reverses_ledger_id: number | null;
  reason_code: string;
  reason_text: string | null;
  idempotency_key: string;
  created_by: string;
  created_at: string;
}

export interface PostInput {
  customerId: string;
  entryType: 'AWARD' | 'REVERSAL' | 'ADJUSTMENT';
  points: number;
  ruleId?: string | null;
  ruleVersionId?: string | null;
  campaignId?: string | null;
  periodKey?: string | null;
  slot?: string | null;
  tierNo?: number | null;
  sourceTxnId?: string | null;
  sourceEventId?: string | null;
  evaluationId?: string | null;
  reversesLedgerId?: number | null;
  adjustmentId?: string | null;
  reasonCode: string;
  reasonText?: string | null;
  idempotencyKey: string;
  createdBy?: string;
}

/**
 * Appends one ledger entry and maintains the xp_account projection in the same transaction.
 * Returns null when the idempotency key already exists (the effect was already applied).
 */
export function postLedger(db: Db, clock: Clock, e: PostInput): LedgerEntry | null {
  const existing = db.get<LedgerEntry>('SELECT * FROM xp_ledger WHERE idempotency_key = ?', e.idempotencyKey);
  if (existing) return null;
  const now = clock.now().toISOString();
  const r = db.run(
    `INSERT INTO xp_ledger(customer_id, entry_type, points, rule_id, rule_version_id, campaign_id, period_key, slot, tier_no, source_txn_id, source_event_id,
       evaluation_id, reverses_ledger_id, adjustment_id, reason_code, reason_text, idempotency_key, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.customerId, e.entryType, e.points, e.ruleId ?? null, e.ruleVersionId ?? null, e.campaignId ?? null, e.periodKey ?? null, e.slot ?? null,
    e.tierNo ?? null, e.sourceTxnId ?? null, e.sourceEventId ?? null, e.evaluationId ?? null, e.reversesLedgerId ?? null, e.adjustmentId ?? null,
    e.reasonCode, e.reasonText ?? null, e.idempotencyKey, e.createdBy ?? 'system', now,
  );
  const earned = e.points > 0 ? e.points : 0;
  const reversed = e.points < 0 ? -e.points : 0;
  db.run(
    `INSERT INTO xp_account(customer_id, balance, lifetime_earned, lifetime_reversed, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(customer_id) DO UPDATE SET balance = balance + excluded.balance,
       lifetime_earned = lifetime_earned + excluded.lifetime_earned, lifetime_reversed = lifetime_reversed + excluded.lifetime_reversed, updated_at = excluded.updated_at`,
    e.customerId, e.points, earned, reversed, now,
  );
  return db.get<LedgerEntry>('SELECT * FROM xp_ledger WHERE ledger_id = ?', r.lastInsertRowid)!;
}

export function slotNet(db: Db, customerId: string, ruleId: string, periodKey: string, slot: string): number {
  return (
    db.value<number>(
      'SELECT COALESCE(SUM(points),0) FROM xp_ledger WHERE customer_id = ? AND rule_id = ? AND period_key = ? AND slot = ?',
      customerId, ruleId, periodKey, slot,
    ) ?? 0
  );
}

export function slotAwardCount(db: Db, customerId: string, ruleId: string, periodKey: string, slot: string): number {
  return (
    db.value<number>(
      `SELECT COUNT(*) FROM xp_ledger WHERE customer_id = ? AND rule_id = ? AND period_key = ? AND slot = ? AND entry_type = 'AWARD'`,
      customerId, ruleId, periodKey, slot,
    ) ?? 0
  );
}

/** AWARD rows in a slot with how many of their points are still unreversed, newest first. */
export function reversibleAwards(db: Db, customerId: string, ruleId: string, periodKey: string, slot: string) {
  return db.all<{ ledger_id: number; points: number; reversed: number; tier_no: number | null; rule_version_id: string | null; campaign_id: string | null }>(
    `SELECT a.ledger_id, a.points, a.tier_no, a.rule_version_id, a.campaign_id,
            COALESCE((SELECT -SUM(r.points) FROM xp_ledger r WHERE r.reverses_ledger_id = a.ledger_id), 0) AS reversed
       FROM xp_ledger a
      WHERE a.customer_id = ? AND a.rule_id = ? AND a.period_key = ? AND a.slot = ? AND a.entry_type = 'AWARD'
      ORDER BY a.ledger_id DESC`,
    customerId, ruleId, periodKey, slot,
  );
}

export function customerBalance(db: Db, customerId: string): number {
  return db.value<number>('SELECT COALESCE(SUM(points),0) FROM xp_ledger WHERE customer_id = ?', customerId) ?? 0;
}

// ---------------------------------------------------------------------
// Reward adjustments (maker-checker) -- the only way to move points by hand
// ---------------------------------------------------------------------
export function requestAdjustment(ctx: Ctx, actor: Actor, customerRef: string, points: number, reason: string) {
  const { db, clock } = ctx;
  if (!Number.isInteger(points) || points === 0) throw new MxpError('BAD_POINTS', 'Points must be a non-zero whole number.');
  if (Math.abs(points) > 100000) throw new MxpError('BAD_POINTS', 'Adjustments above 100,000 points need a different process.');
  if (!reason || reason.trim().length < 5) throw new MxpError('REASON_REQUIRED', 'A reason is required (min 5 characters).');
  const cust = db.get<{ customer_id: string }>('SELECT customer_id FROM customer WHERE customer_ref = ?', customerRef);
  if (!cust) throw new MxpError('NOT_FOUND', `Customer ${customerRef} not found.`, 404);
  const id = uid();
  db.tx(() => {
    db.run(
      `INSERT INTO reward_adjustment(adjustment_id, customer_id, points, reason, status, requested_by, requested_at) VALUES (?,?,?,?,?,?,?)`,
      id, cust.customer_id, points, reason.trim(), 'REQUESTED', actor.username, clock.now().toISOString(),
    );
    audit(db, clock, actor, 'ADJUSTMENT_REQUEST', 'reward_adjustment', id, null, { customerRef, points, reason });
  });
  return db.get<any>('SELECT * FROM reward_adjustment WHERE adjustment_id = ?', id);
}

export function decideAdjustment(ctx: Ctx, actor: Actor, adjustmentId: string, approve: boolean, note?: string) {
  const { db, clock } = ctx;
  const adj = db.get<any>('SELECT * FROM reward_adjustment WHERE adjustment_id = ?', adjustmentId);
  if (!adj) throw new MxpError('NOT_FOUND', 'Adjustment not found.', 404);
  if (adj.status !== 'REQUESTED') throw new MxpError('BAD_TRANSITION', `Adjustment is already ${adj.status}.`, 409);
  if (adj.requested_by === actor.username) throw new MxpError('MAKER_CHECKER', 'Maker-checker: you cannot decide your own adjustment.', 403);
  db.tx(() => {
    let ledgerId: number | null = null;
    if (approve) {
      if (adj.points < 0 && customerBalance(db, adj.customer_id) + adj.points < 0) {
        throw new MxpError('NEGATIVE_BALANCE', 'This adjustment would take the customer balance below zero.', 409);
      }
      const entry = postLedger(db, clock, {
        customerId: adj.customer_id,
        entryType: 'ADJUSTMENT',
        points: adj.points,
        adjustmentId,
        reasonCode: 'MANUAL_ADJUSTMENT',
        reasonText: adj.reason,
        idempotencyKey: `ADJ|${adjustmentId}`,
        createdBy: actor.username,
      });
      ledgerId = entry?.ledger_id ?? null;
    }
    db.run(
      `UPDATE reward_adjustment SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, ledger_id = ? WHERE adjustment_id = ?`,
      approve ? 'APPROVED' : 'REJECTED', actor.username, clock.now().toISOString(), note ?? null, ledgerId, adjustmentId,
    );
    audit(db, clock, actor, approve ? 'ADJUSTMENT_APPROVE' : 'ADJUSTMENT_REJECT', 'reward_adjustment', adjustmentId, { status: 'REQUESTED' }, { status: approve ? 'APPROVED' : 'REJECTED', ledgerId }, note);
  });
  return db.get<any>('SELECT * FROM reward_adjustment WHERE adjustment_id = ?', adjustmentId);
}

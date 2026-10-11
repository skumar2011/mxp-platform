import { describe, expect, it } from 'vitest';
import { seededDb } from '../helpers';

/**
 * Golden master: the exact ledger produced by the documented sample data on 10 Oct 2026.
 * If this changes, either a rule/engine behaviour changed (investigate) or the sample data was edited on purpose
 * (update this file and docs/08-sample-data.md together).
 */
describe('golden ledger for the seeded sample data', () => {
  const db = seededDb();

  it('produces exactly the documented awards and reversals', () => {
    const rows = db
      .all<any>(
        `SELECT c.customer_ref AS cust, r.rule_code AS rule, l.period_key AS period, l.slot, l.entry_type AS type, l.points
           FROM xp_ledger l JOIN customer c USING(customer_id) JOIN rule r USING(rule_id) ORDER BY c.customer_ref, r.rule_code, l.period_key, l.ledger_id`,
      )
      .map((r) => `${r.cust} ${r.rule} ${r.period} ${r.slot} ${r.type} ${r.points}`);
    expect(rows).toEqual([
      'CUST-1001 CARD_SPEND_10K 2026-10 tier:1 AWARD 300',
      'CUST-1001 SAV_AVG_BAL_50K 2026-09 tier:1 AWARD 500',
      'CUST-1001 UPI_10_TXNS 2026-10 tier:1 AWARD 100',
      'CUST-1001 UTILITY_3_BILLS C:UTILITY_FEST tier:1 AWARD 150',
      'CUST-1003 SAV_GROWTH_25K 2026-09 tier:1 AWARD 400',
      'CUST-1003 UTILITY_3_BILLS C:UTILITY_FEST tier:1 AWARD 150',
      'CUST-1004 BALANCE_PLUS_CARD 2026-09 tier:1 AWARD 1000',
      'CUST-1004 CARD_SPEND_10K 2026-09 tier:1 AWARD 300',
      'CUST-1004 CARD_SPEND_10K 2026-10 tier:1 AWARD 300',
      'CUST-1004 CARD_SPEND_10K 2026-10 tier:1 REVERSAL -300',
      'CUST-1004 SAV_AVG_BAL_50K 2026-09 tier:1 AWARD 500',
    ]);
  });

  it('is reproducible: seeding twice gives the identical ledger', () => {
    const again = seededDb();
    // (internal ids are random per database, so compare the business content of each entry)
    const strip = (d: typeof db) =>
      d.all<any>(`SELECT c.customer_ref c, r.rule_code r, l.period_key p, l.slot s, l.points x, l.entry_type t FROM xp_ledger l JOIN customer c USING(customer_id) JOIN rule r USING(rule_id) ORDER BY 1,2,3,l.ledger_id`)
        .map((r) => `${r.c}|${r.r}|${r.p}|${r.s}|${r.t}|${r.x}`);
    expect(strip(again)).toEqual(strip(db));
  });

  it('keeps the transaction master free of anything MXP computed', () => {
    // MXP never posts or alters financial transactions: the master only holds what source systems sent.
    const cols = db.all<any>('PRAGMA table_info(txn_master)').map((c) => c.name);
    expect(cols).not.toContain('points');
    expect(db.value("SELECT COUNT(*) FROM txn_master WHERE source_system NOT IN ('CARDS','UPI','BILLPAY')")).toBe(0);
    expect(db.value('SELECT COUNT(*) FROM txn_master')).toBe(44);
  });
});

import { openDb, seedAll } from '../packages/engine/src/index';
const db = openDb(':memory:');
const r = seedAll(db, new Date('2026-10-10T09:00:00Z'));
console.log('seed', r.events, 'rejected', JSON.stringify(r.rejected).slice(0, 800));
console.table(db.all(`SELECT c.customer_ref, r.rule_code, l.period_key, l.slot, l.points, l.entry_type, l.created_at FROM xp_ledger l JOIN customer c USING(customer_id) JOIN rule r USING(rule_id) ORDER BY 1,2,3, l.ledger_id`));
console.table(db.all(`SELECT c.customer_ref, r.rule_code, g.period_key, g.txn_count, g.txn_sum_minor, g.metric_value, g.achieved_tier, g.status FROM goal_progress g JOIN customer c USING(customer_id) JOIN rule r USING(rule_id) ORDER BY 1,2,3`));
console.table(db.all(`SELECT processing_status, count(*) n FROM ingestion_event GROUP BY 1`));
console.table(db.all(`SELECT error_code, last_error FROM ingestion_event WHERE processing_status IN ('REJECTED','FAILED','DEAD_LETTER','SUSPENDED') LIMIT 10`));

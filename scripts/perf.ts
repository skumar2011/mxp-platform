import { openDb, seedAll, DbRuleSource, runPerformance } from '../packages/engine/src/index';
const db = openDb(':memory:');
seedAll(db, new Date('2026-10-10T09:00:00Z'));
const src = new DbRuleSource(db);
for (const code of ['CARD_SPEND_10K', 'UPI_10_TXNS', 'SAV_AVG_BAL_50K', 'UPI_MERCHANT_PER_TXN']) {
  const r = runPerformance(src, { rule: { ruleCode: code }, customers: 300, txnsPerCustomer: 25 });
  console.log(code, JSON.stringify(r));
}

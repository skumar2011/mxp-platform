import { DbRuleSource, Engine, FixedClock, actorFor, openDb, seedAll, seedCustomers, seedReference, seedUsers, seedRulesAndCampaigns, type Db } from '../src/index';

export const NOW = new Date('2026-10-10T09:00:00Z');

/** The complete demo environment: reference data, users, campaigns, six live rules, five customers, 244 events. */
export function seededDb(now: Date = NOW): Db {
  const db = openDb(':memory:');
  seedAll(db, now);
  return db;
}

/** Reference data, users, campaigns and rules but no customers or events. */
export function rulesOnlyDb(now: Date = NOW) {
  const db = openDb(':memory:');
  const clock = new FixedClock(now);
  const engine = new Engine(db, clock);
  seedReference(db);
  seedUsers(db, clock);
  seedRulesAndCampaigns(engine, now);
  return { db, clock, engine, source: new DbRuleSource(db) };
}

/** Same, plus customers, for tests that ingest their own events. */
export function emptyEnv(now: Date = NOW) {
  const env = rulesOnlyDb(now);
  seedCustomers(env.db, env.clock);
  return env;
}

export const maker = actorFor('maker');
export const checker = actorFor('checker');
export const admin = actorFor('admin');
export const ops = actorFor('ops');

/** Builds a card purchase event for CUST-1001 on the given IST day. */
export function cardEvent(id: string, amount: number, isoTime: string, extra: Record<string, unknown> = {}) {
  return {
    eventType: 'TRANSACTION',
    sourceSystem: 'CARDS',
    sourceEventId: `${id}:POSTED`,
    transaction: {
      sourceTxnId: id, customerRef: 'CUST-1001', accountRef: 'CCA-1001', instrumentRef: 'CARD-1001', txnType: 'PURCHASE',
      categoryCode: 'SHOPPING', channel: 'CARD_ONLINE', amount, currency: 'INR', drCr: 'D', status: 'POSTED', txnTimestamp: isoTime, ...extra,
    },
  };
}

export const ledgerTotal = (db: Db, customerRef?: string, ruleCode?: string): number =>
  db.value<number>(
    `SELECT COALESCE(SUM(l.points),0) FROM xp_ledger l JOIN customer c USING(customer_id) LEFT JOIN rule r USING(rule_id)
     WHERE (? IS NULL OR c.customer_ref = ?) AND (? IS NULL OR r.rule_code = ?)`,
    customerRef ?? null, customerRef ?? null, ruleCode ?? null, ruleCode ?? null,
  ) ?? 0;

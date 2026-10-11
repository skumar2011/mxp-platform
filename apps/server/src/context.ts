import type { Db, Engine, DbRuleSource, Clock } from '@mxp/engine';
import type { Config } from './config';

export interface AppCtx {
  cfg: Config;
  /** Production database (system of record for rules, ledger, audit). */
  db: Db;
  /** Separate simulation store: saved test cases and run history. Never holds production data. */
  sim: Db;
  engine: Engine;
  /** Read-only view of the production rule set for the simulator. */
  source: DbRuleSource;
  clock: Clock;
}

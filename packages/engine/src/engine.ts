import type { Db } from './db';
import { getLiveRules, getVersion, activate as activateRule, rollback as rollbackRule } from './ruleRepo';
import type { Actor } from './audit';
import { DEFAULT_CONFIG, loadConfig, type EngineConfig, type EngineCtx } from './context';
import { replayTransactions } from './evaluator';
import { ingestEvents, type IngestOptions } from './ingest';
import { dispatchNudges, loggingAdapter, type NudgeAdapter } from './nudge';
import { drain, processPending, runPeriodClose } from './worker';
import { periodOf, localDate } from './time';
import { systemClock, uid, type Clock } from './util';

/**
 * Thin facade over the engine modules. The API server and the simulator both construct one,
 * so production and sandbox runs share exactly the same processing code.
 */
export class Engine {
  readonly ctx: EngineCtx;

  constructor(
    readonly db: Db,
    readonly clock: Clock = systemClock,
    config?: Partial<EngineConfig>,
  ) {
    this.ctx = { db, clock, config: { ...DEFAULT_CONFIG, ...loadConfig(db), ...(config ?? {}) } };
  }

  withCorrelation(correlationId: string = uid()): EngineCtx {
    return { ...this.ctx, correlationId };
  }

  ingest(events: unknown[], opts: IngestOptions = {}) {
    return ingestEvents(this.withCorrelation(), events, opts);
  }

  process(limit?: number) {
    return processPending(this.ctx, limit);
  }

  drain() {
    return drain(this.ctx);
  }

  /** Ingest then evaluate immediately (synchronous mode used by tests and the simulator). */
  ingestAndProcess(events: unknown[], opts: IngestOptions = {}) {
    const results = this.ingest(events, opts);
    const work = this.drain();
    return { results, work };
  }

  closePeriods() {
    return runPeriodClose(this.ctx);
  }

  dispatchNudges(adapter: NudgeAdapter = loggingAdapter) {
    return dispatchNudges(this.ctx, adapter);
  }

  /** Activates an approved version and, if requested, replays open-period history through it. */
  activate(actor: Actor, ruleCode: string, versionNo: number, opts: { backfill?: boolean } = {}) {
    const v = activateRule(this.ctx, actor, ruleCode, versionNo);
    if (opts.backfill ?? v.def.backfill) this.backfillRule(ruleCode);
    return v;
  }

  rollback(actor: Actor, ruleCode: string, versionNo: number, reason: string) {
    const v = rollbackRule(this.ctx, actor, ruleCode, versionNo, reason);
    this.backfillRule(ruleCode);
    return v;
  }

  /** Rebuilds the current period for one rule from the transaction master (bounded, explicit scan). */
  backfillRule(ruleCode: string) {
    const rule = getLiveRules(this.db).find((r) => r.ruleCode === ruleCode);
    if (!rule) return { transactions: 0, ledgerEntries: 0 };
    const today = localDate(this.clock.now().toISOString(), rule.def.period.timezone);
    const period = periodOf(today, rule.def.period.type, rule.campaignWindow);
    const from = [period.start, rule.windowFrom].filter(Boolean).sort().at(-1)!;
    return replayTransactions(this.ctx, { fromDate: from, filter: (r) => r.ruleId === rule.ruleId });
  }

  liveRules() {
    return getLiveRules(this.db);
  }

  version(ruleCode: string, versionNo: number) {
    return getVersion(this.db, ruleCode, versionNo);
  }
}

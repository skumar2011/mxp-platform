import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './app';
import { loadConfig } from './config';
import { bootstrapDemo, bootstrapProduction, isEmpty } from './bootstrap';
import { openDb, openSimStore, systemClock } from '@mxp/engine';

async function main() {
  const cfg = loadConfig();
  for (const p of [cfg.dbPath, cfg.simDbPath]) if (p !== ':memory:') mkdirSync(dirname(p), { recursive: true });
  const db = openDb(cfg.dbPath);
  const sim = openSimStore(cfg.simDbPath);

  if (isEmpty(db)) {
    if (cfg.seedIfEmpty) {
      console.log('[mxp] empty database: loading demo data...');
      const s = bootstrapDemo(db);
      console.log('[mxp] demo data loaded', s ?? '');
    } else if (process.env.MXP_BOOTSTRAP_ADMIN_PASSWORD) {
      bootstrapProduction(db, systemClock, process.env.MXP_BOOTSTRAP_ADMIN_PASSWORD);
      console.log('[mxp] bootstrap complete: user "admin" created');
    } else {
      console.warn('[mxp] database has no users. Set MXP_BOOTSTRAP_ADMIN_PASSWORD (or MXP_SEED=1 for demo data) and restart.');
    }
  }

  const { app, ctx } = await buildApp({ cfg, db, sim });

  // ---------- background work (separate it into its own process with MXP_WORKER=0 on the API nodes) ----------
  const timers: NodeJS.Timeout[] = [];
  if (cfg.worker) {
    let busy = false;
    const guarded = (name: string, fn: () => unknown) => () => {
      if (busy) return;
      busy = true;
      try {
        fn();
      } catch (e) {
        app.log.error({ err: e }, `${name} failed`);
      } finally {
        busy = false;
      }
    };
    timers.push(setInterval(guarded('worker', () => ctx.engine.process()), cfg.workerIntervalMs));
    timers.push(setInterval(guarded('nudges', () => ctx.engine.dispatchNudges()), 5000));
    timers.push(setInterval(guarded('period-close', () => ctx.engine.closePeriods()), 15 * 60_000));
    guarded('period-close', () => ctx.engine.closePeriods())();
  }

  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`[mxp] ${cfg.env} API listening on http://${cfg.host}:${cfg.port}  (worker ${cfg.worker ? 'on' : 'off'})`);

  const shutdown = async (sig: string) => {
    console.log(`[mxp] ${sig}: shutting down`);
    timers.forEach(clearInterval);
    await app.close();
    db.raw.close();
    sim.raw.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Mxp, seed } from '@mxp/platform';
import { buildApp } from './app';
import { loadConfig } from './config';

const cfg = loadConfig();
if (cfg.dbPath !== ':memory:') mkdirSync(dirname(cfg.dbPath), { recursive: true });
const mx = Mxp.open(cfg.dbPath);

if (cfg.seedIfEmpty && !mx.db.value<number>('SELECT COUNT(*) FROM app_user')) {
  console.log('Empty database: seeding demo data…');
  seed(mx, { log: (m) => console.log(`  ${m}`) });
}

const { app } = await buildApp({ cfg, mx });

// Window-close worker: closes every window that ended before today (pack timezone). Idempotent.
let timer: NodeJS.Timeout | undefined;
if (cfg.worker) {
  const ops = { username: 'system:worker', roles: ['OPERATIONS'] };
  const tick = () => {
    try {
      const r = mx.runtime.closeWindows(ops);
      if (r.closed) app.log.info({ closed: r.closed, points: r.points }, 'windows closed');
    } catch (e) {
      app.log.error({ err: e }, 'window close failed');
    }
  };
  tick();
  timer = setInterval(tick, cfg.workerIntervalMs);
}

const shutdown = async () => {
  if (timer) clearInterval(timer);
  await app.close();
  mx.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: cfg.port, host: cfg.host });
console.log(`MXP API on http://${cfg.host}:${cfg.port}  (admin console /, testing app /testing/)`);

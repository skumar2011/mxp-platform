import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Mxp, seed } from '@mxp/platform';
import { loadConfig } from './config';

// Usage: npm run seed [-- --force] [-- --days 30]
const args = process.argv.slice(2);
const cfg = loadConfig();
const force = args.includes('--force');
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : undefined;

if (existsSync(cfg.dbPath)) {
  if (!force) {
    console.error(`${cfg.dbPath} exists. Re-run with --force to replace it.`);
    process.exit(1);
  }
  for (const f of [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) rmSync(f, { force: true });
}
mkdirSync(dirname(cfg.dbPath), { recursive: true });
const mx = Mxp.open(cfg.dbPath);
console.log(`Seeding ${cfg.dbPath}`);
const r = seed(mx, { days, log: (m) => console.log(`  ${m}`) });
mx.close();
console.log(`Done: ${r.events} events, ${r.closed} windows closed. Sign in as maker / checker / qa / ops / auditor / admin with password Mxp@Demo1.`);

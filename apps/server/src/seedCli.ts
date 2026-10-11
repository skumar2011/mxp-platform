import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, openSimStore, DEMO_PASSWORD, DEMO_USERS } from '@mxp/engine';
import { loadConfig } from './config';
import { bootstrapDemo } from './bootstrap';

/** Rebuilds the demo database. Refuses to overwrite existing data unless --force is given. */
const cfg = loadConfig();
const force = process.argv.includes('--force');
if (cfg.env === 'prod') {
  console.error('Refusing to load demo data in MXP_ENV=prod.');
  process.exit(1);
}
if (cfg.dbPath !== ':memory:') {
  if (existsSync(cfg.dbPath) && !force) {
    console.error(`${cfg.dbPath} already exists. Re-run with --force to delete it and reload the demo data.`);
    process.exit(1);
  }
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  for (const f of [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) rmSync(f, { force: true });
}
const db = openDb(cfg.dbPath);
openSimStore(cfg.simDbPath).raw.close();
const summary = bootstrapDemo(db);
console.log('Demo data loaded into', cfg.dbPath);
console.log(summary);
console.log(`\nDemo users (password ${DEMO_PASSWORD}):`);
for (const u of DEMO_USERS) console.log(`  ${u.username.padEnd(8)} ${u.roles.join(', ')}`);
db.raw.close();

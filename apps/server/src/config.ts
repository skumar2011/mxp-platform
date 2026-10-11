import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

/** Repository root, so relative paths mean the same thing whichever directory npm runs in. */
const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const at = (p: string) => (p === ':memory:' || isAbsolute(p) ? p : resolve(ROOT, p));

export interface Config {
  env: 'dev' | 'test' | 'staging' | 'prod';
  port: number;
  host: string;
  dbPath: string;
  simDbPath: string;
  jwtSecret: string;
  jwtTtl: string;
  /** Run the background worker / period-close / nudge dispatcher in this process. */
  worker: boolean;
  workerIntervalMs: number;
  /** Serve the built web apps from this directory (if it exists). */
  webDist: string;
  corsOrigin: string | null;
  seedIfEmpty: boolean;
  rateLimitMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.MXP_ENV ?? 'dev') as Config['env'];
  let secret = env.MXP_JWT_SECRET;
  if (!secret) {
    if (mode === 'prod' || mode === 'staging') throw new Error('MXP_JWT_SECRET is required when MXP_ENV is prod or staging.');
    secret = randomBytes(32).toString('hex'); // sessions do not survive a restart in dev
  }
  if (secret.length < 24 && (mode === 'prod' || mode === 'staging')) throw new Error('MXP_JWT_SECRET must be at least 24 characters.');
  return {
    env: mode,
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? '127.0.0.1',
    dbPath: at(env.MXP_DB ?? 'data/mxp.db'),
    simDbPath: at(env.MXP_SIM_DB ?? 'data/mxp-sim.db'),
    jwtSecret: secret,
    jwtTtl: env.MXP_JWT_TTL ?? '8h',
    worker: env.MXP_WORKER !== '0',
    workerIntervalMs: Number(env.MXP_WORKER_INTERVAL_MS ?? 1000),
    webDist: at(env.MXP_WEB_DIST ?? 'apps/web/dist'),
    corsOrigin: env.MXP_CORS_ORIGIN ?? null,
    seedIfEmpty: (env.MXP_SEED ?? (mode === 'dev' ? '1' : '0')) === '1',
    rateLimitMax: Number(env.MXP_RATE_LIMIT ?? 600),
  };
}

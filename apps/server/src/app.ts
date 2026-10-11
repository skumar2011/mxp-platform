import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { DbRuleSource, Engine, MxpError, openDb, openSimStore, systemClock, type Clock, type Db } from '@mxp/engine';
import { loadConfig, type Config } from './config';
import type { AppCtx } from './context';
import { authRoutes } from './routes/auth';
import { ruleRoutes } from './routes/rules';
import { reportRoutes } from './routes/reports';
import { opsRoutes } from './routes/ops';
import { adminRoutes } from './routes/admin';
import { simRoutes } from './routes/sim';
import { createHash } from 'node:crypto';

export interface BuildOptions {
  cfg?: Partial<Config>;
  db?: Db;
  sim?: Db;
  clock?: Clock;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppCtx }> {
  const cfg: Config = { ...loadConfig(), ...(opts.cfg ?? {}) };
  const clock = opts.clock ?? systemClock;
  const db = opts.db ?? openDb(cfg.dbPath);
  const sim = opts.sim ?? openSimStore(cfg.simDbPath);
  const engine = new Engine(db, clock);
  const ctx: AppCtx = { cfg, db, sim, engine, source: new DbRuleSource(db), clock };

  const app = Fastify({
    logger: opts.logger ?? cfg.env !== 'test' ? { level: cfg.env === 'prod' ? 'info' : 'warn', redact: ['req.headers.authorization', 'req.headers["x-api-key"]'] } : false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: cfg.env === 'prod',
  });

  // ---------- security headers ----------
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    if (cfg.env === 'prod') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (cfg.corsOrigin) {
      reply.header('access-control-allow-origin', cfg.corsOrigin);
      reply.header('access-control-allow-headers', 'authorization, content-type, x-api-key');
      reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
  });
  if (cfg.corsOrigin) app.options('/*', async (_req, reply) => reply.code(204).send());

  await app.register(rateLimit, { global: true, max: cfg.rateLimitMax, timeWindow: '1 minute' });
  await app.register(jwt, { secret: cfg.jwtSecret, sign: { expiresIn: cfg.jwtTtl } });

  // ---------- errors: stable, non-leaky shape ----------
  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof MxpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: err.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '), details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. Quote the request id when reporting it.', requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } });
    return reply.code(404).send('Not found');
  });

  // ---------- authentication ----------
  const PUBLIC = new Set(['/api/health', '/api/ready', '/api/auth/login']);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC.has(path) || req.method === 'OPTIONS') return;
    const key = req.headers['x-api-key'];
    if (path === '/api/ingest' && typeof key === 'string') {
      const h = createHash('sha256').update(key).digest('hex');
      const client = db.get<any>('SELECT * FROM api_client WHERE key_hash = ? AND active = 1', h);
      if (!client) return reply.code(401).send({ error: { code: 'BAD_API_KEY', message: 'Invalid API key.' } });
      (req as any).apiClient = { clientId: client.client_id, sourceSystem: client.source_system };
      return;
    }
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    }
  });

  await app.register(async (api) => {
    authRoutes(api, ctx);
    ruleRoutes(api, ctx);
    reportRoutes(api, ctx);
    opsRoutes(api, ctx);
    adminRoutes(api, ctx);
    simRoutes(api, ctx);
  }, { prefix: '/api' });

  // ---------- static web apps (built by `npm run build`) ----------
  const dist = resolve(cfg.webDist);
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, wildcard: false, cacheControl: false, setHeaders: (res: any, path: string) => {
      // @fastify/static >= 10 passes the Fastify reply; older versions pass the raw response.
      const value = path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      if (typeof res.header === 'function') res.header('cache-control', value);
      else res.setHeader('cache-control', value);
    } });
    app.get('/testing', async (_req, reply) => reply.redirect('/testing/'));
    app.get('/testing/*', async (req, reply) => {
      const file = (req.params as any)['*'];
      return reply.sendFile(file && existsSync(resolve(dist, 'testing', file)) ? `testing/${file}` : 'testing/index.html');
    });
    app.get('/*', async (req, reply) => {
      const file = (req.params as any)['*'];
      return reply.sendFile(file && !file.includes('..') && existsSync(resolve(dist, file)) ? file : 'index.html');
    });
  }

  return { app, ctx };
}

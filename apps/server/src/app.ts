import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { Mxp, MxpError } from '@mxp/platform';
import { RulePackError } from '@mxp/rules';
import { loadConfig, type Config } from './config';
import { authRoutes } from './routes/auth';
import { catalogRoutes } from './routes/catalog';
import { customerRoutes } from './routes/customers';
import { reportRoutes } from './routes/reports';
import { testingRoutes } from './routes/testing';

export interface AppCtx {
  cfg: Config;
  mx: Mxp;
}

export interface BuildOptions {
  cfg?: Partial<Config>;
  mx?: Mxp;
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppCtx }> {
  const cfg: Config = { ...loadConfig(), ...(opts.cfg ?? {}) };
  const mx = opts.mx ?? Mxp.open(cfg.dbPath);
  const ctx: AppCtx = { cfg, mx };

  const app = Fastify({
    logger: opts.logger ?? cfg.env !== 'test' ? { level: cfg.env === 'prod' ? 'info' : 'warn', redact: ['req.headers.authorization'] } : false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: cfg.env === 'prod',
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    if (cfg.env === 'prod') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (cfg.corsOrigin) {
      reply.header('access-control-allow-origin', cfg.corsOrigin);
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
  });
  if (cfg.corsOrigin) app.options('/*', async (_req, reply) => reply.code(204).send());

  await app.register(rateLimit, { global: true, max: cfg.rateLimitMax, timeWindow: '1 minute' });
  await app.register(jwt, { secret: cfg.jwtSecret, sign: { expiresIn: cfg.jwtTtl } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof MxpError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof RulePackError) return reply.code(422).send({ error: { code: 'INVALID_PACK', message: err.message, details: err.issues } });
    if (err instanceof ZodError) {
      return reply.code(422).send({ error: { code: 'VALIDATION', message: err.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '), details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
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

  const PUBLIC = new Set(['/api/health', '/api/ready', '/api/auth/login']);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || PUBLIC.has(path) || req.method === 'OPTIONS') return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    }
  });

  await app.register(async (api) => {
    authRoutes(api, ctx);
    catalogRoutes(api, ctx);
    customerRoutes(api, ctx);
    reportRoutes(api, ctx);
    testingRoutes(api, ctx);
  }, { prefix: '/api' });

  // Built web apps: admin console at /, testing app at /testing/.
  const dist = resolve(cfg.webDist);
  if (existsSync(dist)) {
    await app.register(fastifyStatic, {
      root: dist, wildcard: false, cacheControl: false,
      setHeaders: (res: any, path: string) => {
        const value = path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
        if (typeof res.header === 'function') res.header('cache-control', value);
        else res.setHeader('cache-control', value);
      },
    });
    app.get('/testing', async (_req, reply) => reply.redirect('/testing/'));
    app.get('/testing/*', async (req, reply) => {
      const file = (req.params as any)['*'];
      return reply.sendFile(file && !file.includes('..') && existsSync(resolve(dist, 'testing', file)) ? `testing/${file}` : 'testing/index.html');
    });
    app.get('/*', async (req, reply) => {
      const file = (req.params as any)['*'];
      return reply.sendFile(file && !file.includes('..') && existsSync(resolve(dist, file)) ? file : 'index.html');
    });
  }

  return { app, ctx };
}

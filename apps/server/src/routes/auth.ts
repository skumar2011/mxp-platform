import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, permissionsFor } from '@mxp/platform';
import type { AppCtx } from '../app';
import { need, parse, userOf } from '../util';

export function authRoutes(app: FastifyInstance, { cfg, mx }: AppCtx) {
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok', env: cfg.env, time: mx.clock.now().toISOString() }));

  app.get('/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      mx.db.value('SELECT 1');
      return { status: 'ready', env: cfg.env, release: mx.catalog.currentRelease()?.version_label ?? null };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }), req.body);
    const u = mx.login(body.username, body.password);
    const token = app.jwt.sign({ sub: u.username, name: u.displayName, roles: u.roles });
    return { token, user: { username: u.username, name: u.displayName, roles: u.roles, permissions: u.permissions }, env: cfg.env };
  });

  app.get('/auth/me', async (req) => {
    const u = userOf(req);
    return { user: { ...u, permissions: permissionsFor(u.roles) }, env: cfg.env };
  });

  app.post('/auth/logout', async (req) => {
    const u = userOf(req);
    audit(mx.db, mx.clock, u.username, 'LOGOUT', 'app_user', u.username);
    return { ok: true };
  });

  app.post('/auth/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = userOf(req);
    const body = parse(z.object({ current: z.string().min(1).max(200), password: z.string().min(1).max(200) }), req.body);
    mx.changePassword(u.username, body.current, body.password);
    return { ok: true };
  });

  app.get('/users', async (req) => {
    need(req, 'users:admin');
    return mx.users();
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MxpError, audit, hashPassword, verifyPassword, can, PERMISSIONS } from '@mxp/engine';
import type { AppCtx } from '../context';
import { parse, userOf } from '../util';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// Pre-computed so unknown users cost the same as known ones (no user enumeration by timing).
const DUMMY_HASH = hashPassword('not-a-real-password');

export function authRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db, clock } = ctx;

  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok', time: clock.now().toISOString() }));

  app.get('/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      db.value('SELECT 1');
      ctx.sim.value('SELECT 1');
      return { status: 'ready', env: ctx.cfg.env };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }), req.body);
    const user = db.get<any>('SELECT * FROM app_user WHERE username = ?', body.username);
    const now = clock.now();
    const fail = (reason: string, uname: string) => {
      audit(db, clock, { username: uname, roles: [] }, 'LOGIN_FAILED', 'app_user', uname, null, null, reason);
      return new MxpError('BAD_CREDENTIALS', 'Incorrect username or password.', 401);
    };
    if (!user) {
      verifyPassword(body.password, DUMMY_HASH);
      throw fail('unknown user', body.username.slice(0, 64));
    }
    if (!user.active) throw fail('inactive user', user.username);
    if (user.locked_until && user.locked_until > now.toISOString()) {
      throw new MxpError('LOCKED', 'This account is temporarily locked after repeated failed sign-ins. Try again later.', 423);
    }
    if (!verifyPassword(body.password, user.password_hash)) {
      const fails = user.failed_logins + 1;
      const lock = fails >= MAX_FAILS ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      db.run('UPDATE app_user SET failed_logins = ?, locked_until = ? WHERE user_id = ?', lock ? 0 : fails, lock, user.user_id);
      throw fail(lock ? 'locked after repeated failures' : 'bad password', user.username);
    }
    db.run('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE user_id = ?', user.user_id);
    const roles = db.all<{ role_code: string }>('SELECT role_code FROM user_role WHERE user_id = ?', user.user_id).map((r) => r.role_code);
    audit(db, clock, { username: user.username, roles }, 'LOGIN', 'app_user', user.username, null, null);
    const token = app.jwt.sign({ sub: user.username, name: user.display_name, roles });
    return { token, user: { username: user.username, name: user.display_name, roles, permissions: permissionsFor(roles) }, env: ctx.cfg.env };
  });

  app.get('/auth/me', async (req) => {
    const u = userOf(req);
    return { user: { ...u, permissions: permissionsFor(u.roles) }, env: ctx.cfg.env };
  });

  app.post('/auth/logout', async (req) => {
    const u = userOf(req);
    audit(db, clock, { username: u.username, roles: u.roles }, 'LOGOUT', 'app_user', u.username, null, null);
    return { ok: true };
  });
}

export const permissionsFor = (roles: string[]) => Object.keys(PERMISSIONS).filter((p) => can(roles, p));

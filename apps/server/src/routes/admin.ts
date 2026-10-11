import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_CONFIG, MxpError, ROLES, audit, hashPassword, loadConfig, seedCustomers, uid, verifyPassword } from '@mxp/engine';
import type { AppCtx } from '../context';
import { need, parse, userOf } from '../util';

const password = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Use upper case, lower case and a digit.');

export function adminRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db, clock, engine } = ctx;
  const roleEnum = z.enum(ROLES);

  const userRows = () =>
    db.all<any>('SELECT user_id, username, display_name, active, locked_until, created_at FROM app_user ORDER BY username').map((u) => ({
      username: u.username,
      name: u.display_name,
      active: !!u.active,
      lockedUntil: u.locked_until,
      createdAt: u.created_at,
      roles: db.all<any>('SELECT role_code FROM user_role WHERE user_id = ? ORDER BY role_code', u.user_id).map((r) => r.role_code),
    }));

  app.get('/admin/users', async (req) => {
    need(req, 'users:admin');
    return { users: userRows() };
  });

  app.post('/admin/users', async (req, reply) => {
    const actor = need(req, 'users:admin');
    const b = parse(z.object({ username: z.string().regex(/^[a-z][a-z0-9._-]{2,31}$/, 'Use 3-32 lower-case letters, digits, dot, dash or underscore.'), name: z.string().min(2).max(80), roles: z.array(roleEnum).min(1), password }), req.body);
    if (db.get('SELECT 1 FROM app_user WHERE username = ?', b.username)) throw new MxpError('DUPLICATE', 'That username already exists.', 409);
    const id = uid();
    db.tx(() => {
      db.run('INSERT INTO app_user(user_id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)', id, b.username, b.name, hashPassword(b.password), clock.now().toISOString());
      for (const r of new Set(b.roles)) db.run('INSERT INTO user_role(user_id, role_code) VALUES (?,?)', id, r);
      audit(db, clock, actor, 'USER_CREATE', 'app_user', b.username, null, { roles: b.roles, name: b.name });
    });
    return reply.code(201).send({ users: userRows() });
  });

  app.patch('/admin/users/:username', async (req) => {
    const actor = need(req, 'users:admin');
    const { username } = req.params as any;
    const b = parse(z.object({ roles: z.array(roleEnum).min(1).optional(), active: z.boolean().optional(), unlock: z.boolean().optional(), name: z.string().min(2).max(80).optional() }), req.body);
    const u = db.get<any>('SELECT * FROM app_user WHERE username = ?', username);
    if (!u) throw new MxpError('NOT_FOUND', 'User not found.', 404);
    const self = userOf(req).username === username;
    if (self && (b.active === false || (b.roles && !b.roles.includes('SYSTEM_ADMIN')))) throw new MxpError('SELF_LOCKOUT', 'You cannot disable or demote your own account.', 409);
    db.tx(() => {
      const before = { roles: db.all<any>('SELECT role_code FROM user_role WHERE user_id = ?', u.user_id).map((r) => r.role_code), active: !!u.active };
      if (b.roles) {
        db.run('DELETE FROM user_role WHERE user_id = ?', u.user_id);
        for (const r of new Set(b.roles)) db.run('INSERT INTO user_role(user_id, role_code) VALUES (?,?)', u.user_id, r);
      }
      if (b.active !== undefined) db.run('UPDATE app_user SET active = ? WHERE user_id = ?', b.active ? 1 : 0, u.user_id);
      if (b.unlock) db.run('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE user_id = ?', u.user_id);
      if (b.name) db.run('UPDATE app_user SET display_name = ? WHERE user_id = ?', b.name, u.user_id);
      audit(db, clock, actor, 'USER_UPDATE', 'app_user', username, before, { roles: b.roles, active: b.active, unlock: b.unlock });
    });
    return { users: userRows() };
  });

  app.post('/admin/users/:username/password', async (req) => {
    const actor = need(req, 'users:admin');
    const { username } = req.params as any;
    const b = parse(z.object({ password }), req.body);
    const u = db.get<any>('SELECT user_id FROM app_user WHERE username = ?', username);
    if (!u) throw new MxpError('NOT_FOUND', 'User not found.', 404);
    db.run('UPDATE app_user SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE user_id = ?', hashPassword(b.password), u.user_id);
    audit(db, clock, actor, 'USER_PASSWORD_RESET', 'app_user', username, null, null);
    return { ok: true };
  });

  // Users change their own password (needs the current one).
  app.post('/auth/password', async (req) => {
    const me = userOf(req);
    const b = parse(z.object({ current: z.string().min(1), password }), req.body);
    const u = db.get<any>('SELECT * FROM app_user WHERE username = ?', me.username)!;
    if (!verifyPassword(b.current, u.password_hash)) throw new MxpError('BAD_CREDENTIALS', 'Current password is incorrect.', 401);
    db.run('UPDATE app_user SET password_hash = ? WHERE user_id = ?', hashPassword(b.password), u.user_id);
    audit(db, clock, { username: me.username, roles: me.roles }, 'PASSWORD_CHANGE', 'app_user', me.username, null, null);
    return { ok: true };
  });

  // ---------- API clients (source systems) ----------
  app.get('/admin/clients', async (req) => {
    need(req, 'users:admin');
    return { clients: db.all('SELECT client_id AS clientId, source_system AS sourceSystem, scopes, active, created_at AS createdAt FROM api_client ORDER BY created_at DESC') };
  });
  app.post('/admin/clients', async (req, reply) => {
    const actor = need(req, 'users:admin');
    const b = parse(z.object({ sourceSystem: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'Use capital letters, digits and underscore.') }), req.body);
    const key = `mxp_${randomBytes(24).toString('base64url')}`;
    const id = uid();
    db.tx(() => {
      db.run('INSERT INTO api_client(client_id, source_system, key_hash, scopes, created_at) VALUES (?,?,?,?,?)', id, b.sourceSystem, createHash('sha256').update(key).digest('hex'), 'ingest', clock.now().toISOString());
      audit(db, clock, actor, 'API_CLIENT_CREATE', 'api_client', id, null, { sourceSystem: b.sourceSystem });
    });
    // The key is shown once and only its hash is stored.
    return reply.code(201).send({ clientId: id, sourceSystem: b.sourceSystem, apiKey: key, note: 'Store this key now. It cannot be shown again.' });
  });
  app.delete('/admin/clients/:id', async (req) => {
    const actor = need(req, 'users:admin');
    const { id } = req.params as any;
    const r = db.run('UPDATE api_client SET active = 0 WHERE client_id = ?', id);
    if (!r.changes) throw new MxpError('NOT_FOUND', 'Client not found.', 404);
    audit(db, clock, actor, 'API_CLIENT_REVOKE', 'api_client', id, null, null);
    return { ok: true };
  });

  // ---------- engine configuration ----------
  const cfgSchema = z.object({
    maxAttempts: z.number().int().min(1).max(20),
    retryBaseSeconds: z.number().int().min(1).max(3600),
    futureToleranceMinutes: z.number().int().min(0).max(1440),
    storeTrace: z.boolean(),
    nudge: z.object({ approvedChannels: z.array(z.enum(['PUSH', 'IN_APP', 'SMS', 'EMAIL', 'WHATSAPP'])).min(1), defaultChannel: z.enum(['PUSH', 'IN_APP', 'SMS', 'EMAIL', 'WHATSAPP']), dailyProgressCap: z.number().int().min(0).max(20) }),
  });
  app.get('/admin/config', async (req) => {
    need(req, 'rules:read');
    return { config: engine.ctx.config, defaults: DEFAULT_CONFIG };
  });
  /**
   * Customer / account / instrument master import. In production this master is owned by the core and CRM systems;
   * this endpoint loads the subset MXP needs (masked name, consent, segments, accounts, instruments). Existing customers are skipped.
   */
  app.post('/admin/customers/import', async (req, reply) => {
    const actor = need(req, 'users:admin');
    const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, 'Use letters, digits and . _ : - only.');
    const b = parse(
      z.object({
        customers: z
          .array(
            z.object({
              ref, name: z.string().min(1).max(80), segments: z.array(z.string()).default([]), consent: z.boolean().optional(),
              accounts: z.array(z.object({ ref, product: z.string(), type: z.string(), openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })).default([]),
              instruments: z.array(z.object({ ref, type: z.string(), account: z.string().optional(), product: z.string().optional() })).default([]),
            }),
          )
          .min(1)
          .max(5000),
      }),
      req.body,
    );
    const problems: string[] = [];
    const known = (sql: string, v: string) => !!db.get(sql, v);
    for (const c of b.customers) {
      for (const s of c.segments) if (!known('SELECT 1 FROM segment WHERE segment_code = ?', s)) problems.push(`${c.ref}: unknown segment ${s}`);
      for (const a of c.accounts) if (!known('SELECT 1 FROM product_ref WHERE product_code = ?', a.product)) problems.push(`${c.ref}/${a.ref}: unknown product ${a.product}`);
      for (const i of c.instruments) {
        if (i.product && !known('SELECT 1 FROM product_ref WHERE product_code = ?', i.product)) problems.push(`${c.ref}/${i.ref}: unknown product ${i.product}`);
        if (i.account && !c.accounts.some((a) => a.ref === i.account)) problems.push(`${c.ref}/${i.ref}: account ${i.account} is not one of the customer's accounts`);
      }
    }
    if (problems.length) throw new MxpError('VALIDATION', 'The import contains unknown reference data.', 422, problems.slice(0, 20));
    const before = db.value<number>('SELECT COUNT(*) FROM customer') ?? 0;
    db.tx(() => {
      seedCustomers(db, clock, b.customers);
      audit(db, clock, actor, 'CUSTOMER_IMPORT', 'customer', 'bulk', null, { submitted: b.customers.length });
    });
    const created = (db.value<number>('SELECT COUNT(*) FROM customer') ?? 0) - before;
    return reply.code(201).send({ submitted: b.customers.length, created, skipped: b.customers.length - created });
  });

  app.put('/admin/config', async (req) => {
    const actor = need(req, 'users:admin');
    const b = parse(cfgSchema, req.body);
    if (!b.nudge.approvedChannels.includes(b.nudge.defaultChannel)) throw new MxpError('VALIDATION', 'The default channel must be one of the approved channels.', 422);
    const before = loadConfig(db);
    db.tx(() => {
      db.run(
        `INSERT INTO system_config(config_key, value_json, updated_by, updated_at) VALUES ('engine.config', ?, ?, ?)
         ON CONFLICT(config_key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        JSON.stringify(b), actor.username, clock.now().toISOString(),
      );
      audit(db, clock, actor, 'CONFIG_UPDATE', 'system_config', 'engine.config', before, b);
    });
    Object.assign(engine.ctx.config, b, { nudge: b.nudge });
    return { config: engine.ctx.config };
  });
}

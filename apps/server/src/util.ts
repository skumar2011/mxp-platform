import type { FastifyReply, FastifyRequest } from 'fastify';
import { MxpError, can, type Actor } from '@mxp/engine';
import { z, type ZodTypeAny } from 'zod';

export interface AuthUser {
  username: string;
  name: string;
  roles: string[];
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; name: string; roles: string[] };
    user: { sub: string; name: string; roles: string[] };
  }
}

export const userOf = (req: FastifyRequest): AuthUser => {
  const u = (req as any).user as { sub: string; name: string; roles: string[] } | undefined;
  if (!u) throw new MxpError('UNAUTHENTICATED', 'Sign in to continue.', 401);
  return { username: u.sub, name: u.name, roles: u.roles };
};

export const actorOf = (req: FastifyRequest): Actor => {
  const u = userOf(req);
  return { username: u.username, roles: u.roles };
};

/** Throws 403 unless the signed-in user holds the permission. */
export function need(req: FastifyRequest, permission: string): Actor {
  const u = userOf(req);
  if (!can(u.roles, permission)) throw new MxpError('FORBIDDEN', `Your role does not allow this action (${permission}).`, 403);
  return { username: u.username, roles: u.roles };
}

export function parse<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new MxpError(
      'VALIDATION',
      r.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).slice(0, 5).join('; '),
      422,
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const page = (q: any, max = 500) => ({
  limit: Math.min(Math.max(parseInt(q?.limit ?? '50', 10) || 50, 1), max),
  offset: Math.max(parseInt(q?.offset ?? '0', 10) || 0, 0),
});

export interface Where {
  sql: string;
  params: (string | number)[];
}

/** Small helper to assemble optional filters safely (values are always bound, never concatenated). */
export function where(parts: [string | undefined | null | false, string, ...(string | number)[]][]): Where {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  for (const [val, sql, ...ps] of parts) {
    if (val === undefined || val === null || val === '' || val === false) continue;
    conds.push(sql);
    params.push(...(ps.length ? ps : [val as string]));
  }
  return { sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/** CSV with protection against spreadsheet formula injection. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

export function sendCsv(reply: FastifyReply, name: string, csv: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`)
    .send(csv);
}

export function sendJsonDownload(reply: FastifyReply, name: string, body: unknown) {
  return reply
    .header('content-type', 'application/json; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`)
    .send(JSON.stringify(body, null, 2));
}

export const major = (minor: number | null | undefined) => (minor === null || minor === undefined ? null : minor / 100);

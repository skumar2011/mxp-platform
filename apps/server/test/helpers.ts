import type { FastifyInstance } from 'fastify';
import { FixedClock, openDb, openSimStore, seedAll, DEMO_USERS, type Db } from '@mxp/engine';
import { buildApp } from '../src/app';
import type { AppCtx } from '../src/context';

export const NOW = new Date('2026-10-10T09:00:00Z');

export interface TestApp {
  app: FastifyInstance;
  ctx: AppCtx;
  db: Db;
  clock: FixedClock;
  /** Signs a token for a demo user (the login flow itself is covered separately). */
  token(username: string): string;
  call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, as?: string | null, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any; text: string; headers: Record<string, any> }>;
}

/** A complete app on in-memory databases with the demo data, a fixed clock and no background worker. */
export async function makeApp(opts: { seed?: boolean; rateLimitMax?: number } = {}): Promise<TestApp> {
  const db = openDb(':memory:');
  if (opts.seed !== false) seedAll(db, NOW);
  const clock = new FixedClock(NOW);
  const { app, ctx } = await buildApp({
    db,
    sim: openSimStore(':memory:'),
    clock,
    cfg: { env: 'test', worker: false, jwtSecret: 'test-secret-test-secret-test-secret', rateLimitMax: opts.rateLimitMax ?? 100000, webDist: '/nonexistent' },
  });
  const token = (username: string) => {
    const u = DEMO_USERS.find((x) => x.username === username);
    if (!u) throw new Error(`no demo user ${username}`);
    return app.jwt.sign({ sub: u.username, name: u.name, roles: u.roles });
  };
  const call: TestApp['call'] = async (method, url, as = null, body, headers = {}) => {
    const res = await app.inject({
      method, url, headers: { ...(as ? { authorization: `Bearer ${token(as)}` } : {}), ...headers },
      ...(body !== undefined ? { payload: body as any } : {}),
    });
    let json: any = null;
    try { json = res.body ? JSON.parse(res.body) : null; } catch { /* not json */ }
    return { status: res.statusCode, json, text: res.body, headers: res.headers };
  };
  return { app, ctx, db, clock, token, call };
}

export const leaf = (field: string, operator: string, value?: unknown) => ({ type: 'condition', field, operator, value });
export const AND = (...children: unknown[]) => ({ type: 'group', op: 'AND', negate: false, children });

/** A small goal rule: ₹2,000 of card spend in a month earns 40 XP. */
export const spend2kRule = () => ({
  name: 'Card spend of ₹2,000 in a month', description: 'Spend ₹2,000 on a credit card.', businessObjective: 'Card engagement', category: 'SPEND', campaignCode: 'MXP_ALWAYS_ON', kind: 'GOAL',
  scope: { channels: ['CARD_POS', 'CARD_ONLINE'], productCodes: [] },
  eligibility: AND(leaf('customer.status', 'EQ', 'ACTIVE')),
  qualifying: AND(leaf('txn.type', 'EQ', 'PURCHASE'), leaf('txn.dr_cr', 'EQ', 'D'), leaf('txn.instrument_type', 'EQ', 'CREDIT_CARD')),
  metric: { type: 'SUM', operator: 'GTE' }, period: { type: 'MONTHLY', timezone: 'Asia/Kolkata' },
  tiers: [{ label: '₹2K', threshold: 2000, points: 40 }], priority: 100,
  effective: { from: '2026-09-01', to: null },
});

export const cardEvent = (id: string, amount: number, ts: string, extra: Record<string, unknown> = {}, source = 'CARDS') => ({
  eventType: 'TRANSACTION', sourceSystem: source, sourceEventId: `${id}:POSTED`,
  transaction: { sourceTxnId: id, customerRef: 'CUST-1001', accountRef: 'CCA-1001', instrumentRef: 'CARD-1001', txnType: 'PURCHASE', categoryCode: 'SHOPPING', channel: 'CARD_ONLINE', amount, currency: 'INR', drCr: 'D', status: 'POSTED', txnTimestamp: ts, ...extra },
});

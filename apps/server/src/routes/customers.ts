import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../app';
import { need, page, parse, str } from '../util';

const eventSchema = z
  .object({
    sourceSystem: z.string().max(40).optional(),
    sourceEventId: z.string().max(120).optional(),
    type: z.string().min(1).max(40),
    customerId: z.string().min(1).max(64),
    accountId: z.string().max(64).nullable().optional(),
    timestamp: z.string().min(10).max(40),
    reversalOf: z.string().max(120).nullable().optional(),
  })
  .passthrough();

export function customerRoutes(app: FastifyInstance, { mx }: AppCtx) {
  const P = mx.participation;

  app.get('/customers', async (req) => {
    need(req, 'customers:read');
    const q = req.query as any;
    return mx.queries.customers({ q: str(q.q), segment: str(q.segment), ...page(q) });
  });
  app.post('/customers', async (req) => {
    const actor = need(req, 'customers:write');
    const body = parse(
      z.object({
        customerRef: z.string().min(3).max(40),
        displayName: z.string().min(1).max(80),
        segment: z.string().min(1),
        timezone: z.string().max(60).optional(),
        dormancyRisk: z.boolean().optional(),
        accounts: z.array(z.object({ accountRef: z.string().min(3).max(40), accountType: z.string(), productFamily: z.string(), openedOn: z.string() })).max(20).optional(),
      }),
      req.body,
    );
    if (body.timezone) new Intl.DateTimeFormat('en', { timeZone: body.timezone }); // throws on an invalid zone
    return { customerId: P.createCustomer(body, actor) };
  });
  app.get('/customers/:id', async (req) => {
    need(req, 'customers:read');
    return mx.queries.customer360((req.params as any).id);
  });
  app.patch('/customers/:id', async (req) => {
    const actor = need(req, 'customers:write');
    const body = parse(z.object({ segment: z.string().optional(), timezone: z.string().optional(), dormancyRisk: z.boolean().optional() }), req.body);
    P.updateCustomer((req.params as any).id, body, actor);
    return { ok: true };
  });

  // ---------- spend controls: customer-set values ----------
  app.get('/customers/:id/offers', async (req) => {
    need(req, 'customers:read');
    return P.offers((req.params as any).id);
  });
  app.put('/customers/:id/controls/:rule', async (req) => {
    const actor = need(req, 'customers:write');
    const { id, rule } = req.params as any;
    const body = parse(z.object({ values: z.record(z.unknown()), reason: z.string().max(200).optional(), via: z.enum(['APP', 'BRANCH', 'ADMIN']).optional() }), req.body);
    return P.setControl(id, rule, body.values, actor, { via: body.via ?? 'ADMIN', reason: body.reason });
  });
  app.delete('/customers/:id/controls/:rule', async (req) => {
    const actor = need(req, 'customers:write');
    const { id, rule } = req.params as any;
    P.cancelControl(id, rule, actor, (req.query as any).reason);
    return { ok: true };
  });
  app.post('/customers/:id/missions/:rule/enroll', async (req) => {
    const actor = need(req, 'customers:write');
    const { id, rule } = req.params as any;
    P.enroll(id, rule, actor, 'ADMIN');
    return { ok: true };
  });
  app.post('/customers/:id/missions/:rule/opt-out', async (req) => {
    const actor = need(req, 'customers:write');
    const { id, rule } = req.params as any;
    P.optOut(id, rule, actor);
    return { ok: true };
  });
  app.post('/customers/:id/points/adjust', async (req) => {
    const actor = need(req, 'ops:run');
    const body = parse(z.object({ points: z.number().int(), reason: z.string().min(5).max(200) }), req.body);
    mx.runtime.adjust((req.params as any).id, body.points, body.reason, actor);
    return { ok: true };
  });

  // ---------- runtime ----------
  app.post('/events', async (req) => {
    const actor = need(req, 'events:write');
    return mx.runtime.ingest(parse(eventSchema, req.body), actor);
  });
  app.post('/events/batch', async (req) => {
    const actor = need(req, 'events:write');
    const body = parse(z.object({ events: z.array(eventSchema).min(1).max(1000) }), req.body);
    const results = body.events.map((e) => {
      try {
        const r = mx.runtime.ingest(e, actor);
        return { eventId: r.eventId, status: r.status, duplicate: r.duplicate, points: r.points, decision: r.decision, error: r.error };
      } catch (x) {
        return { status: 'REJECTED', error: (x as Error).message };
      }
    });
    return { results, processed: results.filter((r) => r.status === 'PROCESSED').length };
  });
  /** Real-time pre-authorisation decision (spend controls). Nothing is posted. */
  app.post('/controls/check', async (req) => {
    need(req, 'events:write');
    return mx.runtime.check(parse(eventSchema.extend({ requestId: z.string().max(80).optional() }), req.body));
  });
  app.post('/ops/close-windows', async (req) => {
    const actor = need(req, 'ops:run');
    const body = parse(z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.body ?? {});
    const r = mx.runtime.closeWindows(actor, body.asOf);
    return { asOf: r.asOf, closed: r.closed, points: r.points, evaluations: r.evaluations.slice(0, 200) };
  });
  app.get('/ops/reconcile', async (req) => {
    need(req, 'ops:run');
    return { mismatches: mx.runtime.reconcile(), audit: mx.verifyAudit() };
  });
}

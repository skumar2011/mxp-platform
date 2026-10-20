import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../app';
import { need, parse } from '../util';

/**
 * The testing app runs @mxp/rules in the browser against a pack fetched from
 * /packs/preview; the server only stores scenarios and run results.
 */
export function testingRoutes(app: FastifyInstance, { mx }: AppCtx) {
  const T = mx.tests;

  app.get('/test-scenarios', async (req) => {
    need(req, 'rules:read');
    return T.list();
  });
  app.get('/test-scenarios/:id', async (req) => {
    need(req, 'rules:read');
    return T.get((req.params as any).id);
  });
  app.post('/test-scenarios', async (req) => {
    const actor = need(req, 'tests:write');
    const body = parse(z.object({ scenario: z.object({ id: z.string().max(80).optional(), name: z.string().min(3).max(120), description: z.string().max(500).optional(), focusRule: z.string().optional(), tags: z.array(z.string().max(40)).max(10).optional(), steps: z.array(z.unknown()).min(1).max(500) }).passthrough() }), req.body);
    return T.save(body.scenario, actor);
  });
  app.delete('/test-scenarios/:id', async (req) => {
    const actor = need(req, 'tests:write');
    T.remove((req.params as any).id, actor);
    return { ok: true };
  });
  app.get('/test-runs', async (req) => {
    need(req, 'rules:read');
    return T.runs();
  });
  app.post('/test-runs', async (req) => {
    const actor = need(req, 'tests:write');
    const body = parse(z.object({
      kind: z.enum(['SCENARIO', 'SUITE', 'MATRIX']),
      packSource: z.string().max(20),
      packHash: z.string().max(80).optional(),
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      scenarioId: z.string().optional(),
      results: z.array(z.object({ scenarioId: z.string().optional(), name: z.string().optional(), passed: z.boolean(), failures: z.array(z.string()).optional() })).max(2000),
    }), req.body);
    return T.recordRun(body, actor);
  });
}

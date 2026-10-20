import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../app';
import { need, page, sendCsv, str, toCsv } from '../util';

export function reportRoutes(app: FastifyInstance, { mx }: AppCtx) {
  const Q = mx.queries;

  app.get('/dashboard', async (req) => {
    need(req, 'rules:read');
    return Q.dashboard();
  });

  const list = <T extends Record<string, unknown>>(path: string, perm: string, fn: (q: any) => T[], csvCols?: string[]) =>
    app.get(path, async (req, reply) => {
      need(req, perm);
      const q = req.query as any;
      const rows = fn({ ...q, ...page(q, q.format === 'csv' ? 5000 : 500) });
      if (q.format === 'csv' && csvCols) return sendCsv(reply, `${path.slice(1).replace(/\//g, '-')}.csv`, toCsv(csvCols, rows));
      return rows;
    });

  list('/evaluations', 'customers:read', (q) => Q.evaluations({ customerId: str(q.customerId), ruleCode: str(q.ruleCode), outcome: str(q.outcome), family: str(q.family), eventId: str(q.eventId), limit: q.limit, offset: q.offset }),
    ['evaluated_at', 'occurred_at', 'customer_id', 'rule_code', 'rule_version_no', 'family', 'window_key', 'outcome', 'decision', 'measure_before', 'measure_after', 'target_value', 'points', 'message']);
  list('/ledger', 'customers:read', (q) => Q.ledger({ customerId: str(q.customerId), ruleCode: str(q.ruleCode), entryType: str(q.entryType), limit: q.limit, offset: q.offset }),
    ['ledger_id', 'earned_on', 'created_at', 'customer_id', 'entry_type', 'points', 'family', 'rule_code', 'window_key', 'slot', 'event_id', 'reason', 'created_by']);
  list('/breaches', 'customers:read', (q) => Q.breaches({ customerId: str(q.customerId), ruleCode: str(q.ruleCode), limit: q.limit, offset: q.offset }),
    ['occurred_at', 'recorded_at', 'customer_id', 'rule_code', 'window_key', 'limit_value', 'measured_value', 'action', 'event_id']);
  list('/decisions', 'customers:read', (q) => Q.decisions({ customerId: str(q.customerId), decision: str(q.decision), limit: q.limit, offset: q.offset }));
  list('/nudges', 'customers:read', (q) => Q.nudges({ customerId: str(q.customerId), kind: str(q.kind), limit: q.limit, offset: q.offset }));
  list('/events', 'customers:read', (q) => Q.events({ customerId: str(q.customerId), type: str(q.type), status: str(q.status), limit: q.limit, offset: q.offset }));
  list('/windows', 'customers:read', (q) => Q.windows({ customerId: str(q.customerId), ruleCode: str(q.ruleCode), status: str(q.status), family: str(q.family), limit: q.limit, offset: q.offset }),
    ['window_key', 'rule_code', 'customer_id', 'status', 'outcome', 'measure_value', 'target_value', 'activity_count', 'breach_count', 'points_awarded']);
  list('/audit', 'audit:read', (q) => Q.auditLog({ entityType: str(q.entityType), entityId: str(q.entityId), actor: str(q.actor), limit: q.limit, offset: q.offset }),
    ['audit_id', 'occurred_at', 'actor', 'action', 'entity_type', 'entity_id', 'hash']);

  app.get('/windows/detail', async (req) => {
    need(req, 'customers:read');
    return Q.windowDetail(String((req.query as any).key ?? ''));
  });
  app.get('/audit/verify', async (req) => {
    need(req, 'audit:read');
    return mx.verifyAudit();
  });
}

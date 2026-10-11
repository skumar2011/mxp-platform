import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  FIELD_CATALOG, OPERATORS, OPERATOR_LABELS, OPERATORS_BY_TYPE, ACCOUNT_TYPES, TXN_STATUSES, METRIC_TYPES, PERIOD_TYPES, CONFLICT_POLICIES, RULE_CATEGORIES, ROLES,
  MxpError, RULE_CODE_RE, approve, createCampaign, createRule, createVersion, diffDefinitions, getCampaign, getVersion, listCampaigns, listRules, listVersions,
  normalizeDefinition, pause, reject, resume, retire, setCampaignStatus, submitForApproval, updateCampaign, updateDraft, validateDefinition, validateVersion,
} from '@mxp/engine';
import type { AppCtx } from '../context';
import { actorOf, need, parse } from '../util';

const code = z.string().regex(RULE_CODE_RE, 'Use 3-40 characters: capital letters, digits and underscore, starting with a letter.');
const vno = z.coerce.number().int().min(1);

export function ruleRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db, engine } = ctx;
  const ec = engine.ctx;

  // ---------- reference / metadata for the builders ----------
  app.get('/meta', async () => ({
    env: ctx.cfg.env,
    fields: FIELD_CATALOG,
    operators: OPERATORS.map((o) => ({ code: o, label: OPERATOR_LABELS[o] })),
    operatorsByType: OPERATORS_BY_TYPE,
    accountTypes: ACCOUNT_TYPES,
    txnStatuses: TXN_STATUSES,
    metricTypes: METRIC_TYPES,
    periodTypes: PERIOD_TYPES,
    conflictPolicies: CONFLICT_POLICIES,
    ruleCategories: RULE_CATEGORIES,
    roles: ROLES,
    reference: {
      channels: db.all('SELECT channel_code AS code, name FROM channel_ref ORDER BY channel_code'),
      products: db.all('SELECT product_code AS code, name, product_family AS family FROM product_ref ORDER BY product_code'),
      txnTypes: db.all('SELECT txn_type_code AS code, name, is_reversal AS isReversal FROM txn_type_ref ORDER BY txn_type_code'),
      categories: db.all('SELECT category_code AS code, name FROM txn_category_ref ORDER BY category_code'),
      segments: db.all('SELECT segment_code AS code, name FROM segment ORDER BY segment_code'),
    },
  }));

  // ---------- rules ----------
  app.get('/rules', async (req) => {
    need(req, 'rules:read');
    const issued = new Map(
      db.all<any>(
        `SELECT r.rule_code, COALESCE(SUM(l.points),0) AS points, COUNT(DISTINCT l.customer_id) AS customers
           FROM xp_ledger l JOIN rule r ON r.rule_id = l.rule_id GROUP BY r.rule_code`,
      ).map((x) => [x.rule_code, x]),
    );
    return { rules: listRules(db).map((r) => ({ ...r, pointsIssued: issued.get(r.ruleCode)?.points ?? 0, customersRewarded: issued.get(r.ruleCode)?.customers ?? 0 })) };
  });

  app.post('/rules/validate', async (req) => {
    need(req, 'rules:read');
    const body = parse(z.object({ ruleCode: z.string().optional(), definition: z.unknown() }), req.body);
    try {
      const def = normalizeDefinition(body.definition);
      return validateDefinition(db, def, { ruleCode: body.ruleCode ?? 'UNSAVED', ruleId: db.get<any>('SELECT rule_id FROM rule WHERE rule_code = ?', body.ruleCode ?? '')?.rule_id ?? null });
    } catch (e) {
      if (e instanceof ZodError) {
        const errors = e.issues.map((i) => ({ severity: 'error' as const, code: 'SCHEMA', path: i.path.join('.'), message: i.message }));
        return { valid: false, errors, warnings: [], issues: errors };
      }
      throw e;
    }
  });

  app.post('/rules', async (req, reply) => {
    const actor = need(req, 'rules:write');
    const body = parse(z.object({ code, definition: z.unknown(), changeNote: z.string().max(500).optional() }), req.body);
    const v = createRule(ec, actor, body.code, body.definition, body.changeNote);
    return reply.code(201).send(v);
  });

  app.get('/rules/:code', async (req) => {
    need(req, 'rules:read');
    const { code: c } = req.params as any;
    const versions = listVersions(db, c);
    if (!versions.length) throw new MxpError('NOT_FOUND', `Rule ${c} not found.`, 404);
    return { ruleCode: c, versions };
  });

  app.get('/rules/:code/versions/:v', async (req) => {
    need(req, 'rules:read');
    const { code: c, v } = req.params as any;
    const ver = getVersion(db, c, Number(v));
    if (!ver) throw new MxpError('NOT_FOUND', `Rule ${c} v${v} not found.`, 404);
    const history = db.all(
      `SELECT occurred_at, actor, action, reason, after_json FROM audit_log WHERE entity_type = 'rule_version' AND entity_id = ? ORDER BY audit_id`,
      `${c}@${v}`,
    );
    return { ...ver, history, validation: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(ver.status) ? validateVersion(ec, c, Number(v)) : null };
  });

  app.put('/rules/:code/versions/:v', async (req) => {
    const actor = need(req, 'rules:write');
    const { code: c, v } = req.params as any;
    const body = parse(z.object({ definition: z.unknown(), changeNote: z.string().max(500).optional() }), req.body);
    return updateDraft(ec, actor, c, Number(v), body.definition, body.changeNote);
  });

  app.post('/rules/:code/versions', async (req, reply) => {
    const actor = need(req, 'rules:write');
    const { code: c } = req.params as any;
    const body = parse(z.object({ baseVersionNo: vno.optional(), changeNote: z.string().max(500).optional() }), req.body ?? {});
    return reply.code(201).send(createVersion(ec, actor, c, body.baseVersionNo, body.changeNote));
  });

  app.post('/rules/:code/versions/:v/validate', async (req) => {
    need(req, 'rules:read');
    const { code: c, v } = req.params as any;
    const body = parse(z.object({ activation: z.boolean().optional() }), req.body ?? {});
    return validateVersion(ec, c, Number(v), body.activation ?? false);
  });

  app.post('/rules/:code/versions/:v/submit', async (req) => {
    const actor = need(req, 'rules:write');
    const { code: c, v } = req.params as any;
    return submitForApproval(ec, actor, c, Number(v));
  });

  app.post('/rules/:code/versions/:v/approve', async (req) => {
    const actor = need(req, 'rules:approve');
    const { code: c, v } = req.params as any;
    const body = parse(z.object({ note: z.string().max(500).optional() }), req.body ?? {});
    return approve(ec, actor, c, Number(v), body.note);
  });

  app.post('/rules/:code/versions/:v/reject', async (req) => {
    const actor = need(req, 'rules:approve');
    const { code: c, v } = req.params as any;
    const body = parse(z.object({ reason: z.string().min(5, 'Give the maker a reason (min 5 characters).').max(500) }), req.body);
    return reject(ec, actor, c, Number(v), body.reason);
  });

  app.post('/rules/:code/versions/:v/activate', async (req) => {
    const actor = need(req, 'rules:activate');
    const { code: c, v } = req.params as any;
    const body = parse(z.object({ backfill: z.boolean().optional() }), req.body ?? {});
    return engine.activate(actor, c, Number(v), { backfill: body.backfill });
  });

  const reasonBody = z.object({ reason: z.string().min(5, 'A reason is required (min 5 characters).').max(500) });
  app.post('/rules/:code/versions/:v/pause', async (req) => {
    const actor = need(req, 'rules:activate');
    const { code: c, v } = req.params as any;
    return pause(ec, actor, c, Number(v), parse(reasonBody, req.body).reason);
  });
  app.post('/rules/:code/versions/:v/resume', async (req) => {
    const actor = need(req, 'rules:activate');
    const { code: c, v } = req.params as any;
    return resume(ec, actor, c, Number(v));
  });
  app.post('/rules/:code/versions/:v/retire', async (req) => {
    const actor = need(req, 'rules:activate');
    const { code: c, v } = req.params as any;
    return retire(ec, actor, c, Number(v), parse(reasonBody, req.body).reason);
  });
  app.post('/rules/:code/rollback', async (req) => {
    const actor = need(req, 'rules:activate');
    const { code: c } = req.params as any;
    const body = parse(z.object({ versionNo: vno, reason: reasonBody.shape.reason }), req.body);
    return engine.rollback(actor, c, body.versionNo, body.reason);
  });

  app.get('/rules/:code/diff', async (req) => {
    need(req, 'rules:read');
    const { code: c } = req.params as any;
    const q = parse(z.object({ from: vno, to: vno }), req.query);
    const a = getVersion(db, c, q.from);
    const b = getVersion(db, c, q.to);
    if (!a || !b) throw new MxpError('NOT_FOUND', 'One of the versions does not exist.', 404);
    return { ruleCode: c, from: q.from, to: q.to, changes: diffDefinitions(a.def, b.def) };
  });

  // ---------- campaigns ----------
  const campaignBody = z.object({
    code,
    name: z.string().min(3).max(120),
    description: z.string().max(1000).optional(),
    objective: z.string().max(500).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().optional(),
    pointsBudget: z.number().int().positive().nullable().optional(),
    enrollmentMode: z.enum(['AUTO', 'OPT_IN']).optional(),
  });

  app.get('/campaigns', async (req) => {
    need(req, 'rules:read');
    return { campaigns: listCampaigns(db) };
  });
  app.get('/campaigns/:code', async (req) => {
    need(req, 'rules:read');
    const { code: c } = req.params as any;
    const camp = getCampaign(db, c);
    if (!camp) throw new MxpError('NOT_FOUND', `Campaign ${c} not found.`, 404);
    const rules = db.all(
      `SELECT DISTINCT r.rule_code, v.version_no, v.status, v.name FROM rule_version v JOIN rule r ON r.rule_id = v.rule_id WHERE v.campaign_id = ? ORDER BY r.rule_code, v.version_no DESC`,
      camp.campaign_id,
    );
    const spent = db.value<number>('SELECT COALESCE(SUM(points),0) FROM xp_ledger WHERE campaign_id = ?', camp.campaign_id) ?? 0;
    return { campaign: camp, rules, pointsIssued: spent };
  });
  app.post('/campaigns', async (req, reply) => {
    const actor = need(req, 'campaigns:write');
    return reply.code(201).send(createCampaign(ec, actor, parse(campaignBody, req.body)));
  });
  app.patch('/campaigns/:code', async (req) => {
    const actor = need(req, 'campaigns:write');
    const { code: c } = req.params as any;
    return updateCampaign(ec, actor, c, parse(campaignBody.partial().omit({ code: true }), req.body));
  });
  app.post('/campaigns/:code/status', async (req) => {
    const actor = need(req, 'rules:activate');
    const { code: c } = req.params as any;
    const b = parse(z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'CLOSED']), reason: z.string().max(500).optional() }), req.body);
    return setCampaignStatus(ec, actor, c, b.status, b.reason);
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONTROL_ACTIONS, DEFAULT_FACTS, EVENT_TYPES, GOAL_OPS, MEASURES, OPERATORS, PARAM_TYPES, REWARD_MODES, WINDOWS, operatorsFor, validatePack } from '@mxp/rules';
import { MxpError, PACK_CODE } from '@mxp/platform';
import type { AppCtx } from '../app';
import { need, parse, sendJsonDownload, str } from '../util';

const reason = z.object({ reason: z.string().max(500).optional(), note: z.string().max(500).optional() }).default({});

export function catalogRoutes(app: FastifyInstance, { mx }: AppCtx) {
  const C = mx.catalog;

  // ---------- metadata the editors need ----------
  app.get('/meta', async (req) => {
    need(req, 'rules:read');
    return {
      references: C.references(),
      facts: DEFAULT_FACTS,
      eventTypes: EVENT_TYPES,
      operators: OPERATORS,
      operatorsByType: Object.fromEntries(['string', 'enum', 'number', 'money', 'boolean', 'array', 'date', 'time'].map((t) => [t, operatorsFor(t)])),
      paramTypes: PARAM_TYPES,
      measures: MEASURES,
      windows: WINDOWS,
      goalOps: GOAL_OPS,
      rewardModes: REWARD_MODES,
      controlActions: CONTROL_ACTIONS,
      segments: mx.queries.segments(),
      merchants: mx.queries.merchants(),
      pack: PACK_CODE,
    };
  });

  // ---------- templates ----------
  app.get('/templates', async (req) => {
    need(req, 'rules:read');
    return C.listTemplates();
  });
  app.get('/templates/:code', async (req) => {
    need(req, 'rules:read');
    return C.getTemplate((req.params as any).code);
  });
  app.get('/templates/:code/file', async (req, reply) => {
    need(req, 'rules:read');
    const { code } = req.params as any;
    return sendJsonDownload(reply, `${code}.template.json`, C.templateDef(code));
  });
  app.post('/templates', async (req) => {
    const actor = need(req, 'templates:write');
    const body = parse(z.object({ template: z.unknown(), note: z.string().max(500).optional() }), req.body);
    return C.importTemplate(body.template, actor, { note: body.note });
  });

  // ---------- rules ----------
  app.get('/rules', async (req) => {
    need(req, 'rules:read');
    const q = req.query as any;
    return C.listRules({ family: str(q.family), status: str(q.status), schedule: str(q.schedule), template: str(q.template), q: str(q.q) });
  });
  app.get('/rules/:code', async (req) => {
    need(req, 'rules:read');
    return C.getRule((req.params as any).code);
  });
  app.get('/rules/:code/versions/:v/file', async (req, reply) => {
    need(req, 'rules:read');
    const { code, v } = req.params as any;
    const r = C.getRule(code);
    const ver = r.versions.find((x: any) => x.version_no === Number(v));
    if (!ver) throw new MxpError('NOT_FOUND', 'Version not found.', 404);
    return sendJsonDownload(reply, `${code}.v${v}.rule.json`, ver.definition);
  });
  /** Validates a rule file and returns the plain-language summary. Nothing is saved. */
  app.post('/rules/validate', async (req) => {
    need(req, 'rules:read');
    const r = C.validateRule((req.body as any)?.rule);
    return { ok: !!r.rule && !r.issues.some((i) => i.severity === 'error'), issues: r.issues, summary: r.summary, rule: r.rule, template: r.template };
  });
  app.post('/rules', async (req) => {
    const actor = need(req, 'rules:write');
    const body = parse(z.object({ rule: z.unknown(), note: z.string().max(500).optional() }), req.body);
    return C.createDraft(body.rule, actor, body.note);
  });
  app.put('/rules/:code/versions/:v', async (req) => {
    const actor = need(req, 'rules:write');
    const { code, v } = req.params as any;
    const body = parse(z.object({ rule: z.unknown(), note: z.string().max(500).optional() }), req.body);
    return C.updateDraft(code, Number(v), body.rule, actor, body.note);
  });
  app.post('/rules/:code/versions/:v/:action', async (req) => {
    const { code, v, action } = req.params as any;
    const body = parse(reason, req.body ?? {});
    const n = Number(v);
    switch (action) {
      case 'submit':
      case 'activate': return C.activate(code, need(req, action === 'submit' ? 'rules:write' : 'rules:activate'));
      case 'approve': return C.activate(code, need(req, 'rules:approve'));
      case 'reject': return C.reject(code, n, need(req, 'rules:approve'), body.reason ?? '');
      default: throw new MxpError('NOT_FOUND', `Unknown action ${action}.`, 404);
    }
  });
  app.post('/rules/:code/:action', async (req) => {
    const { code, action } = req.params as any;
    const body = parse(reason, req.body ?? {});
    const map: Record<string, 'PAUSE' | 'RESUME' | 'RETIRE'> = { pause: 'PAUSE', resume: 'RESUME', retire: 'RETIRE' };
    if (!map[action]) throw new MxpError('NOT_FOUND', `Unknown action ${action}.`, 404);
    return C.setLiveStatus(code, map[action], need(req, 'rules:activate'), body.reason);
  });

  // ---------- rule packs (the BRE distribution format) ----------
  app.get('/packs', async (req) => {
    need(req, 'rules:read');
    return C.releases();
  });
  app.get('/packs/current', async (req, reply) => {
    need(req, 'rules:read');
    const cur = C.currentRelease();
    if (!cur) throw new MxpError('NOT_FOUND', 'No release published yet.', 404);
    if ((req.query as any).download) return sendJsonDownload(reply, `${PACK_CODE}-${cur.version_label}.pack.json`, JSON.parse(cur.content_json));
    return JSON.parse(cur.content_json);
  });
  /** Pack for testing: CURRENT (live) or OPEN (drafts / pending / approved versions replace live ones). */
  app.get('/packs/preview', async (req) => {
    need(req, 'rules:read');
    const src = (req.query as any).source === 'OPEN' ? 'OPEN' : 'CURRENT';
    return C.previewPack(src);
  });
  app.get('/packs/:id', async (req, reply) => {
    need(req, 'rules:read');
    const r = C.release((req.params as any).id);
    if ((req.query as any).download) return sendJsonDownload(reply, `${PACK_CODE}-${r.version_label}.pack.json`, r.content);
    return r;
  });
  app.post('/packs/validate', async (req) => {
    need(req, 'rules:read');
    const r = validatePack((req.body as any)?.pack);
    return { ok: r.ok, issues: r.issues, rules: r.pack?.rules.length ?? 0, templates: r.pack?.templates.length ?? 0 };
  });

  // ---------- segments ----------
  app.get('/segments/overview', async (req) => {
    need(req, 'rules:read');
    return mx.queries.segmentsOverview();
  });
}

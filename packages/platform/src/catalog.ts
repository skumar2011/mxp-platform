import {
  DEFAULT_REFERENCES,
  RulesEngine,
  checkRule,
  checkTemplate,
  describeRule,
  parseTemplate,
  ruleSchema,
  type Issue,
  type Rule,
  type RuleInput,
  type RulePackInput,
  type RuleTemplate,
} from '@mxp/rules';
import { CATALOG_TEMPLATES, EXTENSION_TEMPLATES, SAMPLE_REFERENCES } from '@mxp/rules/catalog';
import { audit } from './audit';
import type { Db } from './db';
import { hashJson, MxpError, ruleScheduleStatus, type Actor, type Clock } from './util';

export const PACK_CODE = 'mxp-retail';

/** Flat rule row (v3). */
export interface RuleRow {
  rule_code: string;
  family: string;
  template_code: string;
  status: string;
  name: string;
  description: string | null;
  enrollment_mode: string;
  product_scope: string;
  effective_from: string | null;
  effective_to: string | null;
  priority: number;
  featured: number;
  definition_json: string;
  definition_hash: string;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

/**
 * Catalogue: templates from `@mxp/rules` files; bank rules as one DB row each.
 * Packs are built on the fly from ACTIVE/PAUSED rules (no release history table).
 */
export class Catalog {
  private cache: { hash: string; engine: RulesEngine } | null = null;
  private templates = new Map<string, RuleTemplate>();

  constructor(private db: Db, private clock: Clock) {
    for (const raw of CATALOG_TEMPLATES) {
      const { template } = parseTemplate(raw);
      if (template) this.templates.set(template.code, template);
    }
  }

  private now() {
    return this.clock.now().toISOString();
  }

  invalidate() {
    this.cache = null;
  }

  // =====================================================================
  // Reference data
  // =====================================================================
  references(): Record<string, string[]> {
    const out: Record<string, string[]> = { ...DEFAULT_REFERENCES, ...SAMPLE_REFERENCES };
    const rows = this.db.all<{ list_code: string; value_code: string }>('SELECT list_code, value_code FROM reference_value WHERE active = 1 ORDER BY list_code, sort_order, value_code');
    const lists = new Map<string, string[]>();
    for (const r of rows) lists.set(r.list_code, [...(lists.get(r.list_code) ?? []), r.value_code]);
    for (const [k, v] of lists) out[k] = v;
    const segs = this.db.all<{ segment_code: string }>('SELECT segment_code FROM segment WHERE active = 1 ORDER BY sort_order').map((r) => r.segment_code);
    if (segs.length) out.segments = segs;
    return out;
  }

  // =====================================================================
  // Templates (files only)
  // =====================================================================
  listTemplates() {
    return [...this.templates.values()].map((t) => ({
      code: t.code,
      family: t.family,
      name: t.name,
      summary: t.summary,
      category: t.category,
      icon: t.icon ?? null,
      isExtension: EXTENSION_TEMPLATES.includes(t.code),
      version: t.version,
      params: t.params,
      customerParams: t.params.filter((p) => p.setBy === 'CUSTOMER').map((p) => p.name),
      ruleCount: this.db.value<number>('SELECT COUNT(*) FROM rule WHERE template_code = ?', t.code) ?? 0,
      liveRules: this.db.value<number>("SELECT COUNT(*) FROM rule WHERE template_code = ? AND status IN ('ACTIVE','PAUSED')", t.code) ?? 0,
    }));
  }

  templateDef(code: string): RuleTemplate {
    const t = this.templates.get(code);
    if (!t) throw new MxpError('NOT_FOUND', `Template ${code} not found.`, 404);
    return t;
  }

  getTemplate(code: string) {
    const t = this.templateDef(code);
    const rules = this.db.all<{ rule_code: string; name: string; status: string }>('SELECT rule_code, name, status FROM rule WHERE template_code = ? ORDER BY rule_code', code);
    return { code: t.code, family: t.family, name: t.name, version: t.version, isExtension: EXTENSION_TEMPLATES.includes(code), definition: t, params: t.params, rules };
  }

  /** Validates a template file (does not persist — templates are package files). */
  importTemplate(input: unknown, _actor: Actor, _opts: { note?: string; isExtension?: boolean } = {}) {
    const { template, issues } = parseTemplate(input);
    if (!template || issues.some((i) => i.severity === 'error')) throw new MxpError('INVALID_TEMPLATE', 'The template file has errors.', 422, issues);
    const more = checkTemplate(template, this.references());
    if (more.some((i) => i.severity === 'error')) throw new MxpError('INVALID_TEMPLATE', 'The template file has errors.', 422, more);
    const existing = this.templates.get(template.code);
    if (existing && hashJson(existing) === hashJson(template)) return { code: template.code, version: template.version, unchanged: true, issues: [] as Issue[] };
    // In-memory only for this process (demo). Ship real template changes via the @mxp/rules package.
    this.templates.set(template.code, template);
    this.invalidate();
    return { code: template.code, version: template.version, unchanged: false, issues: more };
  }

  // =====================================================================
  // Rules
  // =====================================================================
  validateRule(input: unknown) {
    const parsed = ruleSchema.safeParse(input);
    if (!parsed.success) {
      return {
        rule: undefined as Rule | undefined,
        template: undefined as RuleTemplate | undefined,
        issues: parsed.error.issues.map((i) => ({ severity: 'error' as const, code: 'SCHEMA', path: i.path.join('.'), message: i.message })),
        summary: '',
      };
    }
    const rule = parsed.data;
    let template: RuleTemplate | undefined;
    try {
      template = this.templateDef(rule.template);
    } catch {
      return { rule, template: undefined, issues: [{ severity: 'error' as const, code: 'UNKNOWN_TEMPLATE', path: 'template', message: `Unknown template ${rule.template}.` }], summary: '' };
    }
    const issues = checkRule(rule, template, this.references());
    let summary = '';
    try {
      summary = describeRule(rule, template);
    } catch {
      /* ignore */
    }
    return { rule, template, issues, summary };
  }

  private row(code: string): RuleRow {
    const r = this.db.get<RuleRow>('SELECT * FROM rule WHERE rule_code = ?', code);
    if (!r) throw new MxpError('NOT_FOUND', `Rule ${code} not found.`, 404);
    return r;
  }

  private doc(r: RuleRow): Rule {
    return ruleSchema.parse(JSON.parse(r.definition_json));
  }

  /** Create or overwrite a draft rule. */
  saveRule(input: unknown, actor: Actor, note?: string): RuleRow {
    const v = this.validateRule(input);
    if (!v.rule || !v.template) throw new MxpError('INVALID_RULE', 'The rule file has errors.', 422, v.issues);
    const errors = v.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new MxpError('INVALID_RULE', 'The rule file has errors.', 422, errors);
    const rule = v.rule;
    const now = this.now();
    const hash = hashJson(rule);
    const existing = this.db.get<RuleRow>('SELECT * FROM rule WHERE rule_code = ?', rule.code);
    return this.db.tx(() => {
      if (existing) {
        if (existing.template_code !== rule.template) throw new MxpError('TEMPLATE_CHANGE', `Rule ${rule.code} is built on ${existing.template_code}.`, 422);
        if (existing.status === 'RETIRED') throw new MxpError('NOT_EDITABLE', 'Retired rules cannot be edited.', 409);
        // Editing a live rule returns it to DRAFT so activate is explicit.
        const status = existing.status === 'DRAFT' ? 'DRAFT' : 'DRAFT';
        this.db.run(
          `UPDATE rule SET status = ?, name = ?, description = ?, enrollment_mode = ?, product_scope = ?, effective_from = ?, effective_to = ?, priority = ?, featured = ?, definition_json = ?, definition_hash = ?, updated_by = ?, updated_at = ? WHERE rule_code = ?`,
          status, rule.name, rule.description ?? null, rule.enrollment, rule.productScope, rule.effective.from, rule.effective.to, rule.priority, rule.featured ? 1 : 0, JSON.stringify(rule), hash, actor.username, now, rule.code,
        );
        audit(this.db, this.clock, actor, 'RULE_EDIT', 'rule', rule.code, { note, was: existing.status });
      } else {
        this.db.run(
          `INSERT INTO rule(rule_code, family, template_code, status, name, description, enrollment_mode, product_scope, effective_from, effective_to, priority, featured, definition_json, definition_hash, created_by, created_at, updated_by, updated_at)
           VALUES (?,?,?,'DRAFT',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          rule.code, v.template!.family, rule.template, rule.name, rule.description ?? null, rule.enrollment, rule.productScope, rule.effective.from, rule.effective.to, rule.priority, rule.featured ? 1 : 0, JSON.stringify(rule), hash, actor.username, now, actor.username, now,
        );
        audit(this.db, this.clock, actor, 'RULE_CREATE', 'rule', rule.code, { note });
      }
      this.invalidate();
      return this.row(rule.code);
    });
  }

  /** @deprecated alias used by seed / older callers */
  createDraft(input: unknown, actor: Actor, note?: string) {
    return this.saveRule(input, actor, note);
  }

  updateDraft(code: string, _version: number, input: unknown, actor: Actor, note?: string) {
    const body = typeof input === 'object' && input ? { ...(input as object), code } : input;
    return this.saveRule(body, actor, note);
  }

  activate(code: string, actor: Actor): RuleRow {
    const r = this.row(code);
    if (!['DRAFT', 'PAUSED', 'ACTIVE'].includes(r.status)) throw new MxpError('BAD_STATE', `Cannot activate a ${r.status} rule.`, 409);
    const v = this.validateRule(JSON.parse(r.definition_json));
    const errors = v.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new MxpError('INVALID_RULE', `Fix ${errors.length} error(s) before activating.`, 422, errors);
    this.db.run("UPDATE rule SET status = 'ACTIVE', updated_by = ?, updated_at = ? WHERE rule_code = ?", actor.username, this.now(), code);
    audit(this.db, this.clock, actor, 'RULE_ACTIVATE', 'rule', code);
    this.invalidate();
    return this.row(code);
  }

  /** Seed helper: save and activate in one step. */
  upsertLive(input: unknown, actor: Actor, note?: string): RuleRow {
    const saved = this.saveRule(input, actor, note);
    return this.activate(saved.rule_code, actor);
  }

  setLiveStatus(code: string, action: 'PAUSE' | 'RESUME' | 'RETIRE', actor: Actor, reason?: string): RuleRow {
    const r = this.row(code);
    const to = action === 'PAUSE' ? 'PAUSED' : action === 'RESUME' ? 'ACTIVE' : 'RETIRED';
    if (action === 'PAUSE' && r.status !== 'ACTIVE') throw new MxpError('BAD_STATE', `Rule is ${r.status}.`, 409);
    if (action === 'RESUME' && r.status !== 'PAUSED') throw new MxpError('BAD_STATE', `Rule is ${r.status}.`, 409);
    if (action === 'RETIRE' && !['ACTIVE', 'PAUSED', 'DRAFT'].includes(r.status)) throw new MxpError('BAD_STATE', `Rule is ${r.status}.`, 409);
    if (action !== 'RESUME' && (!reason || reason.trim().length < 5)) throw new MxpError('REASON_REQUIRED', 'Give a reason (at least 5 characters).', 422);
    this.db.run('UPDATE rule SET status = ?, updated_by = ?, updated_at = ? WHERE rule_code = ?', to, actor.username, this.now(), code);
    audit(this.db, this.clock, actor, `RULE_${action}`, 'rule', code, { reason });
    this.invalidate();
    return this.row(code);
  }

  // Compatibility stubs for removed maker-checker (routes may still call these briefly).
  submit(code: string, _version: number, actor: Actor) {
    return this.activate(code, actor);
  }
  approve(code: string, _version: number, actor: Actor) {
    return this.activate(code, actor);
  }
  reject(code: string, _version: number, actor: Actor, reason: string) {
    if (!reason || reason.trim().length < 5) throw new MxpError('REASON_REQUIRED', 'Give a reason (at least 5 characters).', 422);
    this.db.run("UPDATE rule SET status = 'DRAFT', updated_by = ?, updated_at = ? WHERE rule_code = ?", actor.username, this.now(), code);
    audit(this.db, this.clock, actor, 'RULE_REJECT', 'rule', code, { reason });
    this.invalidate();
    return this.row(code);
  }

  listRules(f: { family?: string; status?: string; schedule?: string; template?: string; q?: string } = {}) {
    const today = this.now().slice(0, 10);
    const rows = this.db.all<RuleRow>(
      `SELECT * FROM rule WHERE 1=1 ${f.family ? 'AND family = ?' : ''} ${f.template ? 'AND template_code = ?' : ''} ${f.status ? 'AND status = ?' : ''} ORDER BY family DESC, rule_code`,
      ...([f.family, f.template, f.status].filter(Boolean) as string[]),
    );
    return rows
      .map((rv) => {
        const doc = JSON.parse(rv.definition_json) as RuleInput;
        let summary = '';
        try {
          summary = describeRule(ruleSchema.parse(doc), this.templateDef(rv.template_code));
        } catch {
          /* ignore */
        }
        const effectiveFrom = rv.effective_from ?? doc.effective?.from ?? null;
        const effectiveTo = rv.effective_to ?? doc.effective?.to ?? null;
        const scheduleStatus = ruleScheduleStatus(rv.status, effectiveFrom, effectiveTo, today);
        return {
          code: rv.rule_code,
          family: rv.family,
          template: rv.template_code,
          name: rv.name,
          latestVersion: 1,
          latestStatus: rv.status,
          liveVersion: rv.status === 'ACTIVE' || rv.status === 'PAUSED' ? 1 : null,
          liveStatus: rv.status === 'ACTIVE' || rv.status === 'PAUSED' ? rv.status : null,
          scheduleStatus,
          segments: doc.segments ?? [],
          states: doc.states ?? [],
          productScope: rv.product_scope ?? doc.productScope ?? 'ANY',
          featured: !!rv.featured,
          enrollment: rv.enrollment_mode,
          effectiveFrom,
          effectiveTo,
          summary,
          updatedAt: rv.updated_at,
        };
      })
      .filter((r) => !f.q || `${r.code} ${r.name}`.toLowerCase().includes(f.q.toLowerCase()))
      .filter((r) => !f.schedule || r.scheduleStatus === f.schedule);
  }

  getRule(code: string) {
    const r = this.row(code);
    const definition = JSON.parse(r.definition_json);
    const template = this.templateDef(r.template_code);
    const stats = {
      participants: this.db.value<number>("SELECT COUNT(DISTINCT customer_id) FROM rule_state WHERE prefix = 'w|' AND rule_code = ?", code) ?? 0,
      activeSettings: this.db.value<number>("SELECT COUNT(*) FROM customer_setting WHERE rule_code = ? AND status = 'ACTIVE'", code) ?? 0,
      pointsAwarded: this.db.value<number>('SELECT COALESCE(SUM(points),0) FROM points_ledger WHERE rule_code = ?', code) ?? 0,
      breaches: this.db.value<number>("SELECT COUNT(*) FROM rule_evaluation WHERE rule_code = ? AND outcome = 'BREACH'", code) ?? 0,
      windowsMet: this.db.value<number>("SELECT COUNT(*) FROM rule_state WHERE prefix = 'w|' AND rule_code = ? AND json_extract(state_json,'$.outcome') IN ('GOAL_MET','COMPLIANT')", code) ?? 0,
    };
    const valueDistribution =
      r.family === 'SPEND_CONTROL'
        ? this.db.all<any>(
            `SELECT key AS param_name, MIN(CAST(value AS REAL)) AS min, MAX(CAST(value AS REAL)) AS max, AVG(CAST(value AS REAL)) AS avg, COUNT(*) AS n
             FROM customer_setting, json_each(customer_setting.values_json)
             WHERE customer_setting.rule_code = ? AND customer_setting.status = 'ACTIVE' AND typeof(value) IN ('integer','real')
             GROUP BY key`,
            code,
          )
        : [];
    // Shape versions[] so the existing admin UI keeps working (single synthetic version).
    const versions = [
      {
        rule_version_id: code,
        rule_id: code,
        rule_code: code,
        family: r.family,
        template_code: r.template_code,
        version_no: 1,
        status: r.status,
        name: r.name,
        description: r.description,
        definition,
        definition_hash: r.definition_hash,
        created_by: r.created_by,
        created_at: r.created_at,
        featured: r.featured,
        priority: r.priority,
        enrollment_mode: r.enrollment_mode,
        change_note: null,
        submitted_by: null,
        submitted_at: null,
        approved_by: null,
        approved_at: null,
        rejected_reason: null,
        activated_by: r.status === 'ACTIVE' ? r.updated_by : null,
        activated_at: r.status === 'ACTIVE' ? r.updated_at : null,
        effective_from: definition.effective?.from ?? null,
        effective_to: definition.effective?.to ?? null,
      },
    ];
    return { ...r, rule_id: code, template, versions, stats, valueDistribution };
  }

  // =====================================================================
  // Packs (built on the fly)
  // =====================================================================
  buildPack(opts: { versionLabel?: string; includeDrafts?: boolean } = {}): RulePackInput {
    const statuses = opts.includeDrafts ? "('ACTIVE','PAUSED','DRAFT')" : "('ACTIVE','PAUSED')";
    const rows = this.db.all<RuleRow>(`SELECT * FROM rule WHERE status IN ${statuses} ORDER BY rule_code`);
    const rules = rows.map((r) => {
      const d = this.doc(r);
      // Preview packs treat drafts as ACTIVE so the testing app can exercise them.
      const status = (r.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE') as 'ACTIVE' | 'PAUSED';
      return { ...d, status, templateVersion: undefined };
    });
    const codes = [...new Set(rules.map((r) => r.template))];
    const templates = codes.map((c) => this.templateDef(c));
    return {
      kind: 'RulePack',
      pack: PACK_CODE,
      version: opts.versionLabel ?? 'live',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      description: 'MXP retail bank rule pack: spend controls and bank-defined missions.',
      references: this.references(),
      templates,
      rules,
      generatedAt: this.now(),
    };
  }

  publish(actor: Actor, reason: string) {
    this.invalidate();
    const pack = this.buildPack({ versionLabel: this.now().slice(0, 10) });
    const hash = hashJson({ ...pack, generatedAt: undefined });
    audit(this.db, this.clock, actor, 'PACK_PUBLISH', 'rule_pack', pack.version!, { hash, reason, rules: pack.rules!.length });
    return { releaseId: hash, label: pack.version!, hash };
  }

  currentRelease() {
    const pack = this.buildPack();
    const content = { ...pack, generatedAt: undefined };
    const hash = hashJson(content);
    return { release_id: hash, version_label: pack.version!, content_json: JSON.stringify(pack), content_hash: hash, published_at: this.now() };
  }

  engine(): { engine: RulesEngine; releaseId: string | null } {
    const pack = this.buildPack();
    const hash = hashJson({ ...pack, generatedAt: undefined });
    if (this.cache?.hash !== hash) this.cache = { hash, engine: RulesEngine.fromPack(pack, { skipInvalidRules: true }) };
    return { engine: this.cache.engine, releaseId: hash };
  }

  previewPack(include: 'CURRENT' | 'OPEN'): RulePackInput {
    if (include === 'CURRENT') return this.buildPack({ versionLabel: 'live' });
    return this.buildPack({ versionLabel: 'preview-open', includeDrafts: true });
  }

  releases() {
    const cur = this.currentRelease();
    return [{ release_id: cur.release_id, version_label: cur.version_label, rule_count: JSON.parse(cur.content_json).rules?.length ?? 0, template_count: JSON.parse(cur.content_json).templates?.length ?? 0, content_hash: cur.content_hash, reason: 'live', published_by: 'system', published_at: cur.published_at, is_current: 1 }];
  }

  release(id: string) {
    const cur = this.currentRelease();
    if (id !== cur.release_id && id !== cur.version_label && id !== 'current') throw new MxpError('NOT_FOUND', 'Release not found (v3 keeps only the live pack).', 404);
    return { ...cur, content: JSON.parse(cur.content_json), content_json: undefined, is_current: 1 };
  }

  segmentsOverview() {
    const segs = this.db.all<{ segment_code: string; name: string; description: string | null }>('SELECT segment_code, name, description FROM segment WHERE active = 1 ORDER BY sort_order');
    const rules = this.listRules().filter((r) => r.liveStatus === 'ACTIVE' || r.liveStatus === 'PAUSED');
    return segs.map((s) => ({
      ...s,
      rules: rules.filter((r) => !r.segments.length || r.segments.includes(s.segment_code)),
    }));
  }
}

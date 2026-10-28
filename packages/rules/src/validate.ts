import type { ZodError } from 'zod';
import { checkCondition } from './conditions';
import { DEFAULT_FACTS, DEFAULT_REFERENCES, factIndex } from './facts';
import { checkRuleParams, collectRefs, resolveValues, substitute, type Issue } from './params';
import { CALENDAR_WINDOWS, packSchema, ruleSchema, templateSchema, type Logic, type Rule, type RulePack, type RuleTemplate } from './schema';
import { isValidTimezone } from './time';

export function zodIssues(e: ZodError, prefix = ''): Issue[] {
  return e.issues.map((i) => ({ severity: 'error' as const, code: 'SCHEMA', path: [prefix, ...i.path].filter((x) => x !== '').join('.'), message: i.message }));
}

const LIMIT_OPS = new Set(['lte', 'lt', 'eq']);

/** Checks a template on its own: parameter references, family invariants, logic combinations. */
export function checkTemplate(t: RuleTemplate, references: Record<string, string[]> = DEFAULT_REFERENCES, facts = factIndex(DEFAULT_FACTS)): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue['severity'], code: string, path: string, message: string) => issues.push({ severity, code, path, message });
  const names = new Set<string>();
  for (const [i, p] of t.params.entries()) {
    if (names.has(p.name)) add('error', 'DUPLICATE_PARAM', `params[${i}]`, `Parameter "${p.name}" is declared twice.`);
    names.add(p.name);
    if (p.min !== undefined && p.max !== undefined && p.min > p.max) add('error', 'BOUNDS_INVERTED', `params[${i}]`, `${p.label}: min is greater than max.`);
    if (p.optionsFrom && !references[p.optionsFrom] && !p.options) add('warning', 'UNKNOWN_REFERENCE', `params[${i}].optionsFrom`, `Reference list "${p.optionsFrom}" is not defined in the pack.`);
  }
  for (const ref of collectRefs(t.logic)) if (!names.has(ref)) add('error', 'UNDECLARED_PARAM', 'logic', `Logic references {"$param": "${ref}"} which is not declared.`);
  const customer = t.params.filter((p) => p.setBy === 'CUSTOMER');
  const L = t.logic;
  if (t.family === 'MISSION') {
    if (customer.length) add('error', 'MISSION_CUSTOMER_PARAM', 'params', `Bank-defined missions cannot have customer-set parameters (${customer.map((p) => p.name).join(', ')}).`);
    if (L.control) add('error', 'MISSION_WITH_CONTROL', 'logic.control', 'Missions do not take control actions; use family SPEND_CONTROL.');
    if (L.reward.mode === 'WINDOW_COMPLIANCE') add('error', 'MISSION_COMPLIANCE', 'logic.reward.mode', 'WINDOW_COMPLIANCE rewards belong to spend controls.');
    if (L.reward.mode === 'ON_GOAL' && !L.goal) add('error', 'GOAL_REQUIRED', 'logic.goal', 'ON_GOAL rewards need a goal.');
    if (L.goal && LIMIT_OPS.has(L.goal.op) && L.reward.mode === 'ON_GOAL') add('warning', 'MISSION_LIMIT_GOAL', 'logic.goal.op', 'A mission goal is usually reached upwards (gte / gt).');
  } else {
    if (!customer.length) add('error', 'CONTROL_NEEDS_CUSTOMER_PARAM', 'params', 'Spend controls need at least one parameter set by the customer.');
    if (!L.goal) add('error', 'GOAL_REQUIRED', 'logic.goal', 'Spend controls need a goal (the limit).');
    else if (!LIMIT_OPS.has(L.goal.op)) add('error', 'CONTROL_GOAL_OP', 'logic.goal.op', 'A spend control goal must be a ceiling (lte, lt or eq).');
    if (L.goal?.tiers) add('error', 'CONTROL_TIERS', 'logic.goal.tiers', 'Spend controls have a single limit, not tiers.');
    if (!['WINDOW_COMPLIANCE', 'NONE'].includes(L.reward.mode)) add('error', 'CONTROL_REWARD_MODE', 'logic.reward.mode', 'Spend controls reward compliance per window (WINDOW_COMPLIANCE) or nothing (NONE).');
    if (L.reward.mode === 'WINDOW_COMPLIANCE' && L.reward.minActivity === undefined)
      add('error', 'MIN_ACTIVITY_REQUIRED', 'logic.reward.minActivity', 'Compliance rewards need minActivity >= 1 so customers are not paid for inactivity.');
    if (!L.control) add('warning', 'NO_CONTROL', 'logic.control', 'Without a control block the limit only affects rewards (no alert or block).');
  }
  const m = L.measure;
  if ((m.type === 'SUM' || m.type === 'AVG_DAILY' || m.type === 'COUNT_DISTINCT') && !m.field) add('error', 'MEASURE_FIELD', 'logic.measure.field', `${m.type} needs a field.`);
  if (m.type === 'STREAK') {
    if (!m.streakPeriod) add('error', 'STREAK_PERIOD', 'logic.measure.streakPeriod', 'STREAK needs streakPeriod.');
    if (L.window.type !== 'LIFETIME') add('error', 'STREAK_WINDOW', 'logic.window.type', 'STREAK runs over a LIFETIME window.');
    if (L.reward.mode !== 'ON_GOAL') add('error', 'STREAK_REWARD', 'logic.reward.mode', 'STREAK rewards milestones (ON_GOAL).');
  }
  if (m.type === 'AVG_DAILY' && L.reward.mode === 'ON_GOAL' && L.reward.awardAt !== 'WINDOW_CLOSE')
    add('error', 'AVG_AWARD_AT', 'logic.reward.awardAt', 'An average is only final when the window closes: set awardAt WINDOW_CLOSE.');
  const wt = L.window.type;
  if (wt === 'ROLLING_DAYS') {
    if (!['SUM', 'COUNT'].includes(m.type)) add('error', 'ROLLING_MEASURE', 'logic.measure.type', 'Rolling windows support SUM and COUNT.');
    if (L.window.days === undefined) add('error', 'ROLLING_DAYS', 'logic.window.days', 'ROLLING_DAYS needs days.');
    if (L.reward.mode !== 'NONE' && !L.window.period) add('error', 'ROLLING_PERIOD', 'logic.window.period', 'Rolling windows track rewards per calendar period: set window.period.');
    if (L.reward.mode === 'ON_GOAL') add('error', 'ROLLING_ON_GOAL', 'logic.reward.mode', 'Rolling windows cannot award ON_GOAL (the same spend would earn repeatedly).');
  }
  if (wt === 'FIXED' && (!L.window.from || !L.window.to)) add('error', 'FIXED_DATES', 'logic.window', 'FIXED windows need from and to.');
  if (L.window.timezone && L.window.timezone !== 'CUSTOMER' && !isValidTimezone(L.window.timezone)) add('error', 'TIMEZONE', 'logic.window.timezone', `Unknown timezone ${L.window.timezone}.`);
  if (L.reward.mode === 'PER_EVENT' && L.reward.points === undefined) add('error', 'POINTS_REQUIRED', 'logic.reward.points', 'PER_EVENT rewards need points.');
  if (L.reward.mode === 'WINDOW_COMPLIANCE' && L.reward.points === undefined) add('error', 'POINTS_REQUIRED', 'logic.reward.points', 'Compliance rewards need points.');
  if (L.reward.mode === 'ON_GOAL' && L.goal && !L.goal.tiers && L.reward.points === undefined) add('error', 'POINTS_REQUIRED', 'logic.reward.points', 'Set reward.points or goal.tiers.');
  if (L.goal && L.goal.target === undefined && !L.goal.tiers?.length) add('error', 'TARGET_REQUIRED', 'logic.goal', 'The goal needs a target or tiers.');
  if (L.subject === 'ACCOUNT' && t.family === 'SPEND_CONTROL') add('warning', 'CONTROL_PER_ACCOUNT', 'logic.subject', 'Spend controls usually apply per customer.');
  checkCondition(L.scope, facts, 'logic.scope', issues);
  checkCondition(L.filter, facts, 'logic.filter', issues);
  checkCondition(L.measure.breakWhen, facts, 'logic.measure.breakWhen', issues);
  return issues;
}

/** Checks the logic after BANK values are substituted (customer values still unknown). */
function checkResolved(logic: Logic, rule: Rule, path: string): Issue[] {
  const issues: Issue[] = [];
  const tiers = logic.goal?.tiers;
  if (tiers?.length) {
    for (let i = 1; i < tiers.length; i++) {
      const a = tiers[i - 1].target as number, b = tiers[i].target as number;
      if (typeof a === 'number' && typeof b === 'number' && b <= a) issues.push({ severity: 'error', code: 'TIERS_NOT_ASCENDING', path: `${path}.tiers[${i}]`, message: 'Tier targets must increase.' });
    }
  }
  const wt = logic.window.type as string;
  if (typeof wt === 'string' && wt !== 'ROLLING_DAYS' && wt !== 'FIXED' && wt !== 'LIFETIME' && !(CALENDAR_WINDOWS as readonly string[]).includes(wt))
    issues.push({ severity: 'error', code: 'WINDOW_TYPE', path: `${path}.window`, message: `Unknown window type ${wt}.` });
  if (rule.effective.from && rule.effective.to && rule.effective.to < rule.effective.from)
    issues.push({ severity: 'error', code: 'EFFECTIVE_RANGE', path: 'effective', message: 'Effective "to" is before "from".' });
  return issues;
}

function checkTargeting(rule: Rule, references: Record<string, string[]>): Issue[] {
  const issues: Issue[] = [];
  const states = references.states ?? [];
  for (const s of rule.states) {
    if (states.length && !states.includes(s)) issues.push({ severity: 'error', code: 'UNKNOWN_STATE', path: 'states', message: `Unknown state code ${s}.` });
  }
  const segs = references.segments ?? [];
  for (const s of rule.segments) {
    if (segs.length && !segs.includes(s)) issues.push({ severity: 'error', code: 'UNKNOWN_SEGMENT', path: 'segments', message: `Unknown segment ${s}.` });
  }
  return issues;
}

export function checkRule(rule: Rule, template: RuleTemplate | undefined, references: Record<string, string[]>): Issue[] {
  if (!template) return [{ severity: 'error', code: 'UNKNOWN_TEMPLATE', path: 'template', message: `Template ${rule.template} is not in the pack.` }];
  const issues = [...checkTargeting(rule, references), ...checkRuleParams(rule, template, references)];
  if (template.family === 'MISSION' && Object.keys(rule.settingsPolicy ?? {}).length && rule.settingsPolicy.cooldownDays > 0)
    issues.push({ severity: 'warning', code: 'POLICY_UNUSED', path: 'settingsPolicy', message: 'settingsPolicy only applies to spend controls.' });
  if (rule.templateVersion && rule.templateVersion !== template.version)
    issues.push({ severity: 'error', code: 'TEMPLATE_VERSION', path: 'templateVersion', message: `Rule targets ${template.code} v${rule.templateVersion} but the pack has v${template.version}.` });
  if (template.family === 'SPEND_CONTROL') {
    for (const p of template.params.filter((x) => x.setBy === 'CUSTOMER' && x.required !== false)) {
      const b = rule.customerParams[p.name];
      const numeric = ['number', 'money', 'integer', 'percent'].includes(p.type);
      if (numeric && (b?.min ?? p.min) === undefined) issues.push({ severity: 'warning', code: 'UNBOUNDED_MIN', path: `customerParams.${p.name}`, message: `${p.label} has no minimum.` });
      if (numeric && (b?.max ?? p.max) === undefined) issues.push({ severity: 'warning', code: 'UNBOUNDED_MAX', path: `customerParams.${p.name}`, message: `${p.label} has no maximum: customers could pick a limit they can never breach.` });
    }
  }
  if (!issues.some((i) => i.severity === 'error')) {
    const values = resolveValues(rule, template, {});
    const bankOnly = Object.fromEntries(template.params.filter((p) => p.setBy === 'BANK').map((p) => [p.name, values[p.name]]));
    const partial = substitute(template.logic, bankOnly);
    // customer refs stay unresolved -> undefined; only check what is known.
    issues.push(...checkResolved(partial as Logic, rule, 'logic'));
  }
  return issues;
}

export interface PackCheck {
  ok: boolean;
  pack: RulePack | null;
  issues: (Issue & { doc?: string })[];
}

/** Full validation of a rule pack document (schema + semantics). */
export function validatePack(input: unknown): PackCheck {
  const parsed = packSchema.safeParse(input);
  if (!parsed.success) {
    // Try to report per-document errors with readable paths.
    const issues = zodIssues(parsed.error);
    return { ok: false, pack: null, issues };
  }
  const pack = parsed.data;
  const issues: (Issue & { doc?: string })[] = [];
  const refs = { ...DEFAULT_REFERENCES, ...pack.references };
  const facts = factIndex(pack.facts ?? DEFAULT_FACTS);
  if (!isValidTimezone(pack.timezone)) issues.push({ severity: 'error', code: 'TIMEZONE', path: 'timezone', message: `Unknown timezone ${pack.timezone}.` });
  const tpl = new Map<string, RuleTemplate>();
  for (const t of pack.templates) {
    if (tpl.has(t.code)) issues.push({ severity: 'error', code: 'DUPLICATE_TEMPLATE', path: 'templates', doc: t.code, message: `Template ${t.code} appears twice.` });
    tpl.set(t.code, t);
    for (const i of checkTemplate(t, refs, facts)) issues.push({ ...i, doc: `template ${t.code}` });
  }
  const seen = new Set<string>();
  for (const r of pack.rules) {
    if (seen.has(r.code)) issues.push({ severity: 'error', code: 'DUPLICATE_RULE', path: 'rules', doc: r.code, message: `Rule ${r.code} appears twice.` });
    seen.add(r.code);
    for (const i of checkRule(r, tpl.get(r.template), refs)) issues.push({ ...i, doc: `rule ${r.code}` });
  }
  return { ok: !issues.some((i) => i.severity === 'error'), pack, issues };
}

export function parseTemplate(input: unknown): { template: RuleTemplate | null; issues: Issue[] } {
  const r = templateSchema.safeParse(input);
  if (!r.success) return { template: null, issues: zodIssues(r.error) };
  return { template: r.data, issues: checkTemplate(r.data) };
}

export function parseRule(input: unknown): { rule: Rule | null; issues: Issue[] } {
  const r = ruleSchema.safeParse(input);
  if (!r.success) return { rule: null, issues: zodIssues(r.error) };
  return { rule: r.data, issues: [] };
}

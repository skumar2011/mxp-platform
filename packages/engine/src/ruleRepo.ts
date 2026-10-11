import type { Db } from './db';
import { audit, type Actor } from './audit';
import { bumpEpoch, readEpoch, type CampaignRow, type Ctx } from './campaigns';
import { emptyGroup, type ConditionGroup, type ConditionNode } from './conditions';
import {
  RULE_CODE_RE,
  definitionHash,
  isBalanceMetric,
  parseRuleDefinition,
  type RuleDefinition,
} from './ruleDef';
import { registerFingerprintLoader, validateDefinition, type ValidationReport } from './validation';
import { canonicalJson, MxpError, toMinor, uid } from './util';
import type { CampaignWindow } from './time';

export type VersionStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'SUPERSEDED'
  | 'RETIRED';

export interface VersionMeta {
  ruleVersionId: string;
  ruleId: string;
  ruleCode: string;
  versionNo: number;
  status: VersionStatus;
  name: string;
  kind: string;
  category: string;
  campaignCode: string | null;
  changeNote: string | null;
  definitionHash: string | null;
  createdBy: string;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
}

export interface RuleVersionFull extends VersionMeta {
  def: RuleDefinition;
}

// ---------------------------------------------------------------------
// Normalisation: the persisted form and the in-memory form must hash equal.
// ---------------------------------------------------------------------
function normNode(n: ConditionNode): ConditionNode {
  if (n.type === 'group') {
    return { type: 'group', op: n.op, negate: !!n.negate, children: n.children.map(normNode) };
  }
  const leaf: ConditionNode = { type: 'condition', field: n.field, operator: n.operator };
  if (n.value !== undefined && n.value !== null && n.operator !== 'IS_NULL' && n.operator !== 'NOT_NULL') leaf.value = n.value;
  return leaf;
}

export function normalizeDefinition(input: unknown): RuleDefinition {
  const d = parseRuleDefinition(input);
  return {
    ...d,
    name: d.name.trim(),
    eligibility: normNode(d.eligibility) as ConditionGroup,
    qualifying: normNode(d.qualifying) as ConditionGroup,
    scope: { channels: [...new Set(d.scope.channels)].sort(), productCodes: [...new Set(d.scope.productCodes)].sort() },
    tiers: d.tiers.map((t) => (t.label ? { label: t.label, threshold: t.threshold, points: t.points } : { threshold: t.threshold, points: t.points })),
    combined: d.combined
      ? { components: [...d.combined.components].sort((a, b) => a.ruleCode.localeCompare(b.ruleCode)) }
      : null,
    handling: { ...d.handling, countStatuses: [...new Set(d.handling.countStatuses)].sort() as ('POSTED' | 'PENDING')[] },
    metric: d.metric ? { type: d.metric.type, operator: d.metric.operator } : null,
  };
}

// ---------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------
function writeTree(db: Db, rvId: string, purpose: 'ELIGIBILITY' | 'QUALIFYING', node: ConditionGroup, parentId: string | null, seq: number) {
  const gid = uid();
  db.run(
    'INSERT INTO rule_condition_group(group_id, rule_version_id, parent_group_id, purpose, logical_op, negate, seq) VALUES (?,?,?,?,?,?,?)',
    gid, rvId, parentId, purpose, node.op, node.negate ? 1 : 0, seq,
  );
  node.children.forEach((c, i) => {
    if (c.type === 'group') writeTree(db, rvId, purpose, c, gid, i);
    else {
      db.run(
        'INSERT INTO rule_condition(condition_id, group_id, seq, field, operator, value_json) VALUES (?,?,?,?,?,?)',
        uid(), gid, i, c.field, c.operator, c.value === undefined ? null : JSON.stringify(c.value),
      );
    }
  });
}

function readTree(db: Db, rvId: string, purpose: 'ELIGIBILITY' | 'QUALIFYING'): ConditionGroup {
  const groups = db.all<any>('SELECT * FROM rule_condition_group WHERE rule_version_id = ? AND purpose = ?', rvId, purpose);
  if (groups.length === 0) return normNode(emptyGroup()) as ConditionGroup;
  const conds = db.all<any>(
    `SELECT c.* FROM rule_condition c JOIN rule_condition_group g ON g.group_id = c.group_id
      WHERE g.rule_version_id = ? AND g.purpose = ?`,
    rvId, purpose,
  );
  const build = (g: any): ConditionGroup => {
    const kids: { seq: number; node: ConditionNode }[] = [];
    for (const sub of groups.filter((x) => x.parent_group_id === g.group_id)) kids.push({ seq: sub.seq, node: build(sub) });
    for (const c of conds.filter((x) => x.group_id === g.group_id)) {
      const leaf: any = { type: 'condition', field: c.field, operator: c.operator };
      if (c.value_json !== null) leaf.value = JSON.parse(c.value_json);
      kids.push({ seq: c.seq, node: leaf });
    }
    kids.sort((a, b) => a.seq - b.seq);
    return { type: 'group', op: g.logical_op, negate: !!g.negate, children: kids.map((k) => k.node) };
  };
  return build(groups.find((g) => g.parent_group_id === null));
}

function campaignIdFor(db: Db, code: string | null): string | null {
  if (!code) return null;
  return db.get<{ campaign_id: string }>('SELECT campaign_id FROM campaign WHERE campaign_code = ?', code)?.campaign_id ?? null;
}

function persistDefinition(db: Db, rvId: string, def: RuleDefinition) {
  db.run('DELETE FROM rule_condition_group WHERE rule_version_id = ?', rvId);
  db.run('DELETE FROM rule_tier WHERE rule_version_id = ?', rvId);
  db.run('DELETE FROM rule_component WHERE rule_version_id = ?', rvId);
  writeTree(db, rvId, 'ELIGIBILITY', def.eligibility, null, 0);
  writeTree(db, rvId, 'QUALIFYING', def.qualifying, null, 0);
  def.tiers.forEach((t, i) =>
    db.run('INSERT INTO rule_tier(tier_id, rule_version_id, tier_no, label, threshold, points) VALUES (?,?,?,?,?,?)', uid(), rvId, i + 1, t.label ?? null, t.threshold, t.points),
  );
  for (const c of def.combined?.components ?? []) {
    const comp = db.get<{ rule_id: string }>('SELECT rule_id FROM rule WHERE rule_code = ?', c.ruleCode);
    if (!comp) throw new MxpError('UNKNOWN_COMPONENT', `Component rule ${c.ruleCode} does not exist.`);
    db.run('INSERT INTO rule_component(rule_version_id, component_rule_id, min_tier_no) VALUES (?,?,?)', rvId, comp.rule_id, c.minTier);
  }
  db.run(
    `UPDATE rule_version SET name=?, description=?, business_objective=?, category=?, campaign_id=?, kind=?, metric_type=?, metric_operator=?,
       period_type=?, timezone=?, date_basis=?, late_grace_days=?, tier_mode=?, frequency=?, max_occurrences=?, cap_points_period=?, cap_points_lifetime=?,
       reversal_policy=?, priority=?, conflict_group=?, conflict_policy=?, effective_from=?, effective_to=?, options_json=?, backfill=?
     WHERE rule_version_id=?`,
    def.name, def.description, def.businessObjective, def.category, campaignIdFor(db, def.campaignCode), def.kind,
    def.metric?.type ?? null, def.metric?.operator ?? 'GTE', def.period.type, def.period.timezone, def.period.dateBasis, def.period.lateGraceDays,
    def.tierMode, def.limits.frequency, def.limits.maxOccurrences, def.limits.capPointsPerPeriod, def.limits.capPointsLifetime,
    def.handling.reversal, def.priority, def.conflict.group, def.conflict.policy, def.effective.from, def.effective.to,
    JSON.stringify({ scope: def.scope, balancePolicy: def.balancePolicy, nudges: def.nudges, countStatuses: def.handling.countStatuses, perEvent: def.perEvent }),
    def.backfill ? 1 : 0, rvId,
  );
}

function readDefinition(db: Db, rvId: string): RuleDefinition {
  const v = db.get<any>(
    `SELECT v.*, c.campaign_code FROM rule_version v LEFT JOIN campaign c ON c.campaign_id = v.campaign_id WHERE v.rule_version_id = ?`,
    rvId,
  );
  if (!v) throw new MxpError('NOT_FOUND', 'Rule version not found.', 404);
  const opts = JSON.parse(v.options_json || '{}');
  const tiers = db.all<any>('SELECT * FROM rule_tier WHERE rule_version_id = ? ORDER BY tier_no', rvId);
  const comps = db.all<any>(
    `SELECT r.rule_code, c.min_tier_no FROM rule_component c JOIN rule r ON r.rule_id = c.component_rule_id WHERE c.rule_version_id = ?`,
    rvId,
  );
  const raw = {
    name: v.name,
    description: v.description ?? '',
    businessObjective: v.business_objective ?? '',
    category: v.category,
    campaignCode: v.campaign_code ?? null,
    kind: v.kind,
    scope: opts.scope ?? {},
    eligibility: readTree(db, rvId, 'ELIGIBILITY'),
    qualifying: readTree(db, rvId, 'QUALIFYING'),
    metric: v.metric_type ? { type: v.metric_type, operator: v.metric_operator } : null,
    period: { type: v.period_type, timezone: v.timezone, dateBasis: v.date_basis, lateGraceDays: v.late_grace_days },
    tiers: tiers.map((t) => (t.label ? { label: t.label, threshold: t.threshold, points: t.points } : { threshold: t.threshold, points: t.points })),
    tierMode: v.tier_mode,
    perEvent: opts.perEvent ?? null,
    combined: comps.length ? { components: comps.map((c) => ({ ruleCode: c.rule_code, minTier: c.min_tier_no })) } : null,
    balancePolicy: opts.balancePolicy ?? {},
    limits: { frequency: v.frequency, maxOccurrences: v.max_occurrences, capPointsPerPeriod: v.cap_points_period, capPointsLifetime: v.cap_points_lifetime },
    handling: { reversal: v.reversal_policy, countStatuses: opts.countStatuses ?? ['POSTED'] },
    priority: v.priority,
    conflict: { group: v.conflict_group, policy: v.conflict_policy },
    effective: { from: v.effective_from, to: v.effective_to },
    nudges: opts.nudges ?? {},
    backfill: !!v.backfill,
  };
  return normalizeDefinition(raw);
}

function metaFrom(r: any): VersionMeta {
  return {
    ruleVersionId: r.rule_version_id,
    ruleId: r.rule_id,
    ruleCode: r.rule_code,
    versionNo: r.version_no,
    status: r.status,
    name: r.name,
    kind: r.kind,
    category: r.category,
    campaignCode: r.campaign_code ?? null,
    changeNote: r.change_note,
    definitionHash: r.definition_hash,
    createdBy: r.created_by,
    createdAt: r.created_at,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    rejectedReason: r.rejected_reason,
    activatedBy: r.activated_by,
    activatedAt: r.activated_at,
  };
}

const VERSION_SELECT = `
  SELECT v.*, r.rule_code, c.campaign_code
    FROM rule_version v JOIN rule r ON r.rule_id = v.rule_id LEFT JOIN campaign c ON c.campaign_id = v.campaign_id`;

export function getVersionById(db: Db, rvId: string): RuleVersionFull | undefined {
  const r = db.get<any>(`${VERSION_SELECT} WHERE v.rule_version_id = ?`, rvId);
  return r ? loadFull(db, r) : undefined;
}

export function getVersion(db: Db, ruleCode: string, versionNo: number): RuleVersionFull | undefined {
  const r = db.get<any>(`${VERSION_SELECT} WHERE r.rule_code = ? AND v.version_no = ?`, ruleCode, versionNo);
  return r ? loadFull(db, r) : undefined;
}

function loadFull(db: Db, row: any): RuleVersionFull {
  const def = readDefinition(db, row.rule_version_id);
  // Sealed versions must still match the hash taken at submission.
  if (row.definition_hash && row.status !== 'DRAFT') {
    const h = definitionHash(def);
    if (h !== row.definition_hash) {
      throw new MxpError('DEFINITION_TAMPERED', `Rule ${row.rule_code} v${row.version_no} no longer matches its approved hash.`, 500);
    }
  }
  return { ...metaFrom(row), def };
}

export function listVersions(db: Db, ruleCode: string): VersionMeta[] {
  return db.all<any>(`${VERSION_SELECT} WHERE r.rule_code = ? ORDER BY v.version_no DESC`, ruleCode).map(metaFrom);
}

export interface RuleSummary extends VersionMeta {
  latestVersionNo: number;
  liveVersionNo: number | null;
  versions: number;
}

export function listRules(db: Db): RuleSummary[] {
  const rows = db.all<any>(
    `SELECT r.rule_code, (SELECT MAX(version_no) FROM rule_version WHERE rule_id = r.rule_id) AS latest,
            (SELECT version_no FROM rule_version WHERE rule_id = r.rule_id AND status IN ('ACTIVE','PAUSED')) AS live,
            (SELECT COUNT(*) FROM rule_version WHERE rule_id = r.rule_id) AS n
       FROM rule r ORDER BY r.rule_code`,
  );
  return rows.map((x) => {
    const shown = x.live ?? x.latest;
    const v = db.get<any>(`${VERSION_SELECT} WHERE r.rule_code = ? AND v.version_no = ?`, x.rule_code, shown)!;
    return { ...metaFrom(v), latestVersionNo: x.latest, liveVersionNo: x.live, versions: x.n };
  });
}

// ---------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------
export function createRule(ctx: Ctx, actor: Actor, ruleCode: string, input: unknown, changeNote?: string): RuleVersionFull {
  const { db, clock } = ctx;
  if (!RULE_CODE_RE.test(ruleCode)) throw new MxpError('BAD_CODE', 'Rule code must be 3-40 chars: A-Z, 0-9, underscore, starting with a letter.');
  if (db.get('SELECT 1 FROM rule WHERE rule_code = ?', ruleCode)) throw new MxpError('DUPLICATE_CODE', `Rule ${ruleCode} already exists.`, 409);
  const def = normalizeDefinition(input);
  const ruleId = uid();
  const rvId = uid();
  const now = clock.now().toISOString();
  db.tx(() => {
    db.run('INSERT INTO rule(rule_id, rule_code, created_by, created_at) VALUES (?,?,?,?)', ruleId, ruleCode, actor.username, now);
    insertVersionRow(db, rvId, ruleId, 1, def, actor, now, changeNote ?? 'Initial draft');
    persistDefinition(db, rvId, def);
    audit(db, clock, actor, 'RULE_CREATE', 'rule', ruleCode, null, { version: 1, name: def.name });
  });
  return getVersionById(db, rvId)!;
}

function insertVersionRow(db: Db, rvId: string, ruleId: string, versionNo: number, def: RuleDefinition, actor: Actor, now: string, note: string) {
  db.run(
    `INSERT INTO rule_version(rule_version_id, rule_id, version_no, status, name, category, kind, period_type, change_note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    rvId, ruleId, versionNo, 'DRAFT', def.name, def.category, def.kind, def.period.type, note, actor.username, now,
  );
}

function requireVersion(db: Db, ruleCode: string, versionNo: number): RuleVersionFull {
  const r = db.get<any>(`${VERSION_SELECT} WHERE r.rule_code = ? AND v.version_no = ?`, ruleCode, versionNo);
  if (!r) throw new MxpError('NOT_FOUND', `Rule ${ruleCode} v${versionNo} not found.`, 404);
  return loadFull(db, r);
}

export function updateDraft(ctx: Ctx, actor: Actor, ruleCode: string, versionNo: number, input: unknown, changeNote?: string): RuleVersionFull {
  const { db, clock } = ctx;
  const cur = requireVersion(db, ruleCode, versionNo);
  if (cur.status !== 'DRAFT') throw new MxpError('NOT_DRAFT', `Only DRAFT versions can be edited (this one is ${cur.status}). Create a new version instead.`, 409);
  if (cur.createdBy !== actor.username && !actor.roles.includes('SYSTEM_ADMIN')) {
    throw new MxpError('NOT_OWNER', 'Only the maker of this draft can edit it.', 403);
  }
  const def = normalizeDefinition(input);
  db.tx(() => {
    persistDefinition(db, cur.ruleVersionId, def);
    if (changeNote !== undefined) db.run('UPDATE rule_version SET change_note=? WHERE rule_version_id=?', changeNote, cur.ruleVersionId);
    audit(db, clock, actor, 'RULE_DRAFT_UPDATE', 'rule_version', `${ruleCode}@${versionNo}`, { hash: definitionHash(cur.def) }, { hash: definitionHash(def) });
  });
  return requireVersion(db, ruleCode, versionNo);
}

/** Creates the next DRAFT version, cloned from a base version (default: latest). */
export function createVersion(ctx: Ctx, actor: Actor, ruleCode: string, baseVersionNo?: number, changeNote?: string): RuleVersionFull {
  const { db, clock } = ctx;
  const rule = db.get<{ rule_id: string }>('SELECT rule_id FROM rule WHERE rule_code = ?', ruleCode);
  if (!rule) throw new MxpError('NOT_FOUND', `Rule ${ruleCode} not found.`, 404);
  const latest = db.value<number>('SELECT MAX(version_no) FROM rule_version WHERE rule_id = ?', rule.rule_id) ?? 0;
  const open = db.get('SELECT 1 FROM rule_version WHERE rule_id = ? AND status IN (\'DRAFT\',\'PENDING_APPROVAL\',\'APPROVED\')', rule.rule_id);
  if (open) throw new MxpError('OPEN_VERSION_EXISTS', 'There is already a version being drafted, reviewed or awaiting activation. Finish or retire it first.', 409);
  const base = requireVersion(db, ruleCode, baseVersionNo ?? latest);
  const rvId = uid();
  const now = clock.now().toISOString();
  db.tx(() => {
    insertVersionRow(db, rvId, rule.rule_id, latest + 1, base.def, actor, now, changeNote ?? `Cloned from v${base.versionNo}`);
    persistDefinition(db, rvId, base.def);
    audit(db, clock, actor, 'RULE_VERSION_CREATE', 'rule_version', `${ruleCode}@${latest + 1}`, null, { basedOn: base.versionNo });
  });
  return requireVersion(db, ruleCode, latest + 1);
}

export function validateVersion(ctx: Ctx, ruleCode: string, versionNo: number, activation = false): ValidationReport {
  const v = requireVersion(ctx.db, ruleCode, versionNo);
  return validateDefinition(ctx.db, v.def, { ruleCode, ruleId: v.ruleId, activation });
}

// ---------------------------------------------------------------------
// Lifecycle: submit -> approve -> activate (maker-checker)
// ---------------------------------------------------------------------
function transition(
  ctx: Ctx,
  actor: Actor,
  v: RuleVersionFull,
  to: VersionStatus,
  action: string,
  extra: Record<string, unknown> = {},
  reason?: string,
) {
  const { db, clock } = ctx;
  const sets = ['status = ?', ...Object.keys(extra).map((k) => `${k} = ?`)].join(', ');
  db.run(`UPDATE rule_version SET ${sets} WHERE rule_version_id = ?`, to, ...Object.values(extra) as any[], v.ruleVersionId);
  audit(db, clock, actor, action, 'rule_version', `${v.ruleCode}@${v.versionNo}`, { status: v.status }, { status: to }, reason);
  bumpEpoch(db, clock);
}

function must(v: RuleVersionFull, ...allowed: VersionStatus[]) {
  if (!allowed.includes(v.status)) {
    throw new MxpError('BAD_TRANSITION', `Rule ${v.ruleCode} v${v.versionNo} is ${v.status}; this action needs ${allowed.join(' or ')}.`, 409);
  }
}

export function submitForApproval(ctx: Ctx, actor: Actor, ruleCode: string, versionNo: number): RuleVersionFull {
  const { db, clock } = ctx;
  const v = requireVersion(db, ruleCode, versionNo);
  must(v, 'DRAFT');
  const report = validateDefinition(db, v.def, { ruleCode, ruleId: v.ruleId });
  if (!report.valid) throw new MxpError('VALIDATION_FAILED', `Cannot submit: ${report.errors.length} validation error(s).`, 422, report);
  db.tx(() => {
    db.run('UPDATE rule_version SET definition_hash=? WHERE rule_version_id=?', definitionHash(v.def), v.ruleVersionId);
    transition(ctx, actor, v, 'PENDING_APPROVAL', 'RULE_SUBMIT', { submitted_by: actor.username, submitted_at: clock.now().toISOString() });
  });
  return requireVersion(db, ruleCode, versionNo);
}

export function approve(ctx: Ctx, actor: Actor, ruleCode: string, versionNo: number, note?: string): RuleVersionFull {
  const { db, clock } = ctx;
  const v = requireVersion(db, ruleCode, versionNo);
  must(v, 'PENDING_APPROVAL');
  if (actor.username === v.createdBy || actor.username === v.submittedBy) {
    throw new MxpError('MAKER_CHECKER', 'Maker-checker: the person who created or submitted a rule cannot approve it.', 403);
  }
  db.tx(() => transition(ctx, actor, v, 'APPROVED', 'RULE_APPROVE', { approved_by: actor.username, approved_at: clock.now().toISOString() }, note));
  return requireVersion(db, ruleCode, versionNo);
}

export function reject(ctx: Ctx, actor: Actor, ruleCode: string, versionNo: number, reason: string): RuleVersionFull {
  const v = requireVersion(ctx.db, ruleCode, versionNo);
  must(v, 'PENDING_APPROVAL');
  if (!reason || reason.trim().length < 3) throw new MxpError('REASON_REQUIRED', 'A rejection reason is required.');
  if (actor.username === v.createdBy || actor.username === v.submittedBy) {
    throw new MxpError('MAKER_CHECKER', 'Maker-checker: you cannot review your own submission.', 403);
  }
  ctx.db.tx(() => transition(ctx, actor, v, 'REJECTED', 'RULE_REJECT', { rejected_reason: reason }, reason));
  return requireVersion(ctx.db, ruleCode, versionNo);
}

export function activate(ctx: Ctx, actor: Actor, ruleCode: string, versionNo: number): RuleVersionFull {
  const { db, clock } = ctx;
  const v = requireVersion(db, ruleCode, versionNo);
  must(v, 'APPROVED');
  const report = validateDefinition(db, v.def, { ruleCode, ruleId: v.ruleId, activation: true });
  if (!report.valid) throw new MxpError('VALIDATION_FAILED', `Cannot activate: ${report.errors.length} validation error(s).`, 422, report);
  db.tx(() => {
    const live = db.get<any>(`SELECT rule_version_id, version_no, status FROM rule_version WHERE rule_id = ? AND status IN ('ACTIVE','PAUSED')`, v.ruleId);
    if (live) {
      db.run(`UPDATE rule_version SET status='SUPERSEDED' WHERE rule_version_id = ?`, live.rule_version_id);
      supersedeProgress(db, live.rule_version_id);
      audit(db, clock, actor, 'RULE_SUPERSEDE', 'rule_version', `${ruleCode}@${live.version_no}`, { status: live.status }, { status: 'SUPERSEDED' });
    }
    transition(ctx, actor, v, 'ACTIVE', 'RULE_ACTIVATE', { activated_by: actor.username, activated_at: clock.now().toISOString() });
  });
  return requireVersion(db, ruleCode, versionNo);
}

/** Open progress of a superseded version stops evaluating; the new version owns the period. */
function supersedeProgress(db: Db, rvId: string) {
  db.run(
    `UPDATE goal_progress SET status = 'CLOSED_SUPERSEDED' WHERE rule_version_id = ? AND status IN ('IN_PROGRESS','ACHIEVED','DATA_UNAVAILABLE')`,
    rvId,
  );
}

export function pause(ctx: Ctx, actor: Actor, ruleCode: string, versionNo: number, reason?: string): RuleVersionFull {
  const v = requireVersion(ctx.db, ruleCode, versionNo);
  must(v, 'ACTIVE');
  ctx.db.tx(() => transition(ctx, actor, v, 'PAUSED', 'RULE_PAUSE', {}, reason));
  return requireVersion(ctx.db, ruleCode, versionNo);
}

export function resume(ctx: Ctx, actor: Actor, ruleCode: string, versionNo: number): RuleVersionFull {
  const v = requireVersion(ctx.db, ruleCode, versionNo);
  must(v, 'PAUSED');
  ctx.db.tx(() => transition(ctx, actor, v, 'ACTIVE', 'RULE_RESUME', {}));
  return requireVersion(ctx.db, ruleCode, versionNo);
}

export function retire(ctx: Ctx, actor: Actor, ruleCode: string, versionNo: number, reason?: string): RuleVersionFull {
  const v = requireVersion(ctx.db, ruleCode, versionNo);
  must(v, 'DRAFT', 'REJECTED', 'APPROVED', 'ACTIVE', 'PAUSED');
  ctx.db.tx(() => {
    transition(ctx, actor, v, 'RETIRED', 'RULE_RETIRE', {}, reason);
    if (v.status === 'ACTIVE' || v.status === 'PAUSED') supersedeProgress(ctx.db, v.ruleVersionId);
  });
  return requireVersion(ctx.db, ruleCode, versionNo);
}

/**
 * Rollback re-activates a previously approved (SUPERSEDED) version. It does not create a new
 * version: the original approval stands, the reason is mandatory and the action is audited.
 */
export function rollback(ctx: Ctx, actor: Actor, ruleCode: string, targetVersionNo: number, reason: string): RuleVersionFull {
  const { db, clock } = ctx;
  if (!reason || reason.trim().length < 5) throw new MxpError('REASON_REQUIRED', 'A rollback reason is required (min 5 characters).');
  const target = requireVersion(db, ruleCode, targetVersionNo);
  must(target, 'SUPERSEDED');
  const report = validateDefinition(db, target.def, { ruleCode, ruleId: target.ruleId, activation: true });
  if (!report.valid) throw new MxpError('VALIDATION_FAILED', `Cannot roll back: ${report.errors.length} validation error(s).`, 422, report);
  db.tx(() => {
    const live = db.get<any>(`SELECT rule_version_id, version_no, status FROM rule_version WHERE rule_id = ? AND status IN ('ACTIVE','PAUSED')`, target.ruleId);
    if (live) {
      db.run(`UPDATE rule_version SET status='SUPERSEDED' WHERE rule_version_id = ?`, live.rule_version_id);
      supersedeProgress(db, live.rule_version_id);
    }
    transition(ctx, actor, target, 'ACTIVE', 'RULE_ROLLBACK', { activated_by: actor.username, activated_at: clock.now().toISOString() }, reason);
  });
  return requireVersion(db, ruleCode, targetVersionNo);
}

// ---------------------------------------------------------------------
// Change comparison
// ---------------------------------------------------------------------
export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

function flatten(v: any, path: string, out: Record<string, unknown>) {
  if (Array.isArray(v)) {
    if (v.length === 0) out[path] = [];
    v.forEach((x, i) => flatten(x, `${path}[${i}]`, out));
  } else if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 0) out[path] = {};
    for (const k of keys) flatten(v[k], path ? `${path}.${k}` : k, out);
  } else out[path] = v;
}

export function diffDefinitions(a: RuleDefinition, b: RuleDefinition): DiffEntry[] {
  const fa: Record<string, unknown> = {};
  const fb: Record<string, unknown> = {};
  flatten(a, '', fa);
  flatten(b, '', fb);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  const out: DiffEntry[] = [];
  for (const k of keys) {
    if (canonicalJson(fa[k]) !== canonicalJson(fb[k])) out.push({ path: k, before: fa[k] ?? null, after: fb[k] ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------
// Live rule registry (cached, epoch-invalidated)
// ---------------------------------------------------------------------
export interface LiveTier {
  tierNo: number;
  label: string | null;
  /** Threshold in metric units: COUNT = count, money metrics = minor units, COMBINED = components met. */
  threshold: number;
  points: number;
}

export interface LiveRule {
  ruleId: string;
  ruleCode: string;
  ruleVersionId: string;
  versionNo: number;
  def: RuleDefinition;
  campaign: CampaignRow | null;
  campaignWindow: CampaignWindow | null;
  windowFrom: string | null;
  windowTo: string | null;
  tiers: LiveTier[];
  components: { ruleId: string; ruleCode: string; minTier: number }[];
  isBalance: boolean;
}

export function compileRule(db: Db, v: RuleVersionFull, campaign: CampaignRow | null): LiveRule {
  const def = v.def;
  const money = def.metric?.type === 'SUM' || isBalanceMetric(def.metric?.type);
  const tiers = def.tiers.map((t, i) => ({
    tierNo: i + 1,
    label: t.label ?? null,
    threshold: money ? toMinor(t.threshold) : Math.round(t.threshold),
    points: t.points,
  }));
  const components = (def.combined?.components ?? []).map((c) => ({
    ruleId: db.get<{ rule_id: string }>('SELECT rule_id FROM rule WHERE rule_code = ?', c.ruleCode)!.rule_id,
    ruleCode: c.ruleCode,
    minTier: c.minTier,
  }));
  const froms = [def.effective.from, campaign?.start_date].filter(Boolean) as string[];
  const tos = [def.effective.to, campaign?.end_date].filter(Boolean) as string[];
  return {
    ruleId: v.ruleId,
    ruleCode: v.ruleCode,
    ruleVersionId: v.ruleVersionId,
    versionNo: v.versionNo,
    def,
    campaign,
    campaignWindow: campaign ? { code: campaign.campaign_code, start: campaign.start_date, end: campaign.end_date } : null,
    windowFrom: froms.length ? froms.sort().at(-1)! : null,
    windowTo: tos.length ? tos.sort()[0] : null,
    tiers,
    components,
    isBalance: isBalanceMetric(def.metric?.type),
  };
}

const registryCache = new WeakMap<Db, { epoch: number; rules: LiveRule[] }>();

export function getLiveRules(db: Db): LiveRule[] {
  const epoch = readEpoch(db);
  const hit = registryCache.get(db);
  if (hit && hit.epoch === epoch) return hit.rules;
  const rows = db.all<any>(`${VERSION_SELECT} WHERE v.status = 'ACTIVE' ORDER BY r.rule_code`);
  const rules: LiveRule[] = [];
  for (const row of rows) {
    const campaign = row.campaign_id ? db.get<CampaignRow>('SELECT * FROM campaign WHERE campaign_id = ?', row.campaign_id)! : null;
    if (campaign && campaign.status !== 'ACTIVE') continue;
    rules.push(compileRule(db, loadFull(db, row), campaign));
  }
  registryCache.set(db, { epoch, rules });
  return rules;
}

export function invalidateRegistry(db: Db) {
  registryCache.delete(db);
}

// Fingerprint for duplicate detection (see validation.ts).
registerFingerprintLoader((db, versionId) => {
  const d = readDefinition(db, versionId);
  return canonicalJson({
    kind: d.kind,
    metric: d.metric,
    period: d.period.type,
    q: d.qualifying,
    e: d.eligibility,
    scope: d.scope,
    tiers: d.tiers,
    perEvent: d.perEvent,
    combined: d.combined,
  });
});

/**
 * Sandbox only: installs a rule version as ACTIVE without the approval workflow.
 * Used by the simulator on an isolated in-memory database; never called against production data.
 */
export function installSandboxRule(db: Db, clock: { now(): Date }, ruleCode: string, input: unknown, versionNo = 1): RuleDefinition {
  const def = normalizeDefinition(input);
  const now = clock.now().toISOString();
  const existing = db.get<{ rule_id: string }>('SELECT rule_id FROM rule WHERE rule_code = ?', ruleCode);
  const ruleId = existing?.rule_id ?? uid();
  const rvId = uid();
  db.tx(() => {
    if (!existing) db.run('INSERT INTO rule(rule_id, rule_code, created_by, created_at) VALUES (?,?,?,?)', ruleId, ruleCode, 'sandbox', now);
    insertVersionRow(db, rvId, ruleId, versionNo, def, { username: 'sandbox', roles: ['SYSTEM'] }, now, 'sandbox');
    persistDefinition(db, rvId, def);
    db.run(`UPDATE rule_version SET status = 'ACTIVE' WHERE rule_version_id = ?`, rvId);
  });
  bumpEpoch(db, clock as any);
  return def;
}

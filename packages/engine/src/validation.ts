import type { Db } from './db';
import { collectFields, countLeaves, validateTree, type Issue } from './conditions';
import { isBalanceMetric, type RuleDefinition } from './ruleDef';
import { isValidTimezone } from './time';
import { canonicalJson } from './util';

export interface ValidationReport {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
  issues: Issue[];
}

export interface ValidationContext {
  ruleCode: string;
  ruleId?: string | null;
  /** Used to apply stricter checks at activation. */
  activation?: boolean;
}

interface LiveRow {
  rule_id: string;
  rule_code: string;
  kind: string;
  priority: number;
  conflict_group: string | null;
  conflict_policy: string;
  period_type: string;
  metric_type: string | null;
  rule_version_id: string;
}

const err = (code: string, path: string, message: string): Issue => ({ severity: 'error', code, path, message });
const warn = (code: string, path: string, message: string): Issue => ({ severity: 'warning', code, path, message });

export function validateDefinition(db: Db, def: RuleDefinition, ctx: ValidationContext): ValidationReport {
  const issues: Issue[] = [];

  // ---- Period and calendar -------------------------------------------
  if (!isValidTimezone(def.period.timezone)) {
    issues.push(err('BAD_TIMEZONE', 'period.timezone', `"${def.period.timezone}" is not a valid IANA timezone.`));
  }
  const campaign = def.campaignCode
    ? db.get<any>('SELECT * FROM campaign WHERE campaign_code = ?', def.campaignCode)
    : undefined;
  if (def.campaignCode && !campaign) {
    issues.push(err('UNKNOWN_CAMPAIGN', 'campaignCode', `Campaign "${def.campaignCode}" does not exist.`));
  }
  if (def.period.type === 'CAMPAIGN' && !def.campaignCode) {
    issues.push(err('CAMPAIGN_REQUIRED', 'period.type', 'A CAMPAIGN period needs the rule to belong to a campaign.'));
  }
  if (campaign?.status === 'CLOSED') {
    issues.push(err('CAMPAIGN_CLOSED', 'campaignCode', `Campaign "${campaign.campaign_code}" is closed.`));
  }
  const { from, to } = def.effective;
  if (from && to && from > to) issues.push(err('BAD_EFFECTIVE_RANGE', 'effective', 'Effective-from is after effective-to.'));
  if (campaign) {
    if (from && from > campaign.end_date) issues.push(err('OUTSIDE_CAMPAIGN', 'effective.from', 'Effective-from is after the campaign ends.'));
    if (to && to < campaign.start_date) issues.push(err('OUTSIDE_CAMPAIGN', 'effective.to', 'Effective-to is before the campaign starts.'));
    if (def.period.timezone !== campaign.timezone) {
      issues.push(warn('TZ_DIFFERS', 'period.timezone', `Rule timezone ${def.period.timezone} differs from the campaign timezone ${campaign.timezone}.`));
    }
  }
  if (ctx.activation && to && to < new Date().toISOString().slice(0, 10) && !campaign) {
    issues.push(err('ALREADY_EXPIRED', 'effective.to', 'Effective-to is in the past, so this rule can never apply.'));
  }

  // ---- Scope -----------------------------------------------------------
  for (const ch of def.scope.channels) {
    if (!db.get('SELECT 1 FROM channel_ref WHERE channel_code = ?', ch)) issues.push(err('UNKNOWN_CHANNEL', 'scope.channels', `Unknown channel "${ch}".`));
  }
  for (const p of def.scope.productCodes) {
    if (!db.get('SELECT 1 FROM product_ref WHERE product_code = ?', p)) issues.push(err('UNKNOWN_PRODUCT', 'scope.productCodes', `Unknown product "${p}".`));
  }

  // ---- Conditions --------------------------------------------------------
  const balance = isBalanceMetric(def.metric?.type);
  // Balance and combined goals have no single transaction account, so eligibility is customer level.
  // Account selection for balance goals belongs in the qualifying group.
  const customerOnly = balance || def.kind === 'COMBINED';
  validateTree(def.eligibility, customerOnly ? ['customer'] : ['customer', 'account'], 'eligibility', issues);
  validateTree(def.qualifying, balance ? ['customer', 'account'] : ['txn', 'customer', 'account'], 'qualifying', issues);

  // ---- Kind-specific -----------------------------------------------------
  const tiers = def.tiers;
  switch (def.kind) {
    case 'GOAL': {
      if (!def.metric) issues.push(err('METRIC_REQUIRED', 'metric', 'A goal needs a metric (count, sum or balance).'));
      if (def.perEvent) issues.push(err('PER_EVENT_NOT_ALLOWED', 'perEvent', 'Per-event rewards belong to PER_EVENT rules.'));
      if (def.combined) issues.push(err('COMBINED_NOT_ALLOWED', 'combined', 'Components belong to COMBINED rules.'));
      if (tiers.length === 0) issues.push(err('TIERS_REQUIRED', 'tiers', 'Add at least one tier (threshold and points).'));
      if (def.metric?.type === 'COUNT' && tiers.some((t) => !Number.isInteger(t.threshold) || t.threshold < 1)) {
        issues.push(err('COUNT_THRESHOLD', 'tiers', 'Count thresholds must be whole numbers of at least 1.'));
      }
      if (def.metric && def.metric.type !== 'COUNT' && def.metric.type !== 'BALANCE_GROWTH' && tiers.some((t) => t.threshold <= 0)) {
        issues.push(err('THRESHOLD_POSITIVE', 'tiers', 'Thresholds must be greater than zero.'));
      }
      if (def.metric?.type === 'BALANCE_GROWTH' && tiers.some((t) => t.threshold <= 0)) {
        issues.push(err('THRESHOLD_POSITIVE', 'tiers', 'Growth thresholds must be greater than zero.'));
      }
      if (balance && def.period.type === 'DAILY') {
        issues.push(err('BALANCE_PERIOD', 'period.type', 'Balance goals need a WEEKLY, MONTHLY, QUARTERLY or CAMPAIGN period.'));
      }
      if (!balance && countLeaves(def.qualifying) === 0 && def.scope.channels.length === 0 && def.scope.productCodes.length === 0) {
        issues.push(warn('COUNTS_EVERYTHING', 'qualifying', 'No qualifying conditions: every posted transaction will count toward this goal.'));
      }
      if (balance && countLeaves(def.qualifying) === 0) {
        issues.push(warn('ALL_ACCOUNTS', 'qualifying', 'No account filter: balances of every account the customer holds will be summed.'));
      }
      if (balance) {
        const txnFields = collectFields(def.qualifying).filter((f) => f.startsWith('txn.'));
        if (txnFields.length) issues.push(err('BALANCE_TXN_FIELD', 'qualifying', 'Balance goals filter accounts, not transactions.'));
      }
      break;
    }
    case 'PER_EVENT': {
      if (!def.perEvent) issues.push(err('PER_EVENT_REQUIRED', 'perEvent', 'A per-event rule needs a points formula.'));
      else if (def.perEvent.mode === 'PER_AMOUNT' && !def.perEvent.perAmount) {
        issues.push(err('PER_AMOUNT_REQUIRED', 'perEvent.perAmount', 'PER_AMOUNT needs the spend that earns the points (for example 100).'));
      }
      if (def.metric) issues.push(err('METRIC_NOT_ALLOWED', 'metric', 'Per-event rules do not use a goal metric.'));
      if (tiers.length) issues.push(err('TIERS_NOT_ALLOWED', 'tiers', 'Per-event rules do not use tiers.'));
      if (!def.limits.capPointsPerPeriod && !def.limits.capPointsLifetime) {
        issues.push(warn('NO_CAP', 'limits', 'No points cap: a per-event rule can award without limit.'));
      }
      break;
    }
    case 'COMBINED': {
      if (!def.combined) {
        issues.push(err('COMPONENTS_REQUIRED', 'combined', 'A combined goal needs at least one component goal.'));
        break;
      }
      if (def.metric) issues.push(err('METRIC_NOT_ALLOWED', 'metric', 'Combined goals count met components; do not set a metric.'));
      const n = def.combined.components.length;
      if (tiers.length === 0) issues.push(err('TIERS_REQUIRED', 'tiers', 'Add at least one tier. Thresholds are the number of components met.'));
      if (tiers.some((t) => !Number.isInteger(t.threshold) || t.threshold < 1 || t.threshold > n)) {
        issues.push(err('COMBINED_THRESHOLD', 'tiers', `Combined thresholds must be whole numbers between 1 and ${n}.`));
      }
      const seen = new Set<string>();
      for (const c of def.combined.components) {
        if (seen.has(c.ruleCode)) issues.push(err('DUPLICATE_COMPONENT', 'combined.components', `"${c.ruleCode}" is listed twice.`));
        seen.add(c.ruleCode);
        if (c.ruleCode === ctx.ruleCode) {
          issues.push(err('SELF_REFERENCE', 'combined.components', 'A combined goal cannot include itself.'));
          continue;
        }
        const comp = db.get<any>(
          `SELECT r.rule_id, v.kind, v.period_type, v.campaign_id FROM rule r
             JOIN rule_version v ON v.rule_id = r.rule_id
            WHERE r.rule_code = ? ORDER BY v.version_no DESC LIMIT 1`,
          c.ruleCode,
        );
        if (!comp) {
          issues.push(err('UNKNOWN_COMPONENT', 'combined.components', `Component rule "${c.ruleCode}" does not exist.`));
          continue;
        }
        if (comp.kind !== 'GOAL') issues.push(err('COMPONENT_KIND', 'combined.components', `"${c.ruleCode}" is not a GOAL rule.`));
        if (comp.period_type !== def.period.type) {
          issues.push(err('COMPONENT_PERIOD', 'combined.components', `"${c.ruleCode}" uses a ${comp.period_type} period; this rule uses ${def.period.type}.`));
        }
        const live = db.get('SELECT 1 FROM rule_version WHERE rule_id = ? AND status = ?', comp.rule_id, 'ACTIVE');
        if (!live && ctx.activation) {
          issues.push(err('COMPONENT_NOT_ACTIVE', 'combined.components', `Component "${c.ruleCode}" is not active yet; activate it first.`));
        } else if (!live) {
          issues.push(warn('COMPONENT_NOT_ACTIVE', 'combined.components', `Component "${c.ruleCode}" is not active yet.`));
        }
      }
      break;
    }
  }

  // ---- Tiers -------------------------------------------------------------
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i].threshold <= tiers[i - 1].threshold) {
      issues.push(err('TIERS_NOT_ASCENDING', `tiers[${i}]`, 'Tier thresholds must be strictly increasing.'));
    }
    if (def.tierMode === 'HIGHEST_ONLY' && tiers[i].points < tiers[i - 1].points) {
      issues.push(warn('HIGHEST_ONLY_DECREASING', `tiers[${i}]`, 'With HIGHEST_ONLY, a higher tier pays fewer points than a lower tier.'));
    }
  }
  if (tiers.some((t) => t.points === 0)) issues.push(warn('ZERO_POINTS', 'tiers', 'A tier awards zero points.'));

  // ---- Limits and caps --------------------------------------------------
  const { capPointsPerPeriod: capP, capPointsLifetime: capL, maxOccurrences, frequency } = def.limits;
  const totalTierPoints =
    def.tierMode === 'HIGHEST_ONLY' ? Math.max(0, ...tiers.map((t) => t.points)) : tiers.reduce((a, t) => a + t.points, 0);
  if (capP !== null && tiers.length && capP < totalTierPoints) {
    issues.push(warn('CAP_BELOW_TIERS', 'limits.capPointsPerPeriod', `Period cap (${capP}) is below the ${totalTierPoints} points the tiers can award; the top tier will be clamped.`));
  }
  if (capP !== null && capL !== null && capL < capP) {
    issues.push(warn('CAP_ORDER', 'limits.capPointsLifetime', 'Lifetime cap is below the per-period cap.'));
  }
  if (frequency === 'ONCE' && maxOccurrences) {
    issues.push(warn('ONCE_WITH_MAX', 'limits.maxOccurrences', 'Max occurrences is ignored when frequency is ONCE.'));
  }
  if (frequency === 'ONCE' && def.period.type === 'CAMPAIGN') {
    issues.push(warn('ONCE_CAMPAIGN', 'limits.frequency', 'A CAMPAIGN period already occurs once; ONCE adds nothing.'));
  }
  if (def.handling.countStatuses.includes('PENDING') && def.handling.reversal === 'GRANDFATHER') {
    issues.push(warn('PENDING_GRANDFATHER', 'handling', 'Counting PENDING transactions with GRANDFATHER means failed authorisations still keep their reward.'));
  }

  // ---- Conflict policy ---------------------------------------------------
  const { group, policy } = def.conflict;
  if (policy !== 'CUMULATIVE' && !group) {
    issues.push(err('CONFLICT_GROUP_REQUIRED', 'conflict.group', 'Exclusive policies need a conflict group name.'));
  }
  if (policy === 'CUMULATIVE' && group) {
    issues.push(warn('GROUP_IGNORED', 'conflict.group', 'The conflict group has no effect while the policy is CUMULATIVE.'));
  }

  // ---- Cross-rule checks against live rules ------------------------------
  const live = db.all<LiveRow>(
    `SELECT r.rule_id, r.rule_code, v.rule_version_id, v.kind, v.priority, v.conflict_group, v.conflict_policy, v.period_type, v.metric_type
       FROM rule_version v JOIN rule r ON r.rule_id = v.rule_id
      WHERE v.status IN ('ACTIVE','PAUSED') AND r.rule_code <> ?`,
    ctx.ruleCode,
  );
  if (group) {
    for (const o of live.filter((l) => l.conflict_group === group)) {
      if (o.conflict_policy !== policy) {
        issues.push(err('GROUP_POLICY_MISMATCH', 'conflict.policy', `Rule ${o.rule_code} uses policy ${o.conflict_policy} in group "${group}". All rules in a group must share one policy.`));
      }
      if (o.period_type !== def.period.type) {
        issues.push(err('GROUP_PERIOD_MISMATCH', 'conflict.group', `Rule ${o.rule_code} in group "${group}" uses a ${o.period_type} period. Exclusive rewards must share a period type.`));
      }
      if (policy === 'EXCLUSIVE_PRIORITY' && o.priority === def.priority) {
        issues.push(err('AMBIGUOUS_PRIORITY', 'priority', `Rule ${o.rule_code} has the same priority (${o.priority}) in exclusive group "${group}"; the winner would be ambiguous.`));
      }
    }
  }
  // Duplicate detection: same measurable definition already live => cumulative double pay.
  const fingerprint = canonicalJson({
    kind: def.kind,
    metric: def.metric,
    period: def.period.type,
    q: def.qualifying,
    e: def.eligibility,
    scope: def.scope,
    tiers: def.tiers,
    perEvent: def.perEvent,
    combined: def.combined,
  });
  for (const o of live) {
    const full = loadFingerprint(db, o.rule_version_id);
    if (full === fingerprint && !(policy !== 'CUMULATIVE' && group && o.conflict_group === group)) {
      issues.push(warn('POSSIBLE_DUPLICATE', 'name', `Rule ${o.rule_code} has an identical definition. With cumulative rewards a customer would be paid by both.`));
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { valid: errors.length === 0, errors, warnings, issues };
}

// The fingerprint is built from the loaded definition; injected to avoid an import cycle.
let fingerprintLoader: ((db: Db, versionId: string) => string) | null = null;
export function registerFingerprintLoader(fn: (db: Db, versionId: string) => string) {
  fingerprintLoader = fn;
}
function loadFingerprint(db: Db, versionId: string): string {
  return fingerprintLoader ? fingerprintLoader(db, versionId) : '';
}

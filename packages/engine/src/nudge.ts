import type { Db } from './db';
import type { EngineCtx } from './context';
import type { LiveRule } from './ruleRepo';
import { fmtInr, uid } from './util';

export type NudgeType = 'PROGRESS' | 'NEAR_TARGET' | 'TIER_ACHIEVED' | 'REWARD_REVERSED';

export interface NudgeInput {
  customerId: string;
  rule: LiveRule;
  periodKey: string;
  type: NudgeType;
  dedupeKey: string;
  vars: Record<string, string | number>;
}

function render(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
}

export function fmtMetric(rule: LiveRule, v: number): string {
  const t = rule.def.metric?.type;
  if (rule.def.kind === 'COMBINED') return `${v} of ${rule.def.combined?.components.length ?? 0} goals`;
  if (t === 'COUNT') return `${v} transaction${v === 1 ? '' : 's'}`;
  return fmtInr(v);
}

/**
 * Records a nudge decision. Eligibility checks (rule setting, customer consent, approved channel,
 * daily cap) are applied here so the history shows both sent and suppressed nudges.
 */
export function createNudge(ctx: EngineCtx, n: NudgeInput): void {
  const { db, clock, config } = ctx;
  if (!n.rule.def.nudges.enabled) return;
  if (db.get('SELECT 1 FROM nudge WHERE dedupe_key = ?', n.dedupeKey)) return;
  const customer = db.get<{ nudge_consent: number }>('SELECT nudge_consent FROM customer WHERE customer_id = ?', n.customerId);
  const channel = config.nudge.defaultChannel;
  const now = clock.now();
  let status: 'ELIGIBLE' | 'SUPPRESSED' = 'ELIGIBLE';
  let reason: string | null = null;
  if (!customer || !customer.nudge_consent) {
    status = 'SUPPRESSED';
    reason = 'NO_CONSENT';
  } else if (!config.nudge.approvedChannels.includes(channel)) {
    status = 'SUPPRESSED';
    reason = 'CHANNEL_NOT_APPROVED';
  } else if (n.type === 'PROGRESS' || n.type === 'NEAR_TARGET') {
    const today = now.toISOString().slice(0, 10);
    const sent = db.value<number>(
      `SELECT COUNT(*) FROM nudge WHERE customer_id = ? AND substr(created_at,1,10) = ? AND nudge_type IN ('PROGRESS','NEAR_TARGET') AND status <> 'SUPPRESSED'`,
      n.customerId, today,
    ) ?? 0;
    if (sent >= config.nudge.dailyProgressCap) {
      status = 'SUPPRESSED';
      reason = 'DAILY_CAP';
    }
  }
  const tpl = db.get<{ body_template: string }>(
    'SELECT body_template FROM nudge_template WHERE nudge_type = ? AND channel = ? AND active = 1',
    n.type, channel,
  );
  const body = tpl?.body_template ?? defaultBody(n.type);
  const message = render(body, { goal: n.rule.def.name, ...n.vars });
  db.run(
    `INSERT INTO nudge(nudge_id, customer_id, rule_id, rule_version_id, period_key, nudge_type, channel, message, payload_json, dedupe_key, status, suppress_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid(), n.customerId, n.rule.ruleId, n.rule.ruleVersionId, n.periodKey, n.type, channel, message, JSON.stringify(n.vars), n.dedupeKey, status, reason, now.toISOString(),
  );
}

function defaultBody(t: NudgeType): string {
  switch (t) {
    case 'TIER_ACHIEVED':
      return 'Congratulations! You earned {{points}} XP for {{goal}}.';
    case 'NEAR_TARGET':
      return 'You are close! {{remaining}} more to earn {{points}} XP in {{goal}}.';
    case 'PROGRESS':
      return 'You have reached {{progress}} of {{target}} in {{goal}}.';
    case 'REWARD_REVERSED':
      return '{{points}} XP for {{goal}} were reversed because a qualifying transaction was refunded or reversed.';
  }
}

export interface NudgeAdapter {
  name: string;
  send(n: { nudge_id: string; customer_id: string; channel: string; message: string }): Promise<void> | void;
}

/** Default adapter: records delivery locally. Replace with the bank notification hub in deployment. */
export const loggingAdapter: NudgeAdapter = {
  name: 'log',
  send() {
    /* delivered to the in-process outbox; external hubs pull via GET /api/v1/nudges/pending */
  },
};

export function dispatchNudges(ctx: EngineCtx, adapter: NudgeAdapter = loggingAdapter, limit = 200): { sent: number; failed: number } {
  const { db, clock } = ctx;
  const rows = db.all<any>(`SELECT * FROM nudge WHERE status = 'ELIGIBLE' ORDER BY created_at LIMIT ?`, limit);
  let sent = 0;
  let failed = 0;
  for (const n of rows) {
    try {
      const r = adapter.send(n);
      if (r instanceof Promise) throw new Error('async adapters must use dispatchNudgesAsync');
      db.run(`UPDATE nudge SET status = 'SENT', attempts = attempts + 1, sent_at = ? WHERE nudge_id = ?`, clock.now().toISOString(), n.nudge_id);
      sent++;
    } catch (e) {
      db.run(`UPDATE nudge SET status = CASE WHEN attempts + 1 >= 3 THEN 'FAILED' ELSE 'ELIGIBLE' END, attempts = attempts + 1 WHERE nudge_id = ?`, n.nudge_id);
      failed++;
    }
  }
  return { sent, failed };
}

export const DEFAULT_TEMPLATES: { code: string; type: NudgeType; channel: string; body: string }[] = [
  { code: 'TIER_ACHIEVED_PUSH', type: 'TIER_ACHIEVED', channel: 'PUSH', body: 'Congratulations! You earned {{points}} XP for {{goal}}.' },
  { code: 'NEAR_TARGET_PUSH', type: 'NEAR_TARGET', channel: 'PUSH', body: 'You are close! {{remaining}} more to earn {{points}} XP in {{goal}}.' },
  { code: 'PROGRESS_PUSH', type: 'PROGRESS', channel: 'PUSH', body: 'On your way: {{progress}} toward {{target}} in {{goal}}.' },
  { code: 'REWARD_REVERSED_PUSH', type: 'REWARD_REVERSED', channel: 'PUSH', body: '{{points}} XP for {{goal}} were reversed because a qualifying transaction was refunded or reversed.' },
  { code: 'TIER_ACHIEVED_IN_APP', type: 'TIER_ACHIEVED', channel: 'IN_APP', body: 'You earned {{points}} XP: {{goal}}.' },
  { code: 'NEAR_TARGET_IN_APP', type: 'NEAR_TARGET', channel: 'IN_APP', body: '{{remaining}} to go for {{points}} XP: {{goal}}.' },
];

export function seedTemplates(db: Db) {
  for (const t of DEFAULT_TEMPLATES) {
    db.run('INSERT OR IGNORE INTO nudge_template(template_code, nudge_type, channel, body_template, active) VALUES (?,?,?,?,1)', t.code, t.type, t.channel, t.body);
  }
}

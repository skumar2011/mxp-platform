import type { Db } from './db';
import { audit, type Actor } from './audit';
import { isValidTimezone } from './time';
import { MxpError, uid, type Clock } from './util';

export interface Ctx {
  db: Db;
  clock: Clock;
}

export interface CampaignRow {
  campaign_id: string;
  campaign_code: string;
  name: string;
  description: string | null;
  objective: string | null;
  start_date: string;
  end_date: string;
  timezone: string;
  points_budget: number | null;
  enrollment_mode: 'AUTO' | 'OPT_IN';
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'CLOSED';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignInput {
  code: string;
  name: string;
  description?: string;
  objective?: string;
  startDate: string;
  endDate: string;
  timezone?: string;
  pointsBudget?: number | null;
  enrollmentMode?: 'AUTO' | 'OPT_IN';
}

const EPOCH_KEY = 'rule_epoch';

/** Bumped whenever live rule configuration changes; engines use it to refresh their rule cache. */
export function bumpEpoch(db: Db, clock: Clock): void {
  const now = clock.now().toISOString();
  const cur = db.get<{ value_json: string }>('SELECT value_json FROM system_config WHERE config_key = ?', EPOCH_KEY);
  const next = (cur ? Number(cur.value_json) : 0) + 1;
  db.run(
    `INSERT INTO system_config(config_key, value_json, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(config_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    EPOCH_KEY,
    String(next),
    'system',
    now,
  );
}

export function readEpoch(db: Db): number {
  const cur = db.get<{ value_json: string }>('SELECT value_json FROM system_config WHERE config_key = ?', EPOCH_KEY);
  return cur ? Number(cur.value_json) : 0;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;

function validateInput(i: CampaignInput) {
  if (!CODE_RE.test(i.code)) throw new MxpError('BAD_CODE', 'Campaign code must be 3-40 chars: A-Z, 0-9, underscore, starting with a letter.');
  if (!i.name || i.name.trim().length < 3) throw new MxpError('BAD_NAME', 'Campaign name is required (min 3 characters).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(i.endDate)) {
    throw new MxpError('BAD_DATE', 'Dates must be YYYY-MM-DD.');
  }
  if (i.endDate < i.startDate) throw new MxpError('BAD_DATE_RANGE', 'End date is before start date.');
  if (i.timezone && !isValidTimezone(i.timezone)) throw new MxpError('BAD_TIMEZONE', `Invalid timezone ${i.timezone}.`);
  if (i.pointsBudget !== undefined && i.pointsBudget !== null && (!Number.isInteger(i.pointsBudget) || i.pointsBudget < 0)) {
    throw new MxpError('BAD_BUDGET', 'Points budget must be a non-negative whole number.');
  }
}

export function createCampaign(ctx: Ctx, actor: Actor, i: CampaignInput): CampaignRow {
  validateInput(i);
  const { db, clock } = ctx;
  if (db.get('SELECT 1 FROM campaign WHERE campaign_code = ?', i.code)) {
    throw new MxpError('DUPLICATE_CODE', `Campaign ${i.code} already exists.`, 409);
  }
  const now = clock.now().toISOString();
  const id = uid();
  db.tx(() => {
    db.run(
      `INSERT INTO campaign(campaign_id, campaign_code, name, description, objective, start_date, end_date, timezone, points_budget, enrollment_mode, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, i.code, i.name.trim(), i.description ?? null, i.objective ?? null, i.startDate, i.endDate,
      i.timezone ?? 'Asia/Kolkata', i.pointsBudget ?? null, i.enrollmentMode ?? 'AUTO', 'DRAFT', actor.username, now, now,
    );
    audit(db, clock, actor, 'CAMPAIGN_CREATE', 'campaign', i.code, null, i);
  });
  return getCampaign(db, i.code)!;
}

export function updateCampaign(ctx: Ctx, actor: Actor, code: string, patch: Partial<CampaignInput>): CampaignRow {
  const { db, clock } = ctx;
  const cur = getCampaign(db, code);
  if (!cur) throw new MxpError('NOT_FOUND', `Campaign ${code} not found.`, 404);
  if (cur.status === 'CLOSED') throw new MxpError('CAMPAIGN_CLOSED', 'A closed campaign cannot be edited.', 409);
  const merged: CampaignInput = {
    code,
    name: patch.name ?? cur.name,
    description: patch.description ?? cur.description ?? undefined,
    objective: patch.objective ?? cur.objective ?? undefined,
    startDate: patch.startDate ?? cur.start_date,
    endDate: patch.endDate ?? cur.end_date,
    timezone: patch.timezone ?? cur.timezone,
    pointsBudget: patch.pointsBudget === undefined ? cur.points_budget : patch.pointsBudget,
    enrollmentMode: patch.enrollmentMode ?? cur.enrollment_mode,
  };
  validateInput(merged);
  if (cur.status === 'ACTIVE' && (merged.startDate !== cur.start_date || merged.timezone !== cur.timezone)) {
    throw new MxpError('ACTIVE_LOCKED', 'Start date and timezone cannot change while the campaign is active.', 409);
  }
  const spent = db.value<number>('SELECT COALESCE(SUM(points),0) FROM xp_ledger WHERE campaign_id = ?', cur.campaign_id) ?? 0;
  if (merged.pointsBudget !== null && merged.pointsBudget !== undefined && merged.pointsBudget < spent) {
    throw new MxpError('BUDGET_BELOW_SPEND', `Budget cannot be below the ${spent} points already issued.`, 409);
  }
  db.tx(() => {
    db.run(
      `UPDATE campaign SET name=?, description=?, objective=?, start_date=?, end_date=?, timezone=?, points_budget=?, enrollment_mode=?, updated_at=? WHERE campaign_id=?`,
      merged.name.trim(), merged.description ?? null, merged.objective ?? null, merged.startDate, merged.endDate,
      merged.timezone ?? 'Asia/Kolkata', merged.pointsBudget ?? null, merged.enrollmentMode ?? 'AUTO', clock.now().toISOString(), cur.campaign_id,
    );
    audit(db, clock, actor, 'CAMPAIGN_UPDATE', 'campaign', code, cur, merged);
    bumpEpoch(db, clock);
  });
  return getCampaign(db, code)!;
}

export function setCampaignStatus(
  ctx: Ctx,
  actor: Actor,
  code: string,
  status: 'ACTIVE' | 'PAUSED' | 'CLOSED',
  reason?: string,
): CampaignRow {
  const { db, clock } = ctx;
  const cur = getCampaign(db, code);
  if (!cur) throw new MxpError('NOT_FOUND', `Campaign ${code} not found.`, 404);
  const allowed: Record<string, string[]> = {
    ACTIVE: ['DRAFT', 'PAUSED'],
    PAUSED: ['ACTIVE'],
    CLOSED: ['DRAFT', 'ACTIVE', 'PAUSED'],
  };
  if (!allowed[status].includes(cur.status)) {
    throw new MxpError('BAD_TRANSITION', `Cannot move campaign from ${cur.status} to ${status}.`, 409);
  }
  db.tx(() => {
    db.run('UPDATE campaign SET status=?, updated_at=? WHERE campaign_id=?', status, clock.now().toISOString(), cur.campaign_id);
    audit(db, clock, actor, `CAMPAIGN_${status}`, 'campaign', code, { status: cur.status }, { status }, reason);
    bumpEpoch(db, clock);
  });
  return getCampaign(db, code)!;
}

export function getCampaign(db: Db, code: string): CampaignRow | undefined {
  return db.get<CampaignRow>('SELECT * FROM campaign WHERE campaign_code = ?', code);
}

export function listCampaigns(db: Db): (CampaignRow & { rule_count: number; points_issued: number; enrolled: number })[] {
  return db.all<any>(
    `SELECT c.*,
       (SELECT COUNT(DISTINCT rule_id) FROM rule_version v WHERE v.campaign_id = c.campaign_id) AS rule_count,
       (SELECT COALESCE(SUM(points),0) FROM xp_ledger l WHERE l.campaign_id = c.campaign_id) AS points_issued,
       (SELECT COUNT(DISTINCT customer_id) FROM goal_progress gp JOIN rule_version v ON v.rule_version_id = gp.rule_version_id WHERE v.campaign_id = c.campaign_id) AS enrolled
     FROM campaign c ORDER BY c.start_date DESC, c.campaign_code`,
  );
}

import type { Catalog } from './catalog';
import type { Db } from './db';
import type { Participation } from './participation';
import { MxpError, parseJson, ruleScheduleStatus, uid, type Actor, type Clock } from './util';
import { audit } from './audit';
import { localParts } from '@mxp/rules';

export interface Page {
  limit?: number;
  offset?: number;
}
const lim = (p: Page) => [Math.min(Math.max(Number(p.limit) || 50, 1), 500), Math.max(Number(p.offset) || 0, 0)] as const;

function where(filters: [string, unknown][]): [string, unknown[]] {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [sql, v] of filters) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(sql);
    params.push(v);
  }
  return [parts.length ? `WHERE ${parts.join(' AND ')}` : '', params];
}

export class Queries {
  constructor(private db: Db, private clock: Clock, private catalog: Catalog, private part: Participation) {}

  dashboard() {
    const d = this.db;
    const since = new Date(this.clock.now().getTime() - 30 * 86400000).toISOString();
    const today = localParts(this.clock.now().toISOString(), this.catalog.engine().engine.pack.timezone).date;
    const scheduleCounts = { RUNNING: 0, SCHEDULED: 0, EXPIRED: 0, PAUSED: 0, DRAFT: 0, RETIRED: 0 };
    for (const r of d.all<{ status: string; effective_from: string | null; effective_to: string | null }>('SELECT status, effective_from, effective_to FROM rule')) {
      const s = ruleScheduleStatus(r.status, r.effective_from, r.effective_to, today);
      scheduleCounts[s] = (scheduleCounts[s] ?? 0) + 1;
    }
    // Achieved = closed windows where the customer met the goal / stayed compliant.
    const achievedWindows =
      d.value<number>(
        `SELECT COUNT(*) FROM rule_state WHERE prefix = 'w|' AND status = 'CLOSED'
         AND json_extract(state_json,'$.outcome') IN ('GOAL_MET','COMPLIANT','AWARDED')`,
      ) ?? 0;
    const achievedCustomers =
      d.value<number>(
        `SELECT COUNT(DISTINCT customer_id) FROM rule_state WHERE prefix = 'w|' AND status = 'CLOSED'
         AND json_extract(state_json,'$.outcome') IN ('GOAL_MET','COMPLIANT','AWARDED')`,
      ) ?? 0;
    return {
      rules: d.all<any>(`SELECT family, status, COUNT(*) AS n FROM rule GROUP BY family, status`),
      ruleSchedule: scheduleCounts,
      achieved: { windows: achievedWindows, customers: achievedCustomers },
      pendingApprovals: d.value<number>("SELECT COUNT(*) FROM rule WHERE status = 'DRAFT'") ?? 0,
      customers: d.value<number>('SELECT COUNT(*) FROM customer') ?? 0,
      activeSettings: d.value<number>("SELECT COUNT(*) FROM customer_setting WHERE status = 'ACTIVE'") ?? 0,
      events30d: d.value<number>('SELECT COUNT(*) FROM "transaction" WHERE occurred_at >= ?', since) ?? 0,
      failedEvents: d.value<number>(`SELECT COUNT(*) FROM "transaction" WHERE status = 'FAILED'`) ?? 0,
      points: d.get<any>(`SELECT COALESCE(SUM(CASE WHEN points > 0 THEN points END),0) AS awarded, COALESCE(-SUM(CASE WHEN points < 0 THEN points END),0) AS clawed,
        COALESCE(SUM(CASE WHEN family = 'MISSION' AND points > 0 THEN points END),0) AS missions, COALESCE(SUM(CASE WHEN family = 'SPEND_CONTROL' AND points > 0 THEN points END),0) AS controls FROM points_ledger`),
      breaches30d: d.value<number>("SELECT COUNT(*) FROM rule_evaluation WHERE outcome = 'BREACH' AND evaluated_at >= ?", since) ?? 0,
      decisions: d.all<any>('SELECT decision, COUNT(*) AS n FROM control_decision GROUP BY decision'),
      topRules: d.all<any>(`SELECT rule_code, family, SUM(points) AS points, COUNT(*) AS entries FROM points_ledger WHERE rule_code IS NOT NULL GROUP BY rule_code, family ORDER BY points DESC LIMIT 8`),
      outcomes: d.all<any>(`SELECT json_extract(state_json,'$.family') AS family, json_extract(state_json,'$.outcome') AS outcome, COUNT(*) AS n
        FROM rule_state WHERE prefix = 'w|' AND status = 'CLOSED' GROUP BY family, outcome ORDER BY family, n DESC`),
      pointsByDay: d.all<any>(`SELECT earned_on AS day, SUM(CASE WHEN family = 'MISSION' THEN points ELSE 0 END) AS missions, SUM(CASE WHEN family = 'SPEND_CONTROL' THEN points ELSE 0 END) AS controls
        FROM points_ledger WHERE earned_on >= ? GROUP BY day ORDER BY day`, since.slice(0, 10)),
      release: (() => {
        const r = this.catalog.currentRelease();
        return r ? { releaseId: r.release_id, label: r.version_label, hash: r.content_hash, publishedAt: r.published_at } : null;
      })(),
    };
  }

  /** Side-by-side view of what each segment gets (the "personalized by segment" story). */
  segmentsOverview() {
    const { engine } = this.catalog.engine();
    const segments = this.db.all<any>('SELECT * FROM segment WHERE active = 1 ORDER BY sort_order');
    return segments.map((s) => {
      const ctx = {
        customer: {
          id: 'preview',
          segment: s.segment_code,
          state: 'MH',
          timezone: engine.pack.timezone,
          dormancy_risk: false,
          status: 'ACTIVE',
          products: ['SAVINGS', 'CURRENT', 'DEBIT_CARD', 'CREDIT_CARD'],
        },
      };
      const offers = engine.availableFor(ctx).map((o) => {
        const r = engine.getRule(o.code)!;
        return { ...o, params: r.rule.params, customerParams: r.rule.customerParams, tags: r.rule.tags, description: r.rule.description };
      });
      const customers = this.db.value<number>('SELECT COUNT(*) FROM customer WHERE segment_code = ?', s.segment_code) ?? 0;
      return { ...s, customers, controls: offers.filter((o) => o.family === 'SPEND_CONTROL'), missions: offers.filter((o) => o.family === 'MISSION') };
    });
  }

  customers(f: { q?: string; segment?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([
      ['c.segment_code = ?', f.segment],
      ["(c.display_name LIKE ? OR c.customer_ref LIKE ? OR c.customer_id LIKE ?)", f.q ? `%${f.q}%` : undefined],
    ]);
    const params = f.q ? [...p, `%${f.q}%`, `%${f.q}%`] : p;
    return this.db.all<any>(`SELECT c.customer_id, c.customer_ref, c.display_name, c.segment_code, c.state_code, c.timezone, c.dormancy_risk, c.status, c.created_at,
        COALESCE((SELECT SUM(balance) FROM points_account a WHERE a.customer_id = c.customer_id),0) AS points,
        (SELECT COUNT(*) FROM customer_setting s WHERE s.customer_id = c.customer_id AND s.status = 'ACTIVE') AS controls,
        (SELECT MAX(occurred_at) FROM "transaction" e WHERE e.customer_id = c.customer_id) AS last_event_at
      FROM customer c ${w} ORDER BY c.segment_code, c.display_name LIMIT ${l} OFFSET ${o}`, ...(params as any[]));
  }

  customer360(id: string) {
    const c = this.part.customerRow(id);
    const cid = c.customer_id;
    const accountPoints = this.db.all<any>('SELECT * FROM points_account WHERE customer_id = ? ORDER BY account_id', cid);
    const points = {
      balance: accountPoints.reduce((s, a) => s + a.balance, 0),
      lifetime_earned: accountPoints.reduce((s, a) => s + a.lifetime_earned, 0),
      lifetime_clawed: accountPoints.reduce((s, a) => s + a.lifetime_clawed, 0),
      byAccount: accountPoints,
    };
    return {
      customer: { ...c, attributes: parseJson(c.attributes_json, {}), attributes_json: undefined },
      context: this.part.contextFor(cid).customer,
      accounts: this.part.accountsOf(cid),
      points,
      offers: this.part.offers(cid),
      settings: this.db.all<any>(`SELECT setting_id, status, created_via, updated_at AS created_at, cancelled_at, rule_code, values_json, effective_from, pending_values_json, pending_from
        FROM customer_setting WHERE customer_id = ? ORDER BY rule_code`, cid)
        .map((r) => ({
          ...r,
          values: JSON.parse(r.values_json),
          values_json: undefined,
          version_no: 1,
          effective_to: r.pending_from ?? null,
          pending: r.pending_values_json ? JSON.parse(r.pending_values_json) : null,
          pending_values_json: undefined,
        })),
      enrollments: this.db.all<any>('SELECT * FROM mission_enrollment WHERE customer_id = ?', cid),
      windows: this.windows({ customerId: cid, limit: 200 }),
      lifetimes: this.db.all<any>(`SELECT rule_code, json_extract(state_json,'$.subjectKey') AS subject_key,
          json_extract(state_json,'$.points') AS points_awarded, json_extract(state_json,'$.awards') AS award_count,
          json_extract(state_json,'$.streak.current') AS streak_current, json_extract(state_json,'$.streak.best') AS streak_best, updated_at
        FROM rule_state WHERE prefix = 'l|' AND customer_id = ? ORDER BY rule_code`, cid),
      ledger: this.ledger({ customerId: cid, limit: 200 }),
      evaluations: this.evaluations({ customerId: cid, limit: 200 }),
      breaches: this.breaches({ customerId: cid, limit: 100 }),
      nudges: this.nudges({ customerId: cid, limit: 100 }),
      events: this.events({ customerId: cid, limit: 200 }),
    };
  }

  windows(f: { customerId?: string; ruleCode?: string; status?: string; family?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([
      ['customer_id = ?', f.customerId],
      ['rule_code = ?', f.ruleCode],
      ['status = ?', f.status],
      ["json_extract(state_json,'$.family') = ?", f.family],
    ]);
    return this.db.all<any>(
      `SELECT state_key, rule_code, customer_id, window_key, window_end, close_after, status, updated_at,
        json_extract(state_json,'$.family') AS family, json_extract(state_json,'$.ruleVersion') AS rule_version_no,
        json_extract(state_json,'$.subjectKey') AS subject_key, json_extract(state_json,'$.settingId') AS setting_id,
        json_extract(state_json,'$.windowStart') AS window_start, json_extract(state_json,'$.outcome') AS outcome,
        json_extract(state_json,'$.value') AS measure_value, json_extract(state_json,'$.target') AS target_value,
        json_extract(state_json,'$.activity') AS activity_count, json_extract(state_json,'$.matched') AS matched_count,
        json_extract(state_json,'$.breaches') AS breach_count, json_extract(state_json,'$.firstBreachAt') AS first_breach_at,
        json_extract(state_json,'$.achievedTier') AS achieved_tier, json_extract(state_json,'$.points') AS points_awarded
       FROM rule_state WHERE prefix = 'w|'${w ? ' AND ' + w.slice(6) : ''} ORDER BY window_key DESC, rule_code LIMIT ${l} OFFSET ${o}`,
      ...(p as any[]),
    );
  }

  windowDetail(key: string) {
    const r = this.db.get<any>('SELECT state_json FROM rule_state WHERE state_key = ?', key);
    if (!r) throw new MxpError('NOT_FOUND', 'Window not found.', 404);
    return JSON.parse(r.state_json);
  }

  evaluations(f: { customerId?: string; ruleCode?: string; outcome?: string; family?: string; eventId?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([['e.customer_id = ?', f.customerId], ['e.rule_code = ?', f.ruleCode], ['e.outcome = ?', f.outcome], ['e.family = ?', f.family], ['e.event_id = ?', f.eventId]]);
    return this.db.all<any>(`SELECT e.*, c.display_name, ev.event_type, ev.occurred_at FROM rule_evaluation e LEFT JOIN customer c ON c.customer_id = e.customer_id LEFT JOIN "transaction" ev ON ev.event_id = e.event_id
      ${w} ORDER BY COALESCE(ev.occurred_at, e.evaluated_at) DESC, e.rowid DESC LIMIT ${l} OFFSET ${o}`, ...(p as any[])).map((r) => ({ ...r, trace: parseJson(r.trace_json, null), trace_json: undefined }));
  }

  ledger(f: { customerId?: string; accountId?: string; ruleCode?: string; entryType?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([['l.customer_id = ?', f.customerId], ['l.account_id = ?', f.accountId], ['l.rule_code = ?', f.ruleCode], ['l.entry_type = ?', f.entryType]]);
    return this.db.all<any>(`SELECT l.*, c.display_name FROM points_ledger l LEFT JOIN customer c ON c.customer_id = l.customer_id ${w} ORDER BY l.ledger_id DESC LIMIT ${l} OFFSET ${o}`, ...(p as any[]));
  }

  dwhBatches(limit = 50) {
    return this.db.all<any>('SELECT * FROM dwh_batch ORDER BY started_at DESC LIMIT ?', limit);
  }

  /** Limit breaches = rule_evaluation rows with outcome BREACH (aliases match the admin UI). */
  breaches(f: { customerId?: string; ruleCode?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([
      ['e.customer_id = ?', f.customerId],
      ['e.rule_code = ?', f.ruleCode],
    ]);
    const whereSql = w ? `${w} AND e.outcome = 'BREACH'` : `WHERE e.outcome = 'BREACH'`;
    return this.db.all<any>(
      `SELECT e.evaluation_id AS breach_id, e.evaluation_id, e.customer_id, e.account_id, e.rule_code, e.setting_id, e.window_key, e.event_id,
              e.target_value AS limit_value, e.measure_after AS measured_value, e.decision AS action,
              COALESCE(ev.occurred_at, e.evaluated_at) AS occurred_at, e.evaluated_at AS recorded_at,
              c.display_name, ev.occurred_at AS event_at
       FROM rule_evaluation e
       LEFT JOIN customer c ON c.customer_id = e.customer_id
       LEFT JOIN "transaction" ev ON ev.event_id = e.event_id
       ${whereSql}
       ORDER BY COALESCE(ev.occurred_at, e.evaluated_at) DESC, e.rowid DESC
       LIMIT ${l} OFFSET ${o}`,
      ...(p as any[]),
    );
  }

  decisions(f: { customerId?: string; decision?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([['d.customer_id = ?', f.customerId], ['d.decision = ?', f.decision]]);
    return this.db.all<any>(`SELECT d.*, c.display_name FROM control_decision d LEFT JOIN customer c ON c.customer_id = d.customer_id ${w} ORDER BY d.decided_at DESC LIMIT ${l} OFFSET ${o}`, ...(p as any[]))
      .map((r) => ({ ...r, reasons: JSON.parse(r.reasons_json), payload: JSON.parse(r.payload_json), reasons_json: undefined, payload_json: undefined }));
  }

  nudges(f: { customerId?: string; kind?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([['n.customer_id = ?', f.customerId], ['n.kind = ?', f.kind]]);
    return this.db.all<any>(`SELECT n.*, c.display_name FROM nudge n LEFT JOIN customer c ON c.customer_id = n.customer_id ${w} ORDER BY n.created_at DESC, n.rowid DESC LIMIT ${l} OFFSET ${o}`, ...(p as any[]));
  }

  events(f: { customerId?: string; type?: string; status?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([['e.customer_id = ?', f.customerId], ['e.event_type = ?', f.type], ['e.status = ?', f.status]]);
    return this.db.all<any>(`SELECT e.*, c.display_name, (SELECT COUNT(*) FROM rule_evaluation r WHERE r.event_id = e.event_id) AS evaluations,
        (SELECT COALESCE(SUM(points),0) FROM points_ledger l WHERE l.event_id = e.event_id) AS points
      FROM "transaction" e LEFT JOIN customer c ON c.customer_id = e.customer_id ${w} ORDER BY e.occurred_at DESC LIMIT ${l} OFFSET ${o}`, ...(p as any[]))
      .map((r) => ({ ...r, payload: JSON.parse(r.payload_json), payload_json: undefined }));
  }

  auditLog(f: { entityType?: string; entityId?: string; actor?: string } & Page = {}) {
    const [l, o] = lim(f);
    const [w, p] = where([['entity_type = ?', f.entityType], ['entity_id LIKE ?', f.entityId ? `${f.entityId}%` : undefined], ['actor = ?', f.actor]]);
    return this.db.all<any>(`SELECT * FROM audit_log ${w} ORDER BY audit_id DESC LIMIT ${l} OFFSET ${o}`, ...(p as any[])).map((r) => ({ ...r, detail: parseJson(r.detail_json, null), detail_json: undefined }));
  }

  merchants() {
    return this.db.all<any>('SELECT * FROM merchant WHERE active = 1 ORDER BY name');
  }

  segments() {
    return this.db.all<any>('SELECT * FROM segment ORDER BY sort_order');
  }
}

// =====================================================================
// Test scenarios (the testing app stores and replays them)
// =====================================================================
export class TestStore {
  constructor(private db: Db, private clock: Clock) {}

  list() {
    return this.db.all<any>('SELECT scenario_id, name, description, focus_rule_code, tags, last_status, last_run_at, created_by, updated_at, definition_json FROM test_scenario ORDER BY focus_rule_code, name')
      .map((r) => ({ ...r, definition: JSON.parse(r.definition_json), definition_json: undefined, tags: r.tags ? r.tags.split(',') : [] }));
  }

  get(id: string) {
    const r = this.db.get<any>('SELECT * FROM test_scenario WHERE scenario_id = ?', id);
    if (!r) throw new MxpError('NOT_FOUND', 'Scenario not found.', 404);
    return { ...r, definition: JSON.parse(r.definition_json), definition_json: undefined, tags: r.tags ? r.tags.split(',') : [] };
  }

  save(def: { id?: string; name: string; description?: string; focusRule?: string; tags?: string[]; steps: unknown[] }, actor: Actor) {
    if (!def?.name || !Array.isArray(def.steps)) throw new MxpError('INVALID_SCENARIO', 'A scenario needs a name and steps.', 422);
    const now = this.clock.now().toISOString();
    const id = def.id && this.db.get('SELECT 1 FROM test_scenario WHERE scenario_id = ?', def.id) ? def.id : def.id ?? uid();
    const doc = { ...def, id };
    this.db.run(`INSERT INTO test_scenario(scenario_id, name, description, focus_rule_code, tags, definition_json, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(scenario_id) DO UPDATE SET name = excluded.name, description = excluded.description, focus_rule_code = excluded.focus_rule_code, tags = excluded.tags, definition_json = excluded.definition_json, updated_at = excluded.updated_at`,
      id, def.name, def.description ?? null, def.focusRule ?? null, (def.tags ?? []).join(','), JSON.stringify(doc), actor.username, now, now);
    audit(this.db, this.clock, actor, 'SCENARIO_SAVE', 'test_scenario', id, { name: def.name });
    return this.get(id);
  }

  remove(id: string, actor: Actor) {
    this.db.run('DELETE FROM test_scenario WHERE scenario_id = ?', id);
    audit(this.db, this.clock, actor, 'SCENARIO_DELETE', 'test_scenario', id);
  }

  recordRun(r: { kind: 'SCENARIO' | 'SUITE' | 'MATRIX'; packSource: string; packHash?: string; passed: number; failed: number; results: { scenarioId?: string; passed: boolean }[]; scenarioId?: string }, actor: Actor) {
    const now = this.clock.now().toISOString();
    const id = uid();
    this.db.tx(() => {
      this.db.run('INSERT INTO test_run(run_id, scenario_id, run_kind, pack_source, pack_hash, passed, failed, result_json, run_by, run_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, r.scenarioId ?? null, r.kind, r.packSource, r.packHash ?? null, r.passed, r.failed, JSON.stringify(r.results), actor.username, now);
      for (const x of r.results) if (x.scenarioId) this.db.run('UPDATE test_scenario SET last_status = ?, last_run_at = ? WHERE scenario_id = ?', x.passed ? 'PASSED' : 'FAILED', now, x.scenarioId);
    });
    return { runId: id };
  }

  runs(limit = 50) {
    return this.db.all<any>(`SELECT run_id, scenario_id, run_kind, pack_source, pack_hash, passed, failed, run_by, run_at FROM test_run ORDER BY run_at DESC LIMIT ?`, limit);
  }
}

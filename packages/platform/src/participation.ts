import { describeRule, localParts, daysBetween, type CustomerSettingInput, type EvalContext } from '@mxp/rules';
import { audit } from './audit';
import type { Catalog } from './catalog';
import type { Db } from './db';
import { MxpError, parseJson, uid, type Actor, type Clock } from './util';

export type SettingVia = 'APP' | 'BRANCH' | 'ADMIN' | 'TEST' | 'SEED';

export interface CustomerInput {
  customerId?: string;
  customerRef: string;
  displayName: string;
  segment: string;
  /** ISO 3166-2 India state / UT code (e.g. MH, KA, DL). Used for geo-targeted rules. */
  stateCode?: string | null;
  timezone?: string;
  kycStatus?: 'FULL' | 'MINIMAL' | 'PENDING';
  dormancyRisk?: boolean;
  attributes?: Record<string, unknown>;
  accounts?: { accountId?: string; accountRef: string; accountType: string; productFamily: string; productCode?: string; stateCode?: string | null; openedOn: string }[];
  createdAt?: string;
}

export class Participation {
  constructor(private db: Db, private clock: Clock, private catalog: Catalog) {}

  private now() {
    return this.clock.now().toISOString();
  }

  createCustomer(input: CustomerInput, actor: Actor): string {
    const id = input.customerId ?? uid();
    const at = input.createdAt ?? this.now();
    if (!this.db.get('SELECT 1 FROM segment WHERE segment_code = ?', input.segment)) throw new MxpError('UNKNOWN_SEGMENT', `Segment ${input.segment} does not exist.`, 422);
    this.db.tx(() => {
      this.db.run(
        'INSERT INTO customer(customer_id, customer_ref, display_name, segment_code, state_code, kyc_status, timezone, dormancy_risk, attributes_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, input.customerRef, input.displayName, input.segment, input.stateCode ?? null, input.kycStatus ?? 'FULL', input.timezone ?? 'Asia/Kolkata', input.dormancyRisk ? 1 : 0, JSON.stringify(input.attributes ?? {}), at, at,
      );
      for (const a of input.accounts ?? []) {
        const accountId = a.accountId ?? uid();
        this.db.run(
          'INSERT INTO account(account_id, customer_id, account_ref, account_type, product_family, product_code, state_code, opened_on, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          accountId, id, a.accountRef, a.accountType, a.productFamily, a.productCode ?? null, a.stateCode ?? input.stateCode ?? null, a.openedOn, at,
        );
        this.db.run('INSERT INTO points_account(account_id, customer_id, balance, lifetime_earned, lifetime_clawed, updated_at) VALUES (?,?,0,0,0,?)', accountId, id, at);
      }
      audit(this.db, this.clock, actor, 'CUSTOMER_CREATE', 'customer', id, { segment: input.segment, stateCode: input.stateCode });
    });
    return id;
  }

  updateCustomer(id: string, patch: { segment?: string; stateCode?: string | null; timezone?: string; dormancyRisk?: boolean; attributes?: Record<string, unknown> }, actor: Actor) {
    const c = this.customerRow(id);
    this.db.run(
      'UPDATE customer SET segment_code = ?, state_code = ?, timezone = ?, dormancy_risk = ?, attributes_json = ?, updated_at = ? WHERE customer_id = ?',
      patch.segment ?? c.segment_code,
      patch.stateCode !== undefined ? patch.stateCode : c.state_code,
      patch.timezone ?? c.timezone,
      patch.dormancyRisk === undefined ? c.dormancy_risk : patch.dormancyRisk ? 1 : 0,
      patch.attributes ? JSON.stringify(patch.attributes) : c.attributes_json,
      this.now(),
      id,
    );
    audit(this.db, this.clock, actor, 'CUSTOMER_UPDATE', 'customer', id, patch);
  }

  customerRow(id: string) {
    const c = this.db.get<any>('SELECT * FROM customer WHERE customer_id = ? OR customer_ref = ?', id, id);
    if (!c) throw new MxpError('NOT_FOUND', `Customer ${id} not found.`, 404);
    return c;
  }

  contextFor(customerId: string, opts: { accountId?: string | null; asOf?: string } = {}): EvalContext {
    const c = this.customerRow(customerId);
    const asOf = opts.asOf ?? this.now();
    const accounts = this.db.all<any>('SELECT * FROM account WHERE customer_id = ?', c.customer_id);
    const lastTxn = this.db.value<string>(
      `SELECT MAX(occurred_at) FROM "transaction" WHERE customer_id = ? AND event_type = 'TRANSACTION' AND status = 'PROCESSED' AND occurred_at < ?`,
      c.customer_id, asOf,
    );
    const day = asOf.slice(0, 10);
    const acct = opts.accountId ? accounts.find((a) => a.account_id === opts.accountId) : undefined;
    return {
      customer: {
        ...parseJson<Record<string, unknown>>(c.attributes_json, {}),
        id: c.customer_id,
        segment: c.segment_code,
        state: c.state_code,
        timezone: c.timezone,
        status: c.status,
        kyc_status: c.kyc_status,
        dormancy_risk: !!c.dormancy_risk,
        tenure_days: Math.max(0, daysBetween(c.created_at.slice(0, 10), day)),
        days_since_last_txn: lastTxn ? Math.max(0, daysBetween(lastTxn.slice(0, 10), day)) : 9999,
        products: [...new Set(accounts.filter((a) => a.status === 'ACTIVE').map((a) => a.product_family))],
      },
      account: acct
        ? { id: acct.account_id, type: acct.account_type, status: acct.status, product_family: acct.product_family, state: acct.state_code }
        : opts.accountId
          ? { id: opts.accountId }
          : null,
      settings: this.settingsFor(c.customer_id, day),
      enrollments: this.db
        .all<{ rule_code: string }>("SELECT rule_code FROM mission_enrollment WHERE customer_id = ? AND status = 'ENROLLED'", c.customer_id)
        .map((r) => r.rule_code),
    };
  }

  /** Promote due pending values, then return settings the engine understands. */
  settingsFor(customerId: string, asOfDay?: string): CustomerSettingInput[] {
    const day = asOfDay ?? localParts(this.now(), 'UTC').date;
    const rows = this.db.all<any>("SELECT * FROM customer_setting WHERE customer_id = ? AND status = 'ACTIVE'", customerId);
    const out: CustomerSettingInput[] = [];
    for (const r of rows) {
      // Promote scheduled change when its day has arrived.
      if (r.pending_values_json && r.pending_from && r.pending_from <= day) {
        this.db.run(
          'UPDATE customer_setting SET values_json = ?, effective_from = ?, pending_values_json = NULL, pending_from = NULL, updated_at = ? WHERE setting_id = ?',
          r.pending_values_json, r.pending_from, this.now(), r.setting_id,
        );
        r.values_json = r.pending_values_json;
        r.effective_from = r.pending_from;
        r.pending_values_json = null;
        r.pending_from = null;
      }
      out.push({
        settingId: r.setting_id,
        customerId: r.customer_id,
        ruleCode: r.rule_code,
        values: JSON.parse(r.values_json),
        status: r.status,
        effectiveFrom: r.effective_from,
        effectiveTo: r.pending_from ? this.dayBefore(r.pending_from) : null,
        version: 1,
      });
      if (r.pending_values_json && r.pending_from) {
        out.push({
          settingId: r.setting_id,
          customerId: r.customer_id,
          ruleCode: r.rule_code,
          values: JSON.parse(r.pending_values_json),
          status: r.status,
          effectiveFrom: r.pending_from,
          effectiveTo: null,
          version: 2,
        });
      }
    }
    return out;
  }

  private dayBefore(isoDate: string) {
    const d = new Date(`${isoDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  setControl(customerId: string, ruleCode: string, values: Record<string, unknown>, actor: Actor, opts: { via?: SettingVia; reason?: string; effectiveFrom?: string } = {}) {
    const c = this.customerRow(customerId);
    const { engine } = this.catalog.engine();
    const r = engine.getRule(ruleCode);
    if (!r || r.rule.status !== 'ACTIVE') throw new MxpError('NOT_LIVE', `Rule ${ruleCode} is not live.`, 404);
    if (r.family !== 'SPEND_CONTROL') throw new MxpError('NOT_A_CONTROL', `${ruleCode} is a bank-defined mission; customers do not set its values.`, 422);
    const ctx = this.contextFor(c.customer_id);
    if (!engine.availableFor(ctx).some((a) => a.code === ruleCode)) throw new MxpError('NOT_ELIGIBLE', `${ruleCode} is not offered to this customer (segment ${c.segment_code}).`, 422);

    const existing = this.db.get<any>("SELECT * FROM customer_setting WHERE customer_id = ? AND rule_code = ? AND status = 'ACTIVE'", c.customer_id, ruleCode);
    const lastChangedAt = existing?.updated_at ?? null;
    const backdate = !!opts.effectiveFrom && ['ADMIN', 'TEST', 'SEED'].includes(opts.via ?? 'APP');
    const plan = engine.planSettingChange(ruleCode, values, { now: this.now(), timezone: c.timezone, lastChangedAt: backdate ? null : lastChangedAt });
    const today = localParts(this.now(), c.timezone).date;
    const errors = plan.issues.filter((i) => i.severity === 'error');
    if (errors.length) throw new MxpError('INVALID_SETTING', errors.map((e) => e.message).join(' '), 422, errors);

    // First setting takes effect today; changes follow the rule's NEXT_WINDOW / IMMEDIATE policy.
    let effectiveFrom = backdate ? opts.effectiveFrom! : existing ? plan.effectiveFrom : today;
    const now = opts.via === 'SEED' && backdate ? `${effectiveFrom}T00:00:00.000Z` : this.now();

    return this.db.tx(() => {
      if (!existing) {
        const settingId = uid();
        this.db.run(
          `INSERT INTO customer_setting(setting_id, customer_id, rule_code, values_json, effective_from, status, created_via, updated_at)
           VALUES (?,?,?,?,?,'ACTIVE',?,?)`,
          settingId, c.customer_id, ruleCode, JSON.stringify(values), effectiveFrom, opts.via ?? 'APP', now,
        );
        audit(this.db, this.clock, actor, 'SETTING_CREATE', 'customer_setting', settingId, { customerId: c.customer_id, ruleCode, values, effectiveFrom, via: opts.via ?? 'APP' });
        return { settingId, version: 1, effectiveFrom, description: engine.describe(ruleCode, values), warnings: plan.issues.filter((i) => i.severity !== 'error') };
      }

      if (effectiveFrom > today) {
        this.db.run(
          'UPDATE customer_setting SET pending_values_json = ?, pending_from = ?, updated_at = ? WHERE setting_id = ?',
          JSON.stringify(values), effectiveFrom, now, existing.setting_id,
        );
      } else {
        this.db.run(
          'UPDATE customer_setting SET values_json = ?, effective_from = ?, pending_values_json = NULL, pending_from = NULL, updated_at = ? WHERE setting_id = ?',
          JSON.stringify(values), effectiveFrom, now, existing.setting_id,
        );
      }
      audit(this.db, this.clock, actor, 'SETTING_CHANGE', 'customer_setting', existing.setting_id, { customerId: c.customer_id, ruleCode, values, effectiveFrom, via: opts.via ?? 'APP' });
      return { settingId: existing.setting_id as string, version: 2, effectiveFrom, description: engine.describe(ruleCode, values), warnings: plan.issues.filter((i) => i.severity !== 'error') };
    });
  }

  cancelControl(customerId: string, ruleCode: string, actor: Actor, reason?: string) {
    const c = this.customerRow(customerId);
    const s = this.db.get<any>("SELECT * FROM customer_setting WHERE customer_id = ? AND rule_code = ? AND status = 'ACTIVE'", c.customer_id, ruleCode);
    if (!s) throw new MxpError('NOT_FOUND', `No active ${ruleCode} setting.`, 404);
    const now = this.now();
    this.db.run("UPDATE customer_setting SET status = 'CANCELLED', pending_values_json = NULL, pending_from = NULL, cancelled_at = ?, updated_at = ? WHERE setting_id = ?", now, now, s.setting_id);
    audit(this.db, this.clock, actor, 'SETTING_CANCEL', 'customer_setting', s.setting_id, { customerId: c.customer_id, ruleCode, reason });
  }

  enroll(customerId: string, ruleCode: string, actor: Actor, source: 'OPT_IN' | 'ADMIN' | 'TEST' | 'SEED' = 'OPT_IN') {
    const c = this.customerRow(customerId);
    const { engine } = this.catalog.engine();
    const r = engine.getRule(ruleCode);
    if (!r || r.family !== 'MISSION') throw new MxpError('NOT_A_MISSION', `${ruleCode} is not a live mission.`, 422);
    if (r.rule.enrollment !== 'OPT_IN') throw new MxpError('AUTO_ENROLLED', `${ruleCode} enrols every eligible customer automatically.`, 422);
    if (!engine.availableFor(this.contextFor(c.customer_id)).some((a) => a.code === ruleCode)) throw new MxpError('NOT_ELIGIBLE', `${ruleCode} is not offered to this customer.`, 422);
    this.db.run(
      `INSERT INTO mission_enrollment(customer_id, rule_code, status, source, enrolled_at) VALUES (?,?,'ENROLLED',?,?)
       ON CONFLICT(customer_id, rule_code) DO UPDATE SET status = 'ENROLLED', source = excluded.source, enrolled_at = excluded.enrolled_at, opted_out_at = NULL`,
      c.customer_id, ruleCode, source, this.now(),
    );
    audit(this.db, this.clock, actor, 'MISSION_ENROLL', 'mission_enrollment', `${c.customer_id}/${ruleCode}`);
  }

  optOut(customerId: string, ruleCode: string, actor: Actor) {
    const c = this.customerRow(customerId);
    const r = this.db.run(
      "UPDATE mission_enrollment SET status = 'OPTED_OUT', opted_out_at = ? WHERE customer_id = ? AND rule_code = ? AND status = 'ENROLLED'",
      this.now(), c.customer_id, ruleCode,
    );
    if (!r.changes) throw new MxpError('NOT_FOUND', 'Not enrolled.', 404);
    audit(this.db, this.clock, actor, 'MISSION_OPT_OUT', 'mission_enrollment', `${c.customer_id}/${ruleCode}`);
  }

  offers(customerId: string) {
    const c = this.customerRow(customerId);
    const { engine } = this.catalog.engine();
    const ctx = this.contextFor(c.customer_id);
    const today = localParts(this.now(), c.timezone).date;
    const settings = ctx.settings ?? [];
    return engine.availableFor(ctx).map((a) => {
      const r = engine.getRule(a.code)!;
      const mine = settings.filter((s) => s.ruleCode === a.code && s.status === 'ACTIVE');
      const current = mine.filter((s) => (!s.effectiveFrom || s.effectiveFrom <= today) && (!s.effectiveTo || s.effectiveTo >= today)).sort((x, y) => (y.version ?? 1) - (x.version ?? 1))[0];
      const scheduled = mine.find((s) => s.effectiveFrom && s.effectiveFrom > today);
      const windows = this.db.all<any>(
        `SELECT window_key, status, json_extract(state_json,'$.outcome') AS outcome, json_extract(state_json,'$.value') AS measure_value,
                json_extract(state_json,'$.target') AS target_value, json_extract(state_json,'$.activity') AS activity_count,
                json_extract(state_json,'$.achievedTier') AS achieved_tier, json_extract(state_json,'$.points') AS points_awarded, window_end
         FROM rule_state WHERE prefix = 'w|' AND customer_id = ? AND rule_code = ? ORDER BY window_key DESC LIMIT 6`,
        c.customer_id, a.code,
      );
      return {
        ...a,
        params: r.family === 'SPEND_CONTROL' ? engine.customerParams(a.code) : [],
        policy: r.rule.settingsPolicy,
        current: current ? { settingId: current.settingId, version: current.version, values: current.values, effectiveFrom: current.effectiveFrom, description: describeRule(r.rule, r.template, current.values) } : null,
        scheduled: scheduled ? { version: scheduled.version, values: scheduled.values, effectiveFrom: scheduled.effectiveFrom } : null,
        windows,
      };
    });
  }

  accountsOf(customerId: string) {
    return this.db.all<any>('SELECT * FROM account WHERE customer_id = ? ORDER BY opened_on', customerId);
  }
}

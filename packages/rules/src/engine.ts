/**
 * RulesEngine: evaluates events against a rule pack.
 *
 *   const engine = RulesEngine.fromPack(json);
 *   engine.check(event, ctx, store)   // real-time decision for a spend (ALLOW / WARN / ALERT / BLOCK), nothing persisted
 *   engine.process(event, ctx, store) // applies the event: progress, breaches, awards, nudges
 *   engine.close(asOfDate, store)     // closes finished windows: compliance rewards, end-of-window missions
 *
 * The engine is deterministic and side-effect free apart from the StateStore it
 * is given. Awards are returned as effects with idempotency keys; the host posts
 * them to its own ledger.
 */
import { evalCondition, type CondTrace } from './conditions';
import { DEFAULT_FACTS, DEFAULT_REFERENCES, factIndex, frameOf, resolvePath, type FactFrame } from './facts';
import { describeRule, money, num } from './format';
import { checkCustomerValues, effectiveParam, resolveValues, substitute, type Issue } from './params';
import {
  CALENDAR_WINDOWS,
  type CustomerSettingInput,
  type EvalContext,
  type FactDef,
  type Family,
  type GoalOp,
  type Logic,
  type MxpEvent,
  type ParamDef,
  type Rule,
  type RulePack,
  type RuleTemplate,
} from './schema';
import { Overlay, type Contribution, type IndexEntry, type LifetimeState, type RollingState, type StateStore, type WindowState } from './store';
import { addDays, daysBetween, localParts, nextPeriod, periodOf, previousPeriod, type CalendarWindow } from './time';
import { validatePack } from './validate';

export type Outcome =
  | 'NOT_EFFECTIVE' | 'NOT_ELIGIBLE' | 'NOT_ENROLLED' | 'INVALID_SETTING' | 'OUT_OF_SCOPE' | 'NOT_MATCHED' | 'DUPLICATE' | 'WINDOW_CLOSED'
  | 'PROGRESS' | 'GOAL_MET' | 'AWARDED' | 'CAPPED' | 'WITHIN_LIMIT' | 'WARNING' | 'BREACH' | 'REVERSED' | 'STREAK_BROKEN'
  | 'COMPLIANT' | 'BREACHED' | 'MISSED' | 'NO_ACTIVITY' | 'CANCELLED' | 'CLOSED';

export type Decision = 'ALLOW' | 'WARN' | 'ALERT' | 'BLOCK';
const DECISION_RANK: Record<Decision, number> = { ALLOW: 0, WARN: 1, ALERT: 2, BLOCK: 3 };

export interface Evaluation {
  trigger: 'EVENT' | 'CLOSE';
  eventId?: string;
  ruleCode: string;
  ruleVersion: number;
  ruleName: string;
  templateCode: string;
  family: Family;
  customerId: string;
  subjectKey: string;
  settingId?: string | null;
  windowKey?: string;
  outcome: Outcome;
  decision?: Decision;
  before?: number;
  after?: number;
  target?: number | null;
  points: number;
  message: string;
  trace?: { eligibility?: CondTrace; scope?: CondTrace; filter?: CondTrace };
  issues?: Issue[];
}

interface EffectBase {
  customerId: string;
  ruleCode: string;
  ruleVersion: number;
  family: Family;
  subjectKey: string;
  windowKey: string;
  eventId?: string;
}
export interface PointsEffect extends EffectBase {
  type: 'AWARD' | 'CLAWBACK';
  slot: string;
  points: number;
  idempotencyKey: string;
  reason: string;
}
export interface BreachEffect extends EffectBase {
  type: 'BREACH';
  settingId: string | null;
  limit: number;
  value: number;
  action: 'ALERT' | 'BLOCK';
}
export interface NudgeEffect extends EffectBase {
  type: 'NUDGE';
  kind: 'LIMIT_WARNING' | 'LIMIT_BREACHED' | 'NEAR_GOAL' | 'AWARDED' | 'CLAWBACK' | 'STREAK_BROKEN' | 'COMPLIANT';
  message: string;
  dedupeKey: string;
}
export type Effect = PointsEffect | BreachEffect | NudgeEffect;

export interface ProcessResult {
  decision: Decision;
  evaluations: Evaluation[];
  effects: Effect[];
  points: number;
}

export class RulePackError extends Error {
  constructor(readonly issues: (Issue & { doc?: string })[]) {
    super(`Rule pack is invalid: ${issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => `${i.doc ? `${i.doc}: ` : ''}${i.message}`).join('; ')}`);
  }
}

interface Compiled {
  rule: Rule;
  template: RuleTemplate;
  family: Family;
  customerParams: ParamDef[];
}

interface Instance {
  subjectKey: string;
  accountId: string | null;
  settingId: string | null;
  settingVersion: number | null;
  values: Record<string, unknown>;
  issues?: Issue[];
}

interface WindowInfo {
  key: string;
  start: string;
  end: string;
  closeAfter: string;
  rollingDays?: number;
}

const FAR = '9999-12-31';
const wKey = (rule: string, subject: string, window: string) => `w|${rule}|${subject}|${window}`;
const rKey = (rule: string, subject: string) => `r|${rule}|${subject}`;
const lKey = (rule: string, subject: string) => `l|${rule}|${subject}`;
const xKey = (rule: string, subject: string, eventId: string) => `x|${rule}|${subject}|${eventId}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function goalMet(v: number, op: GoalOp, t: number): boolean {
  switch (op) {
    case 'gte': return v >= t - 1e-9;
    case 'gt': return v > t + 1e-9;
    case 'lte': return v <= t + 1e-9;
    case 'lt': return v < t - 1e-9;
    case 'eq': return Math.abs(v - t) < 1e-9;
  }
}

export interface EngineOptions {
  /** Drop rules that fail validation instead of rejecting the whole pack. */
  skipInvalidRules?: boolean;
}

export class RulesEngine {
  readonly pack: RulePack;
  readonly issues: (Issue & { doc?: string })[];
  readonly references: Record<string, string[]>;
  readonly facts: FactDef[];
  private factMap: Map<string, FactDef>;
  private compiled = new Map<string, Compiled>();
  private byEvent = new Map<string, Compiled[]>();
  private templates = new Map<string, RuleTemplate>();

  static fromPack(input: unknown, opts: EngineOptions = {}): RulesEngine {
    const r = validatePack(input);
    if (!r.pack) throw new RulePackError(r.issues);
    const errors = r.issues.filter((i) => i.severity === 'error');
    if (errors.length && !opts.skipInvalidRules) throw new RulePackError(r.issues);
    let pack = r.pack;
    if (errors.length) {
      const badTemplates = new Set(errors.filter((e) => e.doc?.startsWith('template ')).map((e) => e.doc!.slice(9)));
      const badRules = new Set(errors.filter((e) => e.doc?.startsWith('rule ')).map((e) => e.doc!.slice(5)));
      pack = { ...pack, templates: pack.templates.filter((t) => !badTemplates.has(t.code)), rules: pack.rules.filter((x) => !badRules.has(x.code) && !badTemplates.has(x.template)) };
    }
    return new RulesEngine(pack, r.issues);
  }

  /** Use fromPack() unless the pack is already validated. */
  constructor(pack: RulePack, issues: (Issue & { doc?: string })[] = []) {
    this.pack = pack;
    this.issues = issues;
    this.references = { ...DEFAULT_REFERENCES, ...pack.references };
    this.facts = pack.facts ?? DEFAULT_FACTS;
    this.factMap = factIndex(this.facts);
    for (const t of pack.templates) this.templates.set(t.code, t);
    const sorted = [...pack.rules].sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code));
    for (const rule of sorted) {
      const template = this.templates.get(rule.template);
      if (!template) continue;
      const c: Compiled = { rule, template, family: template.family, customerParams: template.params.filter((p) => p.setBy === 'CUSTOMER') };
      this.compiled.set(rule.code, c);
      for (const e of template.logic.events) {
        const list = this.byEvent.get(e) ?? [];
        list.push(c);
        this.byEvent.set(e, list);
      }
    }
  }

  // ---------- catalogue ----------
  listRules(): { code: string; name: string; family: Family; template: string; status: string; segments: string[]; featured: boolean; summary: string }[] {
    return [...this.compiled.values()].map(({ rule, template, family }) => ({
      code: rule.code, name: rule.name, family, template: template.code, status: rule.status, segments: rule.segments, featured: rule.featured, summary: describeRule(rule, template, undefined, this.pack.currency),
    }));
  }

  getRule(code: string): { rule: Rule; template: RuleTemplate; family: Family } | undefined {
    const c = this.compiled.get(code);
    return c && { rule: c.rule, template: c.template, family: c.family };
  }

  getTemplate(code: string): RuleTemplate | undefined {
    return this.templates.get(code);
  }

  describe(code: string, customerValues?: Record<string, unknown>): string {
    const c = this.must(code);
    return describeRule(c.rule, c.template, customerValues, this.pack.currency);
  }

  /** Customer-facing parameter definitions (template narrowed by bank bounds). */
  customerParams(code: string): (ParamDef & { maxItems?: number })[] {
    const c = this.must(code);
    return c.customerParams.map((p) => {
      const eff = effectiveParam(p, c.rule.customerParams[p.name]);
      return { ...eff, options: eff.options ?? (eff.optionsFrom ? this.references[eff.optionsFrom] : undefined) };
    });
  }

  validateSetting(code: string, values: Record<string, unknown>): Issue[] {
    const c = this.must(code);
    if (c.family !== 'SPEND_CONTROL') return [{ severity: 'error', code: 'NOT_A_CONTROL', path: '', message: `${code} is a bank-defined mission; customers do not set its values.` }];
    return checkCustomerValues(c.rule, c.template, values, this.references);
  }

  /**
   * Plans a customer's new or changed spend-control setting: validates the values,
   * applies the bank's cooldown, and works out when it takes effect.
   */
  planSettingChange(code: string, values: Record<string, unknown>, opts: { now: string; timezone?: string | null; lastChangedAt?: string | null }): { issues: Issue[]; effectiveFrom: string } {
    const c = this.must(code);
    const issues = this.validateSetting(code, values);
    const tz = this.tzFor(c, opts.timezone ?? null);
    const today = localParts(opts.now, tz).date;
    const policy = c.rule.settingsPolicy;
    if (opts.lastChangedAt && policy.cooldownDays > 0) {
      const last = localParts(opts.lastChangedAt, tz).date;
      const wait = policy.cooldownDays - daysBetween(last, today);
      if (wait > 0) issues.push({ severity: 'error', code: 'COOLDOWN', path: '', message: `This control can be changed again in ${wait} day(s).` });
    }
    let effectiveFrom = today;
    if (policy.changeEffective === 'NEXT_WINDOW') {
      const logic = substitute(c.template.logic, resolveValues(c.rule, c.template, values));
      const wt = String(logic.window.type);
      const cal = (wt === 'ROLLING_DAYS' ? logic.window.period ?? 'DAY' : wt) as CalendarWindow;
      if ((CALENDAR_WINDOWS as readonly string[]).includes(cal)) effectiveFrom = nextPeriod(periodOf(today, cal), cal).start;
    }
    return { issues, effectiveFrom };
  }

  /** Missions the customer can see and spend controls the customer can set, on a date. */
  availableFor(ctx: EvalContext, date?: string): { code: string; name: string; family: Family; template: string; icon?: string; summary: string; enrolled: boolean; enrollment: string; featured: boolean }[] {
    const out = [];
    for (const c of this.compiled.values()) {
      if (c.rule.status !== 'ACTIVE') continue;
      const tz = this.tzFor(c, ctx.customer.timezone ?? null);
      const d = date ?? localParts(new Date().toISOString(), tz).date;
      if (!this.effectiveOn(c.rule, d)) continue;
      const frame = frameOf(null, ctx, tz);
      if (!this.eligible(c.rule, frame, ctx).pass) continue;
      const enrolled = c.family === 'MISSION' ? c.rule.enrollment === 'AUTO' || !!ctx.enrollments?.includes(c.rule.code) : !!ctx.settings?.some((s) => s.ruleCode === c.rule.code && (s.status ?? 'ACTIVE') === 'ACTIVE');
      out.push({ code: c.rule.code, name: c.rule.name, family: c.family, template: c.template.code, icon: c.template.icon, summary: describeRule(c.rule, c.template, undefined, this.pack.currency), enrolled, enrollment: c.family === 'MISSION' ? c.rule.enrollment : 'SETTING', featured: c.rule.featured });
    }
    return out;
  }

  // ---------- evaluation ----------
  /** Real-time decision for a proposed event. Nothing is persisted. */
  check(event: MxpEvent, ctx: EvalContext, store: StateStore): ProcessResult {
    return this.run(event, ctx, store, true);
  }

  process(event: MxpEvent, ctx: EvalContext, store: StateStore): ProcessResult {
    return this.run(event, ctx, store, false);
  }

  private run(event: MxpEvent, ctx: EvalContext, store: StateStore, dry: boolean): ProcessResult {
    if (!event?.id || !event.type || !event.customerId || !event.timestamp) throw new Error('Event needs id, type, customerId and timestamp.');
    if (Number.isNaN(new Date(event.timestamp).getTime())) throw new Error(`Invalid event timestamp: ${event.timestamp}`);
    const st = new Overlay(store);
    const evaluations: Evaluation[] = [];
    const effects: Effect[] = [];
    for (const c of this.byEvent.get(event.type) ?? []) {
      if (c.rule.status !== 'ACTIVE') continue;
      for (const inst of this.instances(c, event, ctx)) evaluations.push(this.apply(c, inst, event, ctx, st, effects));
    }
    if (!dry) st.commit();
    return summarize(evaluations, effects);
  }

  /**
   * Closes every window that ended before `asOf` (YYYY-MM-DD): pays compliance rewards for
   * spend controls kept within limit, and end-of-window mission rewards (averages).
   * `contextFor` lets the engine confirm a spend-control setting was still active at window end.
   */
  close(asOf: string, store: StateStore, contextFor?: (customerId: string) => EvalContext | undefined): ProcessResult {
    const st = new Overlay(store);
    const evaluations: Evaluation[] = [];
    const effects: Effect[] = [];
    for (const w of st.dueWindows(asOf)) evaluations.push(this.closeWindow(w, st, effects, contextFor));
    st.commit();
    return summarize(evaluations, effects);
  }

  // ---------- internals ----------
  private must(code: string): Compiled {
    const c = this.compiled.get(code);
    if (!c) throw new Error(`Unknown rule ${code}`);
    return c;
  }

  private tzFor(c: Compiled, customerTz: string | null): string {
    const w = c.template.logic.window.timezone;
    if (w === 'CUSTOMER') return customerTz || this.pack.timezone;
    return w || this.pack.timezone;
  }

  private effectiveOn(rule: Rule, date: string): boolean {
    return (!rule.effective.from || date >= rule.effective.from) && (!rule.effective.to || date <= rule.effective.to);
  }

  private eligible(rule: Rule, frame: FactFrame, ctx: EvalContext): CondTrace {
    const segOk = !rule.segments.length || rule.segments.includes(String(ctx.customer.segment ?? ''));
    const seg: CondTrace = { pass: segOk, text: rule.segments.length ? `customer.segment in [${rule.segments.join(', ')}] (actual ${ctx.customer.segment ?? '∅'})` : 'all segments' };
    const cond = evalCondition(rule.eligibility, frame);
    return { pass: seg.pass && cond.pass, text: 'eligibility', children: [seg, cond] };
  }

  private instances(c: Compiled, event: MxpEvent, ctx: EvalContext): Instance[] {
    const tz = this.tzFor(c, ctx.customer.timezone ?? null);
    const date = localParts(event.timestamp, tz).date;
    const acct = event.accountId ?? ctx.account?.id ?? null;
    const subjectBase = c.template.logic.subject === 'ACCOUNT' ? `${event.customerId}/${acct ?? '-'}` : event.customerId;
    if (c.family === 'MISSION') return [{ subjectKey: subjectBase, accountId: acct, settingId: null, settingVersion: null, values: resolveValues(c.rule, c.template) }];
    // Spend control: one instance per active customer setting effective on the event date.
    const best = new Map<string, CustomerSettingInput>();
    for (const s of ctx.settings ?? []) {
      if (s.ruleCode !== c.rule.code || (s.status ?? 'ACTIVE') !== 'ACTIVE') continue;
      if (s.customerId !== event.customerId) continue;
      if (s.effectiveFrom && date < s.effectiveFrom) continue;
      if (s.effectiveTo && date > s.effectiveTo) continue;
      const prev = best.get(s.settingId);
      if (!prev || (s.version ?? 1) > (prev.version ?? 1)) best.set(s.settingId, s);
    }
    return [...best.values()].map((s) => {
      const issues = checkCustomerValues(c.rule, c.template, s.values, this.references).filter((i) => i.severity === 'error');
      return { subjectKey: `${subjectBase}#${s.settingId}`, accountId: acct, settingId: s.settingId, settingVersion: s.version ?? 1, values: resolveValues(c.rule, c.template, s.values), issues };
    });
  }

  private windowFor(logic: Logic, rule: Rule, date: string): WindowInfo | null {
    const w = logic.window;
    const type = String(w.type);
    const grace = w.graceDays ?? 0;
    if (type === 'LIFETIME') return { key: 'LIFETIME', start: rule.effective.from ?? '0000-01-01', end: FAR, closeAfter: FAR };
    if (type === 'FIXED') {
      const from = String(w.from), to = String(w.to);
      if (date < from || date > to) return null;
      return { key: `${from}..${to}`, start: from, end: to, closeAfter: addDays(to, grace) };
    }
    if (type === 'ROLLING_DAYS') {
      const p = periodOf(date, (w.period ?? 'DAY') as CalendarWindow);
      return { key: p.key, start: p.start, end: p.end, closeAfter: addDays(p.end, grace), rollingDays: Number(w.days) };
    }
    const p = periodOf(date, type as CalendarWindow);
    return { key: p.key, start: p.start, end: p.end, closeAfter: addDays(p.end, grace) };
  }

  private newWindow(c: Compiled, inst: Instance, customerId: string, win: WindowInfo, target: number | null, now: string): WindowState {
    return {
      key: wKey(c.rule.code, inst.subjectKey, win.key), ruleCode: c.rule.code, ruleVersion: c.rule.version, family: c.family, subjectKey: inst.subjectKey, customerId,
      accountId: inst.accountId, settingId: inst.settingId, settingVersion: inst.settingVersion, windowKey: win.key, windowStart: win.start, windowEnd: win.end, closeAfter: win.closeAfter,
      status: 'OPEN', outcome: 'IN_PROGRESS', value: 0, target, activity: 0, matched: 0, contributions: {}, breaches: 0, firstBreachAt: null, warned: false, nudged: [],
      achievedTier: 0, awards: {}, points: 0, params: inst.values, updatedAt: now,
    };
  }

  private isMoney(logic: Logic): boolean {
    const f = logic.measure.field;
    return (logic.measure.type === 'SUM' || logic.measure.type === 'AVG_DAILY') && !!f && this.factMap.get(f)?.type === 'money';
  }

  private fmtV(logic: Logic, v: number | null | undefined): string {
    if (v === null || v === undefined) return '—';
    return this.isMoney(logic) ? money(v, this.pack.currency) : num(v);
  }

  private computeValue(logic: Logic, contribs: Contribution[], win: WindowInfo | { start: string; end: string; rollingDays?: number }, asOfDate: string): number {
    const m = logic.measure;
    let list = contribs;
    if (win.rollingDays) {
      const from = addDays(asOfDate, -(win.rollingDays - 1));
      list = list.filter((c) => c.day >= from && c.day <= asOfDate);
    }
    const cap = m.perDayCap !== undefined ? Number(m.perDayCap) : Infinity;
    const byDay = new Map<string, number>();
    switch (m.type) {
      case 'COUNT':
      case 'SUM': {
        for (const c of list) byDay.set(c.day, (byDay.get(c.day) ?? 0) + c.amount);
        let total = 0;
        for (const v of byDay.values()) total += Math.min(v, cap);
        return round2(total);
      }
      case 'COUNT_DISTINCT':
        return new Set(list.map((c) => c.key)).size;
      case 'DISTINCT_DAYS':
        return new Set(list.map((c) => c.day)).size;
      case 'AVG_DAILY': {
        const latest = new Map<string, Contribution>();
        for (const c of list) {
          const p = latest.get(c.day);
          if (!p || c.at >= p.at) latest.set(c.day, c);
        }
        if (!latest.size) return 0;
        const total = [...latest.values()].reduce((s, c) => s + c.amount, 0);
        const days = m.denominator === 'WINDOW_DAYS' && win.end !== FAR ? daysBetween(win.start, win.end) + 1 : latest.size;
        return round2(total / days);
      }
      case 'STREAK':
        return 0;
    }
  }

  private tiersOf(logic: Logic): { target: number; points: number; label?: string }[] {
    const g = logic.goal;
    if (!g) return [];
    if (g.tiers?.length) {
      const raw = g.tiers.map((t) => ({ target: Number(t.target), points: Number(t.points), label: t.label }));
      if (logic.reward.tierMode === 'HIGHEST_ONLY') return raw.map((t, i) => ({ ...t, points: Math.max(0, t.points - (i ? raw[i - 1].points : 0)) }));
      return raw;
    }
    return g.target === undefined ? [] : [{ target: Number(g.target), points: Number(logic.reward.points ?? 0) }];
  }

  private grant(c: Compiled, logic: Logic, w: WindowState, life: LifetimeState, slot: string, points: number, effects: Effect[], reason: string, trigger: string): number {
    if (w.awards[slot] !== undefined || points <= 0) return 0;
    const r = logic.reward;
    let p = points;
    if (r.capPointsPerWindow !== undefined) p = Math.min(p, Number(r.capPointsPerWindow) - w.points);
    if (r.capPointsLifetime !== undefined) p = Math.min(p, Number(r.capPointsLifetime) - life.points);
    if (r.maxAwardsPerWindow !== undefined && Object.keys(w.awards).length >= Number(r.maxAwardsPerWindow)) p = 0;
    if (r.maxAwards !== undefined && life.awards >= Number(r.maxAwards)) p = 0;
    if (p <= 0) return 0;
    w.awards[slot] = p;
    w.points += p;
    life.points += p;
    life.awards += 1;
    const base = { customerId: w.customerId, ruleCode: c.rule.code, ruleVersion: c.rule.version, family: c.family, subjectKey: w.subjectKey, windowKey: w.windowKey };
    effects.push({ ...base, type: 'AWARD', slot, points: p, idempotencyKey: `AWARD|${c.rule.code}|${w.subjectKey}|${w.windowKey}|${slot}|${trigger}`, reason, eventId: trigger === 'close' ? undefined : trigger });
    effects.push({ ...base, type: 'NUDGE', kind: 'AWARDED', message: `You earned ${num(p)} points: ${c.rule.name}.`, dedupeKey: `AWARDED|${c.rule.code}|${w.subjectKey}|${w.windowKey}|${slot}|${trigger}` });
    return p;
  }

  private clawback(c: Compiled, w: WindowState, life: LifetimeState, slot: string, effects: Effect[], eventId: string, reason: string): number {
    const p = w.awards[slot];
    if (p === undefined) return 0;
    delete w.awards[slot];
    w.points -= p;
    life.points -= p;
    life.awards = Math.max(0, life.awards - 1);
    const base = { customerId: w.customerId, ruleCode: c.rule.code, ruleVersion: c.rule.version, family: c.family, subjectKey: w.subjectKey, windowKey: w.windowKey, eventId };
    effects.push({ ...base, type: 'CLAWBACK', slot, points: -p, idempotencyKey: `CLAWBACK|${c.rule.code}|${w.subjectKey}|${w.windowKey}|${slot}|${eventId}`, reason });
    effects.push({ ...base, type: 'NUDGE', kind: 'CLAWBACK', message: `${num(p)} points from ${c.rule.name} were reversed: ${reason}`, dedupeKey: `CLAWBACK|${c.rule.code}|${w.subjectKey}|${w.windowKey}|${slot}|${eventId}` });
    return -p;
  }

  private apply(c: Compiled, inst: Instance, event: MxpEvent, ctx: EvalContext, st: StateStore, effects: Effect[]): Evaluation {
    const tz = this.tzFor(c, ctx.customer.timezone ?? null);
    const frame = frameOf(event, ctx, tz);
    const date = (frame.event.local as { date: string }).date;
    const ev: Evaluation = {
      trigger: 'EVENT', eventId: event.id, ruleCode: c.rule.code, ruleVersion: c.rule.version, ruleName: c.rule.name, templateCode: c.template.code, family: c.family,
      customerId: event.customerId, subjectKey: inst.subjectKey, settingId: inst.settingId, outcome: 'NOT_MATCHED', points: 0, message: '', trace: {},
    };
    const done = (outcome: Outcome, message: string, extra: Partial<Evaluation> = {}) => Object.assign(ev, { outcome, message }, extra);
    const logic = substitute(c.template.logic, inst.values) as Logic;
    const tiers = this.tiersOf(logic);

    // Reversals act on state that already exists, so they bypass scope, eligibility and effective dates
    // (a refund is usually a credit, and may arrive after the rule ended).
    if (event.reversalOf) {
      if (logic.measure.type === 'STREAK') return done('NOT_MATCHED', 'Streak contributions are not reversible; send a breaking event instead.');
      if (st.get<IndexEntry>(xKey(c.rule.code, inst.subjectKey, event.id))) return done('DUPLICATE', 'Event already processed for this rule.');
      return this.applyReversal(c, inst, logic, event, tiers, st, effects, ev);
    }

    if (!this.effectiveOn(c.rule, date)) return done('NOT_EFFECTIVE', `Rule is effective ${c.rule.effective.from ?? '…'} to ${c.rule.effective.to ?? '…'}; event date ${date}.`);
    if (inst.issues?.length) return done('INVALID_SETTING', `Customer setting no longer fits the bank's bounds: ${inst.issues.map((i) => i.message).join(' ')}`, { issues: inst.issues });
    const elig = this.eligible(c.rule, frame, ctx);
    ev.trace!.eligibility = elig;
    if (!elig.pass) return done('NOT_ELIGIBLE', 'Customer is not eligible for this rule.');
    if (c.family === 'MISSION' && c.rule.enrollment === 'OPT_IN' && !ctx.enrollments?.includes(c.rule.code)) return done('NOT_ENROLLED', 'Mission is opt-in and the customer has not joined.');

    const scope = evalCondition(logic.scope, frame);
    ev.trace!.scope = scope;
    if (!scope.pass) return done('OUT_OF_SCOPE', 'Event is outside the rule scope.');

    const win = this.windowFor(logic, c.rule, date);
    if (!win) return done('NOT_EFFECTIVE', `Event date ${date} is outside the rule window.`);
    ev.windowKey = win.key;
    const target = c.family === 'SPEND_CONTROL' ? Number(logic.goal?.target) : tiers[0]?.target ?? null;
    ev.target = target;

    if (logic.measure.type === 'STREAK') return this.applyStreak(c, inst, logic, event, frame, date, win, tiers, st, effects, ev);

    const key = wKey(c.rule.code, inst.subjectKey, win.key);
    const w = st.get<WindowState>(key) ?? this.newWindow(c, inst, event.customerId, win, target, event.timestamp);
    const life = st.get<LifetimeState>(lKey(c.rule.code, inst.subjectKey)) ?? { key: lKey(c.rule.code, inst.subjectKey), points: 0, awards: 0 };
    const rolling = win.rollingDays ? st.get<RollingState>(rKey(c.rule.code, inst.subjectKey)) ?? { key: rKey(c.rule.code, inst.subjectKey), contributions: {} } : null;

    if (st.get<IndexEntry>(xKey(c.rule.code, inst.subjectKey, event.id))) return done('DUPLICATE', 'Event already processed for this rule.', { before: w.value, after: w.value });
    if (w.status === 'CLOSED') return done('WINDOW_CLOSED', `Window ${win.key} is closed; late event ignored.`);

    w.activity += 1;
    const filter = evalCondition(logic.filter, frame);
    ev.trace!.filter = filter;
    const container = rolling ?? w;
    const before = this.computeValue(logic, Object.values(container.contributions), win, date);
    let cKey = event.id;
    let replaced = false;
    if (logic.measure.dedupeBy) {
      const dk = resolvePath(frame, logic.measure.dedupeBy);
      if (dk !== undefined && dk !== null && dk !== '') {
        cKey = `d:${String(dk)}`;
        if (container.contributions[cKey]) {
          delete container.contributions[cKey];
          replaced = true;
        }
      }
    }
    let counted = false;
    if (filter.pass) {
      const m = logic.measure;
      let amount = 1;
      let dkey: string | undefined;
      if (m.type === 'SUM' || m.type === 'AVG_DAILY') amount = Number(resolvePath(frame, m.field!));
      if (m.type === 'COUNT_DISTINCT') dkey = String(resolvePath(frame, m.field!) ?? '');
      if (!Number.isFinite(amount) || (m.type === 'COUNT_DISTINCT' && !dkey)) {
        ev.issues = [{ severity: 'warning', code: 'MEASURE_FIELD_MISSING', path: m.field ?? '', message: `Event has no usable ${m.field}.` }];
      } else {
        container.contributions[cKey] = { eventId: event.id, day: date, at: event.timestamp, amount, key: dkey };
        w.matched += 1;
        counted = true;
      }
    }
    if (rolling) {
      const from = addDays(date, -(win.rollingDays! + 31));
      for (const [k, v] of Object.entries(rolling.contributions)) if (v.day < from) delete rolling.contributions[k];
      st.set(rolling.key, rolling);
    }
    const after = this.computeValue(logic, Object.values(container.contributions), win, date);
    w.value = after;
    w.updatedAt = event.timestamp;
    st.set(xKey(c.rule.code, inst.subjectKey, event.id), { key: xKey(c.rule.code, inst.subjectKey, event.id), windowKey: win.key, cKey } satisfies IndexEntry);
    Object.assign(ev, { before, after });

    const base = { customerId: event.customerId, ruleCode: c.rule.code, ruleVersion: c.rule.version, family: c.family, subjectKey: inst.subjectKey, windowKey: win.key, eventId: event.id };
    const save = () => {
      st.set(key, w);
      st.set(life.key, life);
    };

    if (!counted && !replaced) {
      save();
      return done('NOT_MATCHED', c.family === 'SPEND_CONTROL' ? 'Counts as activity; not measured by this control.' : 'Event does not meet the mission criteria.', { decision: c.family === 'SPEND_CONTROL' ? 'ALLOW' : undefined });
    }

    // ----- spend control -----
    if (c.family === 'SPEND_CONTROL') {
      const op = logic.goal!.op;
      const limit = Number(logic.goal!.target);
      const action = (logic.control?.action as 'ALERT' | 'BLOCK' | undefined) ?? 'ALERT';
      if (counted && !goalMet(after, op, limit)) {
        w.breaches += 1;
        w.firstBreachAt ??= event.timestamp;
        w.outcome = 'BREACHED';
        effects.push({ ...base, type: 'BREACH', settingId: inst.settingId, limit, value: after, action });
        if (w.breaches === 1)
          effects.push({ ...base, type: 'NUDGE', kind: 'LIMIT_BREACHED', message: `${c.rule.name}: ${this.fmtV(logic, after)} is over your limit of ${this.fmtV(logic, limit)}.${logic.reward.mode === 'WINDOW_COMPLIANCE' ? ` No points for this ${humanWindow(win.key)}.` : ''}`, dedupeKey: `BREACH|${key}` });
        save();
        return done('BREACH', `${this.fmtV(logic, after)} breaches the limit ${opText(op)} ${this.fmtV(logic, limit)}${action === 'BLOCK' ? ' — block' : ' — alert'}.`, { decision: action });
      }
      const warnPct = logic.control?.warnAtPct !== undefined ? Number(logic.control.warnAtPct) : null;
      if (counted && warnPct && limit > 0 && after >= (limit * warnPct) / 100) {
        if (!w.warned) {
          w.warned = true;
          effects.push({ ...base, type: 'NUDGE', kind: 'LIMIT_WARNING', message: `${c.rule.name}: you have used ${Math.round((after / limit) * 100)}% of your limit (${this.fmtV(logic, after)} of ${this.fmtV(logic, limit)}).`, dedupeKey: `WARN|${key}` });
        }
        save();
        return done('WARNING', `${this.fmtV(logic, after)} is ${Math.round((after / limit) * 100)}% of the limit ${this.fmtV(logic, limit)}.`, { decision: 'WARN' });
      }
      save();
      return done('WITHIN_LIMIT', `${this.fmtV(logic, after)} within limit ${this.fmtV(logic, limit)}.`, { decision: 'ALLOW' });
    }

    // ----- mission -----
    const r = logic.reward;
    if (r.mode === 'PER_EVENT') {
      if (!counted) {
        const pts = r.onReversal === 'CLAWBACK' ? this.clawback(c, w, life, `event:${cKey}`, effects, event.id, 'the qualifying item was withdrawn or corrected') : 0;
        save();
        return pts ? done('REVERSED', `Earlier qualifying item withdrawn; ${num(-pts)} points clawed back.`, { points: pts }) : done('PROGRESS', 'Replaced an earlier event with the same key.');
      }
      const slot = `event:${cKey}`;
      if (w.awards[slot] !== undefined) {
        save();
        return done('GOAL_MET', 'Already rewarded for this item.');
      }
      const basis = logic.measure.type === 'SUM' ? container.contributions[cKey].amount : Number(resolvePath(frame, logic.measure.field ?? 'event.amount'));
      const pts = r.perAmount !== undefined ? Math.floor((Number.isFinite(basis) ? basis : 0) / Number(r.perAmount)) * Number(r.points ?? 0) : Number(r.points ?? 0);
      const g = this.grant(c, logic, w, life, slot, pts, effects, `${c.rule.name}`, event.id);
      w.outcome = w.points > 0 ? 'GOAL_MET' : 'IN_PROGRESS';
      save();
      return g > 0 ? done('AWARDED', `Awarded ${num(g)} points.`, { points: g }) : done('CAPPED', 'Reward cap or award limit reached.');
    }

    return this.goalProgress(c, logic, w, life, tiers, effects, event.id, ev, save, base);
  }

  private goalProgress(c: Compiled, logic: Logic, w: WindowState, life: LifetimeState, tiers: { target: number; points: number; label?: string }[], effects: Effect[], trigger: string, ev: Evaluation, save: () => void, base: Omit<NudgeEffect, 'type' | 'kind' | 'message' | 'dedupeKey'>, slotPrefix = ''): Evaluation {
    const op = logic.goal!.op;
    let achieved = 0;
    while (achieved < tiers.length && goalMet(w.value, op, tiers[achieved].target)) achieved++;
    w.achievedTier = achieved;
    w.outcome = achieved > 0 ? 'GOAL_MET' : 'IN_PROGRESS';
    let granted = 0;
    let capped = false;
    let clawed = 0;
    if (logic.reward.mode === 'ON_GOAL' && logic.reward.awardAt === 'GOAL_MET' && logic.reward.onReversal === 'CLAWBACK') {
      for (let i = tiers.length; i > achieved; i--) clawed += this.clawback(c, w, life, `${slotPrefix}tier:${i}`, effects, trigger, 'a correction means the goal is no longer met');
    }
    if (logic.reward.mode === 'ON_GOAL' && logic.reward.awardAt === 'GOAL_MET') {
      for (let i = 0; i < achieved; i++) {
        const slot = `${slotPrefix}tier:${i + 1}`;
        if (w.awards[slot] !== undefined) continue;
        const g = this.grant(c, logic, w, life, slot, tiers[i].points, effects, `${c.rule.name}${tiers[i].label ? ` – ${tiers[i].label}` : tiers.length > 1 ? ` – tier ${i + 1}` : ''}`, trigger);
        if (g > 0) granted += g;
        else capped = true;
      }
    }
    const next = tiers[achieved];
    if (next && next.target > 0 && (op === 'gte' || op === 'gt')) {
      const pct = (w.value / next.target) * 100;
      const tag = `${slotPrefix}near:${achieved + 1}`;
      if (pct >= logic.nudges.nearGoalPct && !w.nudged.includes(tag)) {
        w.nudged.push(tag);
        effects.push({ ...base, type: 'NUDGE', kind: 'NEAR_GOAL', message: `${c.rule.name}: ${this.fmtV(logic, w.value)} of ${this.fmtV(logic, next.target)} — ${this.fmtV(logic, round2(next.target - w.value))} to go for ${num(next.points)} points.`, dedupeKey: `NEAR|${w.key}|${tag}` });
      }
    }
    save();
    const progress = `${this.fmtV(logic, w.value)} of ${this.fmtV(logic, next?.target ?? tiers[tiers.length - 1]?.target)}`;
    if (clawed < 0) return Object.assign(ev, { outcome: 'REVERSED' as Outcome, points: clawed, message: `Correction: now ${progress}; ${num(-clawed)} points clawed back.` });
    if (granted > 0) return Object.assign(ev, { outcome: 'AWARDED' as Outcome, points: granted, message: `Goal met (${progress}); awarded ${num(granted)} points.` });
    if (capped) return Object.assign(ev, { outcome: 'CAPPED' as Outcome, message: 'Goal met but a reward cap or award limit applies.' });
    if (achieved > 0) return Object.assign(ev, { outcome: 'GOAL_MET' as Outcome, message: logic.reward.awardAt === 'WINDOW_CLOSE' ? `On track (${progress}); paid when the window closes.` : `Goal already met (${progress}).` });
    return Object.assign(ev, { outcome: 'PROGRESS' as Outcome, message: `Progress ${progress}.` });
  }

  private applyReversal(c: Compiled, inst: Instance, logic: Logic, event: MxpEvent, tiers: { target: number; points: number }[], st: StateStore, effects: Effect[], ev: Evaluation): Evaluation {
    const idx = st.get<IndexEntry>(xKey(c.rule.code, inst.subjectKey, event.reversalOf!));
    if (!idx) return Object.assign(ev, { outcome: 'NOT_MATCHED' as Outcome, message: 'Nothing to reverse: the original event was not counted by this rule.' });
    const key = wKey(c.rule.code, inst.subjectKey, idx.windowKey);
    const w = st.get<WindowState>(key);
    if (!w) return Object.assign(ev, { outcome: 'NOT_MATCHED' as Outcome, message: 'Original window not found.' });
    const life = st.get<LifetimeState>(lKey(c.rule.code, inst.subjectKey)) ?? { key: lKey(c.rule.code, inst.subjectKey), points: 0, awards: 0 };
    const wt = String(logic.window.type);
    const rolling = wt === 'ROLLING_DAYS' ? st.get<RollingState>(rKey(c.rule.code, inst.subjectKey)) ?? null : null;
    const container = rolling ?? w;
    const contrib = container.contributions[idx.cKey];
    st.set(xKey(c.rule.code, inst.subjectKey, event.id), { key: xKey(c.rule.code, inst.subjectKey, event.id), windowKey: idx.windowKey, cKey: `rev:${event.reversalOf}` } satisfies IndexEntry);
    if (!contrib || contrib.eventId !== event.reversalOf) {
      st.set(key, w);
      return Object.assign(ev, { outcome: 'NOT_MATCHED' as Outcome, windowKey: idx.windowKey, message: 'Original event no longer counts (already reversed or replaced).' });
    }
    const winInfo = { start: w.windowStart, end: w.windowEnd, rollingDays: wt === 'ROLLING_DAYS' ? Number(logic.window.days) : undefined };
    const asOf = contrib.day;
    const before = this.computeValue(logic, Object.values(container.contributions), winInfo, asOf);
    const partial = typeof event.amount === 'number' && logic.measure.type === 'SUM' && event.amount > 0 && event.amount < contrib.amount;
    if (partial) contrib.amount = round2(contrib.amount - (event.amount as number));
    else delete container.contributions[idx.cKey];
    if (rolling) st.set(rolling.key, rolling);
    const after = this.computeValue(logic, Object.values(container.contributions), winInfo, asOf);
    w.value = after;
    w.updatedAt = event.timestamp;
    let points = 0;
    if (c.family === 'MISSION' && logic.reward.onReversal === 'CLAWBACK') {
      if (logic.reward.mode === 'PER_EVENT' && !partial) points += this.clawback(c, w, life, `event:${idx.cKey}`, effects, event.id, 'the qualifying event was reversed');
      if (logic.reward.mode === 'ON_GOAL') {
        const op = logic.goal!.op;
        let achieved = 0;
        while (achieved < tiers.length && goalMet(after, op, tiers[achieved].target)) achieved++;
        for (let i = tiers.length; i > achieved; i--) points += this.clawback(c, w, life, `tier:${i}`, effects, event.id, 'a qualifying event was reversed and the goal is no longer met');
        w.achievedTier = achieved;
        if (w.status === 'OPEN') w.outcome = achieved > 0 ? 'GOAL_MET' : 'IN_PROGRESS';
      }
    }
    st.set(key, w);
    st.set(life.key, life);
    return Object.assign(ev, { outcome: 'REVERSED' as Outcome, windowKey: idx.windowKey, before, after, points, decision: c.family === 'SPEND_CONTROL' ? ('ALLOW' as Decision) : undefined,
      message: `${partial ? 'Partial reversal' : 'Reversal'}: ${this.fmtV(logic, before)} → ${this.fmtV(logic, after)}${points ? `; ${num(points)} points clawed back` : ''}${c.family === 'SPEND_CONTROL' && w.breaches ? '. Breaches already recorded in this window still stand' : ''}.` });
  }

  private applyStreak(c: Compiled, inst: Instance, logic: Logic, event: MxpEvent, frame: FactFrame, date: string, win: WindowInfo, tiers: { target: number; points: number; label?: string }[], st: StateStore, effects: Effect[], ev: Evaluation): Evaluation {
    const key = wKey(c.rule.code, inst.subjectKey, win.key);
    const w = st.get<WindowState>(key) ?? this.newWindow(c, inst, event.customerId, win, tiers[0]?.target ?? null, event.timestamp);
    const life = st.get<LifetimeState>(lKey(c.rule.code, inst.subjectKey)) ?? { key: lKey(c.rule.code, inst.subjectKey), points: 0, awards: 0 };
    if (st.get<IndexEntry>(xKey(c.rule.code, inst.subjectKey, event.id))) return Object.assign(ev, { outcome: 'DUPLICATE' as Outcome, message: 'Event already processed for this rule.' });
    st.set(xKey(c.rule.code, inst.subjectKey, event.id), { key: xKey(c.rule.code, inst.subjectKey, event.id), windowKey: win.key, cKey: event.id } satisfies IndexEntry);
    const sp = logic.measure.streakPeriod!;
    const period = periodOf(date, sp);
    const s = life.streak ?? { current: 0, best: 0, last: null, run: 1 };
    const before = s.current;
    w.activity += 1;
    const base = { customerId: event.customerId, ruleCode: c.rule.code, ruleVersion: c.rule.version, family: c.family, subjectKey: inst.subjectKey, windowKey: win.key, eventId: event.id };
    const save = () => {
      life.streak = s;
      w.value = s.current;
      w.updatedAt = event.timestamp;
      st.set(key, w);
      st.set(life.key, life);
    };
    if (s.last && period.key < s.last) {
      save();
      return Object.assign(ev, { outcome: 'NOT_MATCHED' as Outcome, before, after: s.current, message: `Event for ${period.key} is older than the streak head ${s.last}.` });
    }
    const brk = logic.measure.breakWhen ? evalCondition(logic.measure.breakWhen, frame) : null;
    const filter = evalCondition(logic.filter, frame);
    ev.trace!.filter = filter;
    if (brk?.pass) {
      if (s.current > 0) s.run += 1;
      s.current = 0;
      s.last = period.key;
      effects.push({ ...base, type: 'NUDGE', kind: 'STREAK_BROKEN', message: `${c.rule.name}: your streak of ${before} reset. Start again next ${humanWindow(period.key)}.`, dedupeKey: `STREAK_BROKEN|${key}|${period.key}` });
      save();
      return Object.assign(ev, { outcome: 'STREAK_BROKEN' as Outcome, before, after: 0, message: `Streak broken at ${before}.` });
    }
    if (!filter.pass) {
      save();
      return Object.assign(ev, { outcome: 'NOT_MATCHED' as Outcome, before, after: s.current, message: 'Event does not extend the streak.' });
    }
    if (s.last === period.key) {
      save();
      return Object.assign(ev, { outcome: 'PROGRESS' as Outcome, before, after: s.current, message: `Already counted for ${period.key}; streak ${s.current}.` });
    }
    if (s.last && s.current > 0 && previousPeriod(period, sp).key === s.last) s.current += 1;
    else {
      if (s.current > 0) s.run += 1;
      s.current = 1;
    }
    s.last = period.key;
    s.best = Math.max(s.best, s.current);
    w.matched += 1;
    w.value = s.current;
    Object.assign(ev, { before, after: s.current });
    return this.goalProgress(c, logic, w, life, tiers, effects, event.id, ev, save, base, `run${s.run}:`);
  }

  private closeWindow(w: WindowState, st: StateStore, effects: Effect[], contextFor?: (customerId: string) => EvalContext | undefined): Evaluation {
    const c = this.compiled.get(w.ruleCode);
    const ev: Evaluation = {
      trigger: 'CLOSE', ruleCode: w.ruleCode, ruleVersion: w.ruleVersion, ruleName: c?.rule.name ?? w.ruleCode, templateCode: c?.template.code ?? '', family: w.family,
      customerId: w.customerId, subjectKey: w.subjectKey, settingId: w.settingId, windowKey: w.windowKey, outcome: 'CLOSED', points: 0, message: '', before: w.value, after: w.value, target: w.target,
    };
    const finish = (outcome: Exclude<Outcome, never>, wo: WindowState['outcome'], message: string, points = 0) => {
      w.status = 'CLOSED';
      w.outcome = wo;
      st.set(w.key, w);
      return Object.assign(ev, { outcome, message, points });
    };
    if (!c) return finish('CLOSED', 'CLOSED', 'Rule is no longer in the pack; window closed without reward.');
    const life = st.get<LifetimeState>(lKey(w.ruleCode, w.subjectKey)) ?? { key: lKey(w.ruleCode, w.subjectKey), points: 0, awards: 0 };
    const logic = substitute(c.template.logic, w.params) as Logic;
    const saveLife = () => st.set(life.key, life);
    const base = { customerId: w.customerId, ruleCode: c.rule.code, ruleVersion: c.rule.version, family: c.family, subjectKey: w.subjectKey, windowKey: w.windowKey };

    if (c.family === 'SPEND_CONTROL') {
      if (contextFor && w.settingId) {
        const ctx = contextFor(w.customerId);
        const ok = ctx?.settings?.some((s) => s.settingId === w.settingId && (s.status ?? 'ACTIVE') === 'ACTIVE' && (!s.effectiveTo || s.effectiveTo >= w.windowEnd));
        if (!ok) return finish('CANCELLED', 'CLOSED', 'Setting was cancelled before the window ended; no reward.');
      }
      if (w.breaches > 0) return finish('BREACHED', 'BREACHED', `Limit breached ${w.breaches} time(s) in ${w.windowKey}; no reward.`);
      if (logic.reward.mode !== 'WINDOW_COMPLIANCE') return finish('COMPLIANT', 'COMPLIANT', `Stayed within the limit in ${w.windowKey}.`);
      const minAct = Number(logic.reward.minActivity ?? 1);
      if (w.activity < minAct) return finish('NO_ACTIVITY', 'NO_ACTIVITY', `Only ${w.activity} qualifying transaction(s); at least ${minAct} needed to earn the compliance reward.`);
      const g = this.grant(c, logic, w, life, 'compliance', Number(logic.reward.points ?? 0), effects, `${c.rule.name} – stayed within limit (${w.windowKey})`, 'close');
      saveLife();
      if (g > 0) effects.push({ ...base, type: 'NUDGE', kind: 'COMPLIANT', message: `You stayed within your ${c.rule.name.toLowerCase()} for ${w.windowKey}. +${num(g)} points.`, dedupeKey: `COMPLIANT|${w.key}` });
      return g > 0 ? finish('COMPLIANT', 'COMPLIANT', `Within limit for ${w.windowKey}; awarded ${num(g)} points.`, g) : finish('CAPPED', 'COMPLIANT', 'Within limit but a reward cap applies.');
    }

    const tiers = this.tiersOf(logic);
    if (logic.reward.mode === 'ON_GOAL') {
      const op = logic.goal!.op;
      let achieved = 0;
      while (achieved < tiers.length && goalMet(w.value, op, tiers[achieved].target)) achieved++;
      w.achievedTier = achieved;
      let granted = 0;
      if (logic.reward.awardAt === 'WINDOW_CLOSE') {
        for (let i = 0; i < achieved; i++) granted += this.grant(c, logic, w, life, `tier:${i + 1}`, tiers[i].points, effects, `${c.rule.name} (${w.windowKey})`, 'close');
        saveLife();
      }
      if (achieved > 0) return finish('GOAL_MET', 'GOAL_MET', `Final ${this.fmtV(logic, w.value)} meets ${opText(op)} ${this.fmtV(logic, tiers[0].target)}${granted ? `; awarded ${num(granted)} points` : ''}.`, granted);
      return finish('MISSED', 'MISSED', `Final ${this.fmtV(logic, w.value)} did not reach ${this.fmtV(logic, tiers[0]?.target)}.`);
    }
    return finish(w.points > 0 ? 'GOAL_MET' : 'CLOSED', w.points > 0 ? 'GOAL_MET' : 'CLOSED', `Window closed with ${num(w.points)} points earned.`);
  }
}

function summarize(evaluations: Evaluation[], effects: Effect[]): ProcessResult {
  let decision: Decision = 'ALLOW';
  for (const e of evaluations) if (e.decision && DECISION_RANK[e.decision] > DECISION_RANK[decision]) decision = e.decision;
  const points = effects.reduce((s, e) => s + (e.type === 'AWARD' || e.type === 'CLAWBACK' ? e.points : 0), 0);
  return { decision, evaluations, effects, points };
}

const opText = (op: GoalOp) => ({ gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=' })[op];

function humanWindow(key: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return 'day';
  if (/W\d+$/.test(key)) return 'week';
  if (/^\d{4}-\d{2}$/.test(key)) return 'month';
  if (/Q\d$/.test(key)) return 'quarter';
  if (/^\d{4}$/.test(key)) return 'year';
  return 'window';
}

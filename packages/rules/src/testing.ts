/**
 * Test harness shared by the testing app, the API and the unit tests.
 *
 *   runScenario(engine, scenario)          replays a scripted customer journey and checks expectations
 *   generateBoundaryCases(engine, code)    derives below / at / above-target cases from a rule's own definition
 */
import type { Decision, Effect, Evaluation, Outcome, ProcessResult, RulesEngine } from './engine';
import { resolveValues, substitute } from './params';
import type { Condition, CustomerSettingInput, EvalContext, Logic, MxpEvent } from './schema';
import { MemoryStateStore } from './store';
import { addDays, periodOf, zonedToIso, type CalendarWindow } from './time';

export interface StepExpect {
  /** Outcome per rule code. */
  outcomes?: Record<string, Outcome>;
  decision?: Decision;
  /** Points posted in this step (focus rule only when the scenario has one). */
  points?: number;
}

export type ScenarioStep =
  | { kind: 'event'; label?: string; event: Partial<MxpEvent> & { type: string; timestamp: string }; expect?: StepExpect }
  | { kind: 'check'; label?: string; event: Partial<MxpEvent> & { type: string; timestamp: string }; expect?: StepExpect }
  | { kind: 'close'; label?: string; asOf: string; expect?: StepExpect }
  | { kind: 'setting'; label?: string; setting: CustomerSettingInput }
  | { kind: 'enroll'; label?: string; ruleCode: string };

export interface Scenario {
  id?: string;
  name: string;
  description?: string;
  /** Restrict expectations and point totals to one rule. */
  focusRule?: string;
  customer: EvalContext['customer'];
  account?: EvalContext['account'];
  settings?: CustomerSettingInput[];
  enrollments?: string[];
  steps: ScenarioStep[];
  expect?: { totalPoints?: number };
  tags?: string[];
}

export interface StepResult {
  index: number;
  kind: ScenarioStep['kind'];
  label?: string;
  result?: ProcessResult;
  points: number;
  failures: string[];
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  steps: StepResult[];
  totalPoints: number;
  ledger: Extract<Effect, { type: 'AWARD' | 'CLAWBACK' }>[];
  failures: string[];
  store: MemoryStateStore;
  durationMs: number;
}

export function runScenario(engine: RulesEngine, sc: Scenario, store = new MemoryStateStore()): ScenarioResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const settings = [...(sc.settings ?? [])].map((s) => ({ ...s, customerId: s.customerId ?? sc.customer.id }));
  const enrollments = [...(sc.enrollments ?? [])];
  const ctx = (): EvalContext => ({ customer: sc.customer, account: sc.account ?? null, settings, enrollments });
  const steps: StepResult[] = [];
  const ledger: ScenarioResult['ledger'] = [];
  const failures: string[] = [];
  const focus = (e: { ruleCode: string }) => !sc.focusRule || e.ruleCode === sc.focusRule;
  let n = 0;
  sc.steps.forEach((step, index) => {
    const sr: StepResult = { index, kind: step.kind, label: step.label, points: 0, failures: [] };
    try {
      if (step.kind === 'setting') {
        settings.push({ ...step.setting, customerId: step.setting.customerId ?? sc.customer.id });
      } else if (step.kind === 'enroll') {
        if (!enrollments.includes(step.ruleCode)) enrollments.push(step.ruleCode);
      } else {
        let res: ProcessResult;
        if (step.kind === 'close') res = engine.close(step.asOf, store, () => ctx());
        else {
          const ev = { customerId: sc.customer.id, ...step.event, id: step.event.id ?? `${sc.id ?? 'sc'}-e${++n}` } as MxpEvent;
          res = step.kind === 'check' ? engine.check(ev, ctx(), store) : engine.process(ev, ctx(), store);
        }
        sr.result = res;
        const pts = res.effects.filter((e): e is ScenarioResult['ledger'][number] => (e.type === 'AWARD' || e.type === 'CLAWBACK') && focus(e));
        if (step.kind !== 'check') ledger.push(...pts);
        sr.points = pts.reduce((s, e) => s + e.points, 0);
        const ex = step.expect;
        if (ex) {
          if (ex.decision && res.decision !== ex.decision) sr.failures.push(`decision: expected ${ex.decision}, got ${res.decision}`);
          if (ex.points !== undefined && sr.points !== ex.points) sr.failures.push(`points: expected ${ex.points}, got ${sr.points}`);
          for (const [code, outcome] of Object.entries(ex.outcomes ?? {})) {
            const got = res.evaluations.filter((e) => e.ruleCode === code).map((e) => e.outcome);
            if (!got.includes(outcome)) sr.failures.push(`${code}: expected ${outcome}, got ${got.length ? got.join(', ') : 'no evaluation'}`);
          }
        }
      }
    } catch (e) {
      sr.failures.push(`error: ${(e as Error).message}`);
    }
    failures.push(...sr.failures.map((f) => `step ${index + 1}${step.label ? ` (${step.label})` : ''}: ${f}`));
    steps.push(sr);
  });
  const totalPoints = ledger.reduce((s, e) => s + e.points, 0);
  if (sc.expect?.totalPoints !== undefined && totalPoints !== sc.expect.totalPoints) failures.push(`total points: expected ${sc.expect.totalPoints}, got ${totalPoints}`);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { name: sc.name, passed: failures.length === 0, steps, totalPoints, ledger, failures, store, durationMs: Math.round((t1 - t0) * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Event synthesis: build an event / customer that satisfies a condition tree.
// ---------------------------------------------------------------------------
const BASE_EVENTS: Record<string, Record<string, unknown>> = {
  TRANSACTION: { dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', amount: 100, category: 'OTHER', merchant_id: 'M_TEST', merchant_name: 'Test merchant', product_family: 'DEBIT_CARD', payee_id: 'P_TEST', international: false, status: 'POSTED' },
  BALANCE_SNAPSHOT: { account_type: 'SAVINGS', balance: 1000 },
  REFERRAL: { referral_id: 'REF1', status: 'APPROVED' },
  PRODUCT_APPLICATION: { application_id: 'APP1', product_family: 'CREDIT_CARD', status: 'APPROVED' },
  RD_INSTALLMENT: { account_type: 'RECURRING_DEPOSIT', installment_no: 1, on_time: true, amount: 2000 },
  RD_MATURITY: { account_type: 'RECURRING_DEPOSIT', status: 'COMPLETED', installments_missed: 0, tenure_months: 12 },
  FD_MATURITY: { account_type: 'FIXED_DEPOSIT', action: 'RENEW', amount: 100000, maturity_id: 'MAT1', tenure_months: 12 },
};

interface Draft {
  event: Record<string, unknown>;
  customer: Record<string, unknown>;
  account: Record<string, unknown>;
  time?: string;
}

function alternative(v: unknown, refs: string[] | undefined): unknown {
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return v + 1;
  const pool = refs?.filter((x) => x !== v);
  return pool?.length ? pool[0] : `NOT_${String(v)}`;
}

function setPath(d: Draft, path: string, value: unknown) {
  const [root, ...rest] = path.split('.');
  if (root === 'event' && rest[0] === 'local') {
    if (rest[1] === 'time') d.time = String(value);
    if (rest[1] === 'hour') d.time = `${String(value).padStart(2, '0')}:30`;
    return;
  }
  const obj = (d as unknown as Record<string, Record<string, unknown>>)[root];
  if (!obj) return;
  if (value === undefined) delete obj[rest.join('.')];
  else obj[rest.join('.')] = value;
}

function satisfy(c: Condition | undefined, d: Draft, engine: RulesEngine, negate = false): void {
  if (!c) return;
  if ('all' in c) {
    if (negate) satisfy(c.all[0], d, engine, true);
    else c.all.forEach((x) => satisfy(x, d, engine));
    return;
  }
  if ('any' in c) {
    if (negate) c.any.forEach((x) => satisfy(x, d, engine, true));
    else satisfy(c.any[0], d, engine);
    return;
  }
  if ('not' in c) return satisfy(c.not, d, engine, !negate);
  const fact = engine.facts.find((f) => f.path === c.field);
  const refs = fact?.valuesFrom ? engine.references[fact.valuesFrom] : fact?.values;
  const v = c.value;
  const list = Array.isArray(v) ? v : [v];
  const op = c.op;
  const pos: Record<string, () => unknown> = {
    eq: () => v, ne: () => alternative(v, refs), in: () => list[0], not_in: () => refs?.find((x) => !list.includes(x)) ?? 'OTHER',
    gt: () => (v as number) + 1, gte: () => v, lt: () => (v as number) - 1, lte: () => v, between: () => list[0],
    contains: () => [v], starts_with: () => `${v}X`, exists: () => 'X', not_exists: () => undefined, time_between: () => list[0],
  };
  const neg: Record<string, () => unknown> = {
    eq: () => alternative(v, refs), ne: () => v, in: () => refs?.find((x) => !list.includes(x)) ?? 'OTHER', not_in: () => list[0],
    gt: () => v, gte: () => (v as number) - 1, lt: () => v, lte: () => (v as number) + 1, between: () => (list[1] as number) + 1,
    contains: () => [], starts_with: () => `X${v}`, exists: () => undefined, not_exists: () => 'X', time_between: () => list[1],
  };
  setPath(d, c.field, (negate ? neg : pos)[op]());
}

export interface CaseBuilder {
  /** A qualifying event (passes scope and filter) on a local date. */
  qualifying(date: string, over?: Record<string, unknown>): Partial<MxpEvent> & { type: string; timestamp: string };
  /** An event in scope that does not pass the filter (or null when the rule has no filter). */
  nonMatching(date: string): (Partial<MxpEvent> & { type: string; timestamp: string }) | null;
  /** An event outside the rule scope (or null when the rule has no scope). */
  outOfScope(date: string): (Partial<MxpEvent> & { type: string; timestamp: string }) | null;
  customer: EvalContext['customer'];
  values: Record<string, unknown>;
  logic: Logic;
  tz: string;
}

/** Builds events and a customer that satisfy a rule, given customer values for spend controls. */
export function caseBuilder(engine: RulesEngine, code: string, customerValues: Record<string, unknown> = {}, customerId = 'C_TEST'): CaseBuilder {
  const r = engine.getRule(code);
  if (!r) throw new Error(`Unknown rule ${code}`);
  const values = resolveValues(r.rule, r.template, customerValues);
  const logic = substitute(r.template.logic, values) as Logic;
  const tz = r.template.logic.window.timezone && r.template.logic.window.timezone !== 'CUSTOMER' ? r.template.logic.window.timezone : engine.pack.timezone;
  const type = logic.events[0];
  const cust: Draft = { event: {}, customer: { id: customerId, segment: r.rule.segments[0] ?? 'MASS', status: 'ACTIVE', timezone: tz }, account: {} };
  satisfy(r.rule.eligibility, cust, engine);
  let seq = 0;
  const mk = (date: string, d: Draft, over: Record<string, unknown> = {}) => {
    seq++;
    const time = d.time ?? '12:00';
    return { type, accountId: 'A_TEST', ...d.event, ...over, timestamp: zonedToIso(date, time, tz) } as Partial<MxpEvent> & { type: string; timestamp: string };
  };
  const base = (): Draft => ({ event: { ...(BASE_EVENTS[type] ?? {}) }, customer: cust.customer, account: {} });
  return {
    customer: cust.customer as EvalContext['customer'],
    values,
    logic,
    tz,
    qualifying(date, over) {
      const d = base();
      satisfy(logic.scope, d, engine);
      satisfy(logic.filter, d, engine);
      if (logic.measure.breakWhen) satisfy(logic.measure.breakWhen, d, engine, true);
      return mk(date, d, { referral_id: `REF${seq}`, application_id: `APP${seq}`, maturity_id: `MAT${seq}`, ...over });
    },
    nonMatching(date) {
      if (!logic.filter) return null;
      const d = base();
      satisfy(logic.scope, d, engine);
      satisfy(logic.filter, d, engine, true);
      return mk(date, d, { referral_id: `REF_X${seq}` });
    },
    outOfScope(date) {
      if (!logic.scope) return null;
      const d = base();
      satisfy(logic.filter, d, engine);
      satisfy(logic.scope, d, engine, true);
      return mk(date, d);
    },
  };
}

// ---------------------------------------------------------------------------
// Boundary-case generation
// ---------------------------------------------------------------------------
const mid = (lo?: number, hi?: number, dflt?: unknown) => (typeof dflt === 'number' ? dflt : lo !== undefined && hi !== undefined ? Math.round((lo + hi) / 2) : lo ?? hi ?? 1000);

/** Picks valid customer values for a spend control (bank defaults, else the middle of the bounds). */
export function defaultCustomerValues(engine: RulesEngine, code: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of engine.customerParams(code)) {
    if (p.default !== undefined) out[p.name] = p.default;
    else if (['money', 'number', 'integer', 'percent'].includes(p.type)) out[p.name] = mid(p.min, p.max);
    else if (p.type === 'enum[]') out[p.name] = (p.options ?? []).slice(0, 1);
    else if (p.type === 'string[]') out[p.name] = engine.references.merchants?.slice(0, 1) ?? ['X1'];
    else if (p.type === 'enum') out[p.name] = p.options?.[0];
    else if (p.type === 'time') out[p.name] = '23:00';
    else if (p.type === 'boolean') out[p.name] = true;
    else out[p.name] = 'X';
  }
  return out;
}

export function generateBoundaryCases(engine: RulesEngine, code: string, anchor = '2026-10-05'): Scenario[] {
  const r = engine.getRule(code)!;
  const values = r.family === 'SPEND_CONTROL' ? defaultCustomerValues(engine, code) : {};
  const b = caseBuilder(engine, code, values);
  const L = b.logic;
  const wt = String(L.window.type);
  const cal = (wt === 'ROLLING_DAYS' ? L.window.period ?? 'DAY' : (CAL.includes(wt) ? wt : 'MONTH')) as CalendarWindow;
  const start = r.rule.effective.from && r.rule.effective.from > anchor ? r.rule.effective.from : anchor;
  const win = periodOf(start, cal);
  const day0 = wt === 'LIFETIME' || wt === 'FIXED' ? start : win.start;
  const closeDate = addDays(win.end, (L.window.graceDays ?? 0) + 1);
  const setting: CustomerSettingInput[] = r.family === 'SPEND_CONTROL' ? [{ settingId: 'S1', customerId: b.customer.id, ruleCode: code, values }] : [];
  const enroll = r.family === 'MISSION' && r.rule.enrollment === 'OPT_IN' ? [code] : [];
  const sc = (name: string, steps: ScenarioStep[], total?: number, tags: string[] = []): Scenario => ({
    id: `${code}:${name}`.replace(/\W+/g, '_'), name, focusRule: code, customer: b.customer, settings: setting, enrollments: enroll, steps, expect: total === undefined ? undefined : { totalPoints: total }, tags: ['generated', ...tags],
  });
  const out: Scenario[] = [];
  const ev = (e: ScenarioStep & { kind: 'event' | 'check' }) => e;

  // eligibility
  if (r.rule.segments.length) {
    const other = (engine.references.segments ?? []).find((s) => !r.rule.segments.includes(s));
    if (other) {
      const s = sc(`not eligible (segment ${other})`, [ev({ kind: 'event', event: b.qualifying(day0), expect: { outcomes: { [code]: 'NOT_ELIGIBLE' }, points: 0 } })], 0, ['eligibility']);
      s.customer = { ...b.customer, segment: other };
      out.push(s);
    }
  }
  const oos = b.outOfScope(day0);
  if (oos) out.push(sc('out of scope', [ev({ kind: 'event', event: oos, expect: { outcomes: { [code]: 'OUT_OF_SCOPE' }, points: 0 } })], 0, ['scope']));

  if (r.family === 'SPEND_CONTROL') {
    const limit = Number(L.goal?.target);
    const action = String(L.control?.action ?? 'ALERT') as Decision;
    const pts = L.reward.mode === 'WINDOW_COMPLIANCE' ? Number(L.reward.points ?? 0) : 0;
    const minAct = Number(L.reward.minActivity ?? 1);
    const nm = b.nonMatching(day0);
    if (L.measure.type === 'SUM') {
      const filler = Math.max(0, minAct - 2);
      const fillSteps: ScenarioStep[] = Array.from({ length: filler }, (_, i) => ({ kind: 'event', label: 'activity', event: nm ?? b.qualifying(day0, { amount: 0.01 * (i + 1) }) }));
      const fillAmt = nm ? 0 : Math.round(filler * (filler + 1) / 2) / 100;
      const half = Math.round(((limit - fillAmt) / 2) * 100) / 100;
      out.push(sc('spend exactly at the limit → compliant', [
        ...fillSteps,
        ev({ kind: 'event', label: `spend ${half}`, event: b.qualifying(day0, { amount: half }) }),
        ev({ kind: 'check', label: 'pre-auth at 50%', event: b.qualifying(day0, { amount: 1 }), expect: { decision: 'ALLOW' } }),
        ev({ kind: 'event', label: `spend ${Math.round((limit - fillAmt - half) * 100) / 100}`, event: b.qualifying(day0, { amount: Math.round((limit - fillAmt - half) * 100) / 100 }), expect: { outcomes: { [code]: L.control?.warnAtPct ? 'WARNING' : 'WITHIN_LIMIT' } } }),
        ev({ kind: 'check', label: 'pre-auth 1 more at limit', event: b.qualifying(day0, { amount: 1 }), expect: { decision: action } }),
        { kind: 'close', asOf: closeDate, expect: { outcomes: pts ? { [code]: 'COMPLIANT' } : {}, points: pts } },
      ], pts, ['boundary']));
      out.push(sc('spend 1 over the limit → breach, no reward', [
        ...fillSteps,
        ev({ kind: 'event', event: b.qualifying(day0, { amount: Math.round((limit - fillAmt) * 100) / 100 }) }),
        ev({ kind: 'event', label: 'one rupee over', event: b.qualifying(day0, { amount: 1 }), expect: { outcomes: { [code]: 'BREACH' }, decision: action } }),
        { kind: 'close', asOf: closeDate, expect: { outcomes: { [code]: 'BREACHED' }, points: 0 } },
      ], 0, ['boundary']));
      const q = b.qualifying(day0, { amount: Math.max(1, Math.round(limit / 4)) });
      out.push(sc('refund after breach keeps the breach', [
        ev({ kind: 'event', event: b.qualifying(day0, { amount: limit, id: 'big' }) }),
        ev({ kind: 'event', event: q, expect: { outcomes: { [code]: 'BREACH' } } }),
        ev({ kind: 'event', label: 'refund', event: { ...b.qualifying(day0), dr_cr: 'C', txn_type: 'REFUND', reversalOf: 'big', amount: limit }, expect: { outcomes: { [code]: 'REVERSED' } } }),
        { kind: 'close', asOf: closeDate, expect: { outcomes: { [code]: 'BREACHED' }, points: 0 } },
      ], 0, ['reversal']));
    } else {
      out.push(sc('restricted transaction → breach', [
        ev({ kind: 'check', label: 'pre-auth', event: b.qualifying(day0), expect: { decision: action } }),
        ev({ kind: 'event', event: b.qualifying(day0), expect: { outcomes: { [code]: 'BREACH' }, decision: action } }),
        { kind: 'close', asOf: closeDate, expect: { outcomes: { [code]: 'BREACHED' }, points: 0 } },
      ], 0, ['boundary']));
      if (nm) {
        out.push(sc(`${minAct} clean transactions → compliant`, [
          ...Array.from({ length: minAct }, (): ScenarioStep => ({ kind: 'event', event: b.nonMatching(day0)!, expect: { outcomes: { [code]: 'NOT_MATCHED' }, decision: 'ALLOW' } })),
          { kind: 'close', asOf: closeDate, expect: { outcomes: pts ? { [code]: 'COMPLIANT' } : {}, points: pts } },
        ], pts, ['boundary']));
        if (minAct > 1)
          out.push(sc(`${minAct - 1} clean transactions → not enough activity`, [
            ...Array.from({ length: minAct - 1 }, (): ScenarioStep => ({ kind: 'event', event: b.nonMatching(day0)! })),
            { kind: 'close', asOf: closeDate, expect: { outcomes: { [code]: 'NO_ACTIVITY' }, points: 0 } },
          ], 0, ['anti-gaming']));
      }
    }
    out.push(sc('no setting → rule not applied', [ev({ kind: 'event', event: b.qualifying(day0), expect: { points: 0 } })], 0, ['opt-in']));
    out[out.length - 1].settings = [];
    return out;
  }

  // ----- missions -----
  const tiers = L.goal?.tiers?.length ? L.goal.tiers.map((t) => ({ target: Number(t.target), points: Number(t.points) })) : L.goal?.target !== undefined ? [{ target: Number(L.goal.target), points: Number(L.reward.points ?? 0) }] : [];
  const hiOnly = L.reward.tierMode === 'HIGHEST_ONLY';
  const m = L.measure.type;
  const cap = L.measure.perDayCap !== undefined ? Number(L.measure.perDayCap) : Infinity;

  if (L.reward.mode === 'PER_EVENT') {
    const p = L.reward.perAmount !== undefined ? Math.floor(Number(b.qualifying(day0).amount ?? 0) / Number(L.reward.perAmount)) * Number(L.reward.points) : Number(L.reward.points ?? 0);
    const capW = L.reward.capPointsPerWindow !== undefined ? Number(L.reward.capPointsPerWindow) : Infinity;
    const first = Math.min(p, capW);
    out.push(sc('qualifying event → reward', [ev({ kind: 'event', event: b.qualifying(day0, { referral_id: 'R1', maturity_id: 'M1' }), expect: { outcomes: { [code]: first > 0 ? 'AWARDED' : 'CAPPED' }, points: first } })], first, ['boundary']));
    if (L.measure.dedupeBy) {
      const k = L.measure.dedupeBy.replace(/^event\./, '');
      const same = keyValue(L, 0);
      const e1 = b.qualifying(day0, { [k]: same });
      out.push(sc('same item re-sent → rewarded once', [
        ev({ kind: 'event', event: e1, expect: { points: first } }),
        ev({ kind: 'event', event: { ...e1, id: undefined }, expect: { points: 0 } }),
      ], first, ['idempotency']));
      const nm = b.nonMatching(day0);
      if (nm && L.reward.onReversal === 'CLAWBACK')
        out.push(sc('item withdrawn later → clawback', [
          ev({ kind: 'event', event: e1, expect: { points: first } }),
          ev({ kind: 'event', event: { ...nm, [k]: same }, expect: { outcomes: { [code]: 'REVERSED' }, points: -first } }),
        ], 0, ['reversal']));
    }
    const nm = b.nonMatching(day0);
    if (nm) out.push(sc('not yet approved → no reward', [ev({ kind: 'event', event: nm, expect: { outcomes: { [code]: 'NOT_MATCHED' }, points: 0 } })], 0, ['boundary']));
    const maxW = L.reward.maxAwardsPerWindow !== undefined ? Number(L.reward.maxAwardsPerWindow) : L.reward.maxAwards !== undefined ? Number(L.reward.maxAwards) : null;
    if (maxW !== null && maxW <= 10) {
      const steps: ScenarioStep[] = Array.from({ length: maxW + 1 }, (_, i) => ({ kind: 'event', event: b.qualifying(addDays(day0, i), dedupeOver(L, i)), expect: { points: i < maxW ? first : 0 } }));
      out.push(sc(`${maxW + 1} items → only ${maxW} rewarded`, steps, first * maxW, ['caps']));
    }
    return out;
  }

  if (m === 'STREAK') {
    const t1 = tiers[0];
    const months = (k: number) => Array.from({ length: k }, (_, i) => addDays(periodOf(addMonths(day0, i), 'MONTH').start, 4));
    out.push(sc(`${t1.target} on-time months → milestone 1`, months(t1.target).map((d, i) => ({ kind: 'event', event: b.qualifying(d), expect: { points: i === t1.target - 1 ? t1.points : 0 } })), t1.points, ['boundary']));
    if (t1.target > 1) {
      const ds = months(t1.target);
      const steps: ScenarioStep[] = ds.slice(0, t1.target - 1).map((d) => ({ kind: 'event', event: b.qualifying(d) }));
      const late = b.qualifying(ds[t1.target - 1]);
      if (L.measure.breakWhen) satisfy(L.measure.breakWhen, { event: late as Record<string, unknown>, customer: {}, account: {} }, engine);
      steps.push({ kind: 'event', label: 'late installment', event: late, expect: { outcomes: { [code]: 'STREAK_BROKEN' }, points: 0 } });
      out.push(sc('late installment resets the streak', steps, 0, ['boundary']));
      const gap = months(t1.target + 1);
      out.push(sc('skipped month restarts the streak', [...gap.slice(0, t1.target - 1), ...gap.slice(t1.target)].map((d) => ({ kind: 'event', event: b.qualifying(d) })), 0, ['boundary']));
    }
    return out;
  }

  if (!tiers.length) return out;
  const T = tiers[0].target;
  const atClose = L.reward.awardAt === 'WINDOW_CLOSE';
  const tierPts = (k: number) => (hiOnly ? tiers[k - 1].points : tiers.slice(0, k).reduce((s, t) => s + t.points, 0));

  if (m === 'AVG_DAILY') {
    const days = 3;
    const snaps = (bal: number) => Array.from({ length: days }, (_, i): ScenarioStep => ({ kind: 'event', event: b.qualifying(addDays(day0, i), { balance: bal, as_of_date: addDays(day0, i) }) }));
    out.push(sc('average exactly at tier 1 → paid at close', [...snaps(T), { kind: 'close', asOf: closeDate, expect: { outcomes: { [code]: 'GOAL_MET' }, points: tierPts(1) } }], tierPts(1), ['boundary']));
    out.push(sc('average just below tier 1 → missed', [...snaps(T - 1), { kind: 'close', asOf: closeDate, expect: { outcomes: { [code]: 'MISSED' }, points: 0 } }], 0, ['boundary']));
    if (tiers.length > 1) out.push(sc('average at top tier → top-tier points', [...snaps(tiers[tiers.length - 1].target), { kind: 'close', asOf: closeDate }], tierPts(tiers.length), ['tiers']));
    return out;
  }

  // COUNT / SUM / DISTINCT_DAYS / COUNT_DISTINCT goals
  const unitsFor = (target: number): ScenarioStep[] => {
    const steps: ScenarioStep[] = [];
    if (m === 'SUM') {
      steps.push({ kind: 'event', event: b.qualifying(day0, { amount: target }) });
      return steps;
    }
    const perDay = m === 'DISTINCT_DAYS' ? 1 : Math.min(cap, 50);
    let left = target;
    let i = 0;
    let dayIdx = 0;
    while (left > 0) {
      const d = addDays(day0, dayIdx);
      for (let k = 0; k < perDay && left > 0; k++, left--, i++) {
        const over: Record<string, unknown> = m === 'COUNT_DISTINCT' ? { [L.measure.field!.replace(/^event\./, '')]: distinctValue(engine, L, i) } : {};
        if (L.measure.dedupeBy) over[L.measure.dedupeBy.replace(/^event\./, '')] = d;
        steps.push({ kind: 'event', event: b.qualifying(d, over) });
      }
      dayIdx++;
    }
    return steps;
  };
  const exact = unitsFor(T);
  if (exact.length && !atClose) (exact[exact.length - 1] as { expect?: StepExpect }).expect = { outcomes: { [code]: 'AWARDED' }, points: tierPts(1) };
  if (atClose || ['MONTH', 'WEEK', 'DAY', 'QUARTER', 'YEAR'].includes(wt)) exact.push({ kind: 'close', asOf: closeDate, expect: { points: atClose ? tierPts(1) : 0 } });
  out.push(sc(`exactly ${T} → goal met`, exact, tierPts(1), ['boundary']));
  if (m !== 'SUM' ? T > 1 : T > 1) {
    const below = m === 'SUM' ? [{ kind: 'event', event: b.qualifying(day0, { amount: T - 1 }) } as ScenarioStep] : unitsFor(T - 1);
    if (['MONTH', 'WEEK', 'DAY', 'QUARTER', 'YEAR'].includes(wt)) below.push({ kind: 'close', asOf: closeDate, expect: { outcomes: { [code]: 'MISSED' }, points: 0 } });
    out.push(sc(`${m === 'SUM' ? 'one below' : T - 1} → not met`, below, 0, ['boundary']));
  }
  if (cap !== Infinity && m === 'COUNT') {
    const steps: ScenarioStep[] = Array.from({ length: cap + 2 }, () => ({ kind: 'event', event: b.qualifying(day0) }));
    out.push(sc(`${cap + 2} in one day → only ${cap} count`, steps, T <= cap ? tierPts(1) : 0, ['anti-gaming']));
  }
  const nm = b.nonMatching(day0);
  if (nm) out.push(sc('non-qualifying event → no progress', [ev({ kind: 'event', event: nm, expect: { outcomes: { [code]: 'NOT_MATCHED' }, points: 0 } })], 0, ['boundary']));
  if (L.reward.maxAwards !== undefined && Number(L.reward.maxAwards) === 1 && wt === 'LIFETIME') {
    out.push(sc('second completion → not paid again', [...unitsFor(T), ...unitsFor(T).map((s) => ({ ...s, expect: { points: 0 } }))], tierPts(1), ['caps']));
  }
  if (r.rule.enrollment === 'OPT_IN') {
    const s = sc('not enrolled → not applied', [ev({ kind: 'event', event: b.qualifying(day0), expect: { outcomes: { [code]: 'NOT_ENROLLED' }, points: 0 } })], 0, ['opt-in']);
    s.enrollments = [];
    out.push(s);
  }
  return out;
}

const CAL = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'];

function addMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
}

function distinctValue(engine: RulesEngine, L: Logic, i: number): string {
  const f = engine.facts.find((x) => x.path === L.measure.field);
  const refs = f?.valuesFrom ? engine.references[f.valuesFrom] : f?.values;
  return refs?.[i] ?? `V${i + 1}`;
}

/** A value for the dedupe key; if scope/filter restrict that field to a list, pick from the list. */
function keyValue(L: Logic, i: number): string {
  const field = L.measure.dedupeBy!;
  let list: unknown[] | undefined;
  const scan = (c: Condition | undefined) => {
    if (!c) return;
    if ('all' in c) c.all.forEach(scan);
    else if ('any' in c) c.any.forEach(scan);
    else if ('field' in c && c.field === field && c.op === 'in' && Array.isArray(c.value)) list = c.value;
  };
  scan(L.scope);
  scan(L.filter);
  return list ? String(list[i % list.length]) : `K${i + 1}`;
}

function dedupeOver(L: Logic, i: number): Record<string, unknown> {
  if (!L.measure.dedupeBy) return {};
  return { [L.measure.dedupeBy.replace(/^event\./, '')]: keyValue(L, i) };
}

export function evaluationFor(res: ProcessResult, code: string): Evaluation | undefined {
  return res.evaluations.find((e) => e.ruleCode === code);
}

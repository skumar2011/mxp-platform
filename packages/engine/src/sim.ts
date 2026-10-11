import type { Db } from './db';
import { openDb } from './db';
import { Engine } from './engine';
import { validateDefinition } from './validation';
import { installSandboxRule, normalizeDefinition } from './ruleRepo';
import type { RuleDefinition } from './ruleDef';
import { addDays, localDate, zonedToIso } from './time';
import { FixedClock, MxpError, fmtInr, uid } from './util';
import { isBalanceMetric } from './ruleDef';
import type {
  RuleSource, SimCheck, SimEval, SimExpected, SimInput, SimLedger, SimNudge, SimProgress, SimResult, SimRuleRef, SimScenario, SimStep, SimStepResult, SimTxnStep,
} from './simtypes';
import { REFERENCE_TABLES } from './simtypes';

const DEFAULT_TZ = 'Asia/Kolkata';
const ACCOUNT_TYPE_BY_FAMILY: Record<string, string> = {
  SAVINGS: 'SAVINGS', CURRENT: 'CURRENT', CREDIT_CARD: 'CREDIT_CARD', DEBIT_CARD: 'DEBIT_CARD', UPI: 'UPI', LOAN: 'LOAN', DEPOSIT: 'DEPOSIT', WALLET: 'WALLET', OTHER: 'OTHER',
};
const INSTRUMENT_BY_FAMILY: Record<string, string> = { CREDIT_CARD: 'CREDIT_CARD', DEBIT_CARD: 'DEBIT_CARD', UPI: 'UPI_VPA', WALLET: 'WALLET' };
const MAX_STEPS = 2000;

export interface SandboxRule {
  ruleCode: string;
  versionNo: number;
  def: RuleDefinition;
  draft: boolean;
}

export interface Sandbox {
  db: Db;
  clock: FixedClock;
  engine: Engine;
  rules: SandboxRule[];
  problems: { ruleCode: string; code: string; message: string; path: string }[];
}

/** Resolves the rules under test (plus components and optionally every live rule) into definitions. */
function resolveRules(source: RuleSource, refs: SimRuleRef[], includeActive: boolean): SandboxRule[] {
  const map = new Map<string, SandboxRule>();
  for (const ref of refs) {
    if (ref.definition !== undefined) {
      const def = normalizeDefinition(ref.definition);
      const stored = source.rule(ref.ruleCode);
      map.set(ref.ruleCode, { ruleCode: ref.ruleCode, versionNo: (stored?.versionNo ?? 0) + 1, def, draft: true });
    } else {
      const s = source.rule(ref.ruleCode, ref.versionNo);
      if (!s) throw new MxpError('RULE_NOT_FOUND', `Rule ${ref.ruleCode}${ref.versionNo ? ` v${ref.versionNo}` : ''} was not found.`, 404);
      map.set(ref.ruleCode, { ruleCode: s.ruleCode, versionNo: s.versionNo, def: s.def, draft: false });
    }
  }
  if (includeActive) {
    for (const a of source.activeRules()) if (!map.has(a.ruleCode)) map.set(a.ruleCode, { ruleCode: a.ruleCode, versionNo: a.versionNo, def: a.def, draft: false });
  }
  // Components of combined rules must exist too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of [...map.values()]) {
      for (const c of r.def.combined?.components ?? []) {
        if (map.has(c.ruleCode)) continue;
        const s = source.rule(c.ruleCode);
        if (!s) throw new MxpError('COMPONENT_NOT_FOUND', `Combined rule ${r.ruleCode} needs component ${c.ruleCode}, which does not exist.`, 422);
        map.set(c.ruleCode, { ruleCode: s.ruleCode, versionNo: s.versionNo, def: s.def, draft: false });
        grew = true;
      }
    }
  }
  return [...map.values()].sort((a, b) => Number(a.def.kind === 'COMBINED') - Number(b.def.kind === 'COMBINED') || a.ruleCode.localeCompare(b.ruleCode));
}

/** Builds an isolated in-memory MXP instance holding only reference data and the rules under test. */
export function createSandbox(source: RuleSource, refs: SimRuleRef[], opts: { includeActive?: boolean; start?: Date } = {}): Sandbox {
  const rules = resolveRules(source, refs, !!opts.includeActive);
  const db = openDb(':memory:');
  const clock = new FixedClock(opts.start ?? new Date('2020-01-01T00:00:00Z'));
  const ref = source.referenceData();
  for (const t of REFERENCE_TABLES) {
    for (const row of ref[t] ?? []) {
      const cols = Object.keys(row);
      db.run(`INSERT OR IGNORE INTO ${t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c]));
    }
  }
  const now = clock.now().toISOString();
  const seenCampaigns = new Set<string>();
  for (const r of rules) {
    const code = r.def.campaignCode;
    if (!code || seenCampaigns.has(code)) continue;
    seenCampaigns.add(code);
    const c = source.campaign(code);
    if (!c) continue; // validation reports the missing campaign
    db.run(
      `INSERT INTO campaign(campaign_id, campaign_code, name, description, objective, start_date, end_date, timezone, points_budget, enrollment_mode, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid(), c.campaign_code, c.name, c.description, c.objective, c.start_date, c.end_date, c.timezone, c.points_budget, 'AUTO', 'ACTIVE', 'sandbox', now, now,
    );
  }
  const problems: Sandbox['problems'] = [];
  const engine = new Engine(db, clock, { storeTrace: true });
  for (const r of rules) {
    if (r.draft) {
      const rep = validateDefinition(db, r.def, { ruleCode: r.ruleCode });
      for (const e of rep.errors) problems.push({ ruleCode: r.ruleCode, code: e.code, message: e.message, path: e.path });
    }
    installSandboxRule(db, clock, r.ruleCode, r.def, r.versionNo);
  }
  return { db, clock, engine, rules, problems };
}

// ---------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------
export function instantOf(at: string, tz: string, defaultTime = '12:00'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return zonedToIso(at, defaultTime, tz);
  const m = at.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (m) return zonedToIso(m[1], m[2], tz);
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw new MxpError('BAD_TIME', `Cannot read time "${at}". Use YYYY-MM-DD, YYYY-MM-DDTHH:mm or an ISO timestamp.`, 422);
  return d.toISOString();
}

function setupCustomer(sb: Sandbox, sc: SimScenario) {
  const { db, clock } = sb;
  const now = clock.now().toISOString();
  const c = sc.customer ?? {};
  const cid = uid();
  const ref = c.ref ?? 'SIM-CUST-001';
  db.run(
    'INSERT INTO customer(customer_id, customer_ref, masked_name, status, customer_type, kyc_status, nudge_consent, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    cid, ref, 'Sim Customer', c.status ?? 'ACTIVE', c.type ?? 'RETAIL', c.kycStatus ?? 'FULL', c.nudgeConsent === false ? 0 : 1, now, now,
  );
  for (const s of c.segments ?? []) {
    db.run('INSERT OR IGNORE INTO segment(segment_code, name) VALUES (?,?)', s, s);
    db.run('INSERT INTO customer_segment(customer_id, segment_code, valid_from) VALUES (?,?,?)', cid, s, '2000-01-01');
  }
  for (const a of sc.accounts) {
    const p = db.get<{ product_family: string }>('SELECT product_family FROM product_ref WHERE product_code = ?', a.productCode);
    if (!p) throw new MxpError('UNKNOWN_PRODUCT', `Account ${a.ref}: unknown product "${a.productCode}".`, 422);
    const aid = uid();
    db.run(
      'INSERT INTO account(account_id, customer_id, account_ref, product_code, account_type, status, opened_on, created_at) VALUES (?,?,?,?,?,?,?,?)',
      aid, cid, a.ref, a.productCode, ACCOUNT_TYPE_BY_FAMILY[p.product_family] ?? 'OTHER', a.status ?? 'ACTIVE', a.openedOn ?? '2000-01-01', now,
    );
    const instType = a.instrumentType === 'NONE' ? undefined : a.instrumentType ?? INSTRUMENT_BY_FAMILY[p.product_family];
    if (instType) {
      db.run('INSERT INTO instrument(instrument_id, customer_id, account_id, instrument_ref, instrument_type, product_code) VALUES (?,?,?,?,?,?)', uid(), cid, aid, a.instrumentRef ?? `${a.ref}-INS`, instType, a.productCode);
    }
  }
  return { customerId: cid, customerRef: ref };
}

const money = (n: number) => fmtInr(Math.round(n * 100));

function describeStep(s: SimStep): string {
  switch (s.kind) {
    case 'TXN': return `${s.type} ${money(s.amount)} on ${s.channel} (${s.status ?? 'POSTED'}) [${s.id}]`;
    case 'STATUS': return `Status of ${s.id} becomes ${s.status}`;
    case 'REVERSAL': return `Reversal ${s.id} of ${s.original}`;
    case 'REFUND': return `Refund ${s.id} of ${s.original}${s.amount !== undefined ? ` (${money(s.amount)})` : ''}`;
    case 'BALANCE': return `Closing balance ${money(s.balance)} on ${s.account}, ${s.date}${s.toDate ? ` to ${s.toDate}` : ''}`;
    case 'CLOSE': return `Advance to ${s.at} and close periods`;
  }
}

interface Runner {
  sb: Sandbox;
  customerId: string;
  customerRef: string;
  tz: string;
  txns: Map<string, SimTxnStep>;
  defsByCode: Map<string, SandboxRule>;
  cursors: { eval: number; ledger: number; nudge: number };
}

function stepInstant(step: SimStep, tz: string): string {
  switch (step.kind) {
    case 'TXN': return instantOf(step.receivedAt ?? step.at, tz);
    case 'STATUS': case 'REVERSAL': case 'REFUND': case 'CLOSE': return instantOf(step.at, tz);
    case 'BALANCE': return zonedToIso(step.toDate ?? step.date, '23:59', tz);
  }
}

function txnEvent(r: Runner, s: SimTxnStep, status = s.status ?? 'POSTED', suffix = ''): any {
  const acct = s.accountRef ?? r.sb.db.get<{ account_ref: string }>('SELECT account_ref FROM account LIMIT 1')?.account_ref;
  // A card purchase on a card account is made with that account's card unless the step says otherwise.
  const instrumentRef =
    s.instrumentRef ??
    r.sb.db.get<{ instrument_ref: string }>('SELECT i.instrument_ref FROM instrument i JOIN account a USING(account_id) WHERE a.account_ref = ? LIMIT 1', acct ?? '')?.instrument_ref;
  return {
    eventType: 'TRANSACTION',
    sourceSystem: 'SIM',
    sourceEventId: `${s.id}:${status}${suffix}`,
    transaction: {
      sourceTxnId: s.id,
      customerRef: r.customerRef,
      accountRef: acct,
      instrumentRef,
      productCode: s.productCode,
      txnType: s.type,
      categoryCode: s.category,
      channel: s.channel,
      amount: s.amount,
      currency: 'INR',
      drCr: s.drCr ?? 'D',
      txnTimestamp: instantOf(s.at, r.tz),
      postingDate: s.postingDate,
      status,
      refundedAmount: s.refundedAmount,
      merchantId: s.merchantId,
      merchantName: s.merchantName,
      mcc: s.mcc,
      attributes: s.attributes,
    },
  };
}

function buildEvents(r: Runner, step: SimStep): any[] {
  switch (step.kind) {
    case 'TXN': {
      r.txns.set(step.id, step);
      const base = txnEvent(r, step);
      const out = [base];
      for (let i = 0; i < (step.repeat ?? 0); i++) out.push(structuredClone(base));
      for (let i = 1; i <= (step.resendAs ?? 0); i++) out.push(txnEvent(r, step, step.status ?? 'POSTED', `#r${i}`));
      return out;
    }
    case 'STATUS': {
      const orig = r.txns.get(step.id);
      if (!orig) throw new MxpError('UNKNOWN_STEP_REF', `Status step refers to unknown transaction "${step.id}". Add it as an earlier TXN step.`, 422);
      const ev = txnEvent(r, { ...orig, at: orig.at, refundedAmount: step.refundedAmount ?? orig.refundedAmount }, step.status);
      return [ev];
    }
    case 'REVERSAL':
    case 'REFUND': {
      const orig = r.txns.get(step.original);
      if (!orig) throw new MxpError('UNKNOWN_STEP_REF', `${step.kind} step refers to unknown transaction "${step.original}".`, 422);
      return [
        {
          eventType: 'TRANSACTION',
          sourceSystem: 'SIM',
          sourceEventId: `${step.id}:POSTED`,
          transaction: {
            sourceTxnId: step.id,
            originalSourceTxnId: step.original,
            customerRef: r.customerRef,
            accountRef: orig.accountRef ?? r.sb.db.get<{ account_ref: string }>('SELECT account_ref FROM account LIMIT 1')?.account_ref,
            txnType: step.kind,
            channel: orig.channel,
            amount: step.amount ?? orig.amount,
            currency: 'INR',
            drCr: (orig.drCr ?? 'D') === 'D' ? 'C' : 'D',
            status: 'POSTED',
            txnTimestamp: instantOf(step.at, r.tz),
          },
        },
      ];
    }
    case 'BALANCE': {
      const end = step.toDate ?? step.date;
      const out: any[] = [];
      for (let d = step.date; d <= end; d = addDays(d, 1)) {
        out.push({ eventType: 'BALANCE_SNAPSHOT', sourceSystem: 'SIM', sourceEventId: `BAL:${step.account}:${d}:${step.balance}`, snapshot: { accountRef: step.account, asOfDate: d, closingBalance: step.balance } });
        if (out.length > 800) throw new MxpError('RANGE_TOO_LONG', 'A balance range can cover at most 800 days.', 422);
      }
      return out;
    }
    case 'CLOSE':
      return [];
  }
}

function progressRows(r: Runner): SimProgress[] {
  return r.sb.db
    .all<any>(
      `SELECT r.rule_code, v.version_no, g.period_key, g.metric_value, g.txn_count, g.txn_sum_minor, g.achieved_tier, g.status, g.data_note
         FROM goal_progress g JOIN rule r ON r.rule_id = g.rule_id JOIN rule_version v ON v.rule_version_id = g.rule_version_id
        WHERE g.customer_id = ? ORDER BY r.rule_code, g.period_start`,
      r.customerId,
    )
    .map((x) => {
      const def = r.defsByCode.get(x.rule_code)?.def;
      const moneyMetric = def?.metric?.type === 'SUM' || isBalanceMetric(def?.metric?.type);
      return {
        ruleCode: x.rule_code, versionNo: x.version_no, periodKey: x.period_key,
        metric: moneyMetric ? x.metric_value / 100 : x.metric_value, count: x.txn_count, amount: x.txn_sum_minor / 100,
        achievedTier: x.achieved_tier, status: x.status, note: x.data_note,
      };
    });
}

function collectDelta(r: Runner): { evaluations: SimEval[]; ledger: SimLedger[]; nudges: SimNudge[] } {
  const { db } = r.sb;
  const evaluations = db
    .all<any>(
      `SELECT e.rowid AS rid, e.*, r.rule_code, v.version_no FROM rule_evaluation e JOIN rule r ON r.rule_id = e.rule_id JOIN rule_version v ON v.rule_version_id = e.rule_version_id
        WHERE e.rowid > ? AND e.customer_id = ? ORDER BY e.rowid`,
      r.cursors.eval, r.customerId,
    )
    .map((x): SimEval => {
      const def = r.defsByCode.get(x.rule_code)?.def;
      const moneyMetric = def?.metric?.type === 'SUM' || isBalanceMetric(def?.metric?.type);
      r.cursors.eval = Math.max(r.cursors.eval, x.rid);
      return {
        ruleCode: x.rule_code, versionNo: x.version_no, trigger: x.trigger_kind, period: x.period_key, outcome: x.outcome, eligible: !!x.eligible,
        reasonCode: x.reason_code, reasonText: x.reason_text, metric: x.metric_value === null ? null : moneyMetric ? x.metric_value / 100 : x.metric_value,
        pointsTarget: x.points_target, pointsDelta: x.points_delta, trace: x.trace_json ? JSON.parse(x.trace_json) : null,
      };
    });
  const ledger = db
    .all<any>(
      `SELECT l.*, r.rule_code FROM xp_ledger l LEFT JOIN rule r ON r.rule_id = l.rule_id WHERE l.ledger_id > ? AND l.customer_id = ? ORDER BY l.ledger_id`,
      r.cursors.ledger, r.customerId,
    )
    .map((x): SimLedger => {
      r.cursors.ledger = Math.max(r.cursors.ledger, x.ledger_id);
      return { ledgerId: x.ledger_id, ruleCode: x.rule_code, type: x.entry_type, points: x.points, period: x.period_key, slot: x.slot, reason: x.reason_code, text: x.reason_text };
    });
  const nudges = db
    .all<any>(
      `SELECT n.rowid AS rid, n.*, r.rule_code FROM nudge n LEFT JOIN rule r ON r.rule_id = n.rule_id WHERE n.rowid > ? AND n.customer_id = ? ORDER BY n.rowid`,
      r.cursors.nudge, r.customerId,
    )
    .map((x): SimNudge => {
      r.cursors.nudge = Math.max(r.cursors.nudge, x.rid);
      return { type: x.nudge_type, channel: x.channel, status: x.status, ruleCode: x.rule_code, message: x.message, suppressReason: x.suppress_reason };
    });
  return { evaluations, ledger, nudges };
}

// ---------------------------------------------------------------------
// Run a scenario
// ---------------------------------------------------------------------
export function runScenario(source: RuleSource, input: SimInput): SimResult {
  const started = performance.now();
  const log: string[] = [];
  const fail = (code: string, message: string, details?: unknown): SimResult => ({
    ok: false, error: { code, message, details }, name: input.name, rules: [], steps: [], final: null, checks: [], passed: null, durationMs: Math.round(performance.now() - started), log,
  });

  const sc = input.scenario;
  if (!sc || !Array.isArray(sc.steps)) return fail('BAD_SCENARIO', 'The scenario needs a list of steps.');
  if (sc.steps.length > MAX_STEPS) return fail('TOO_MANY_STEPS', `A scenario can have at most ${MAX_STEPS} steps.`);
  if (!input.rules?.length && !input.includeActive) return fail('NO_RULES', 'Select at least one rule to test.');
  const tz = sc.timezone ?? DEFAULT_TZ;

  let sb: Sandbox;
  try {
    sb = createSandbox(source, input.rules ?? [], { includeActive: input.includeActive });
  } catch (e: any) {
    return fail(e.code ?? 'SANDBOX_ERROR', e.message);
  }
  const rules = sb.rules.map((r) => ({ ruleCode: r.ruleCode, versionNo: r.versionNo, name: r.def.name, kind: r.def.kind, draft: r.draft }));
  if (sb.problems.length) {
    return { ...fail('RULE_INVALID', `The rule under test has ${sb.problems.length} validation problem(s). Fix them before simulating.`, sb.problems), rules };
  }

  let who: { customerId: string; customerRef: string };
  try {
    who = setupCustomer(sb, sc);
  } catch (e: any) {
    return { ...fail(e.code ?? 'BAD_SCENARIO', e.message), rules };
  }
  const r: Runner = {
    sb, ...who, tz, txns: new Map(), defsByCode: new Map(sb.rules.map((x) => [x.ruleCode, x])), cursors: { eval: 0, ledger: 0, nudge: 0 },
  };
  log.push(`Sandbox ready: ${sb.rules.length} rule(s), customer ${r.customerRef}, ${sc.accounts.length} account(s). Production data is not touched.`);

  const steps: SimStepResult[] = [];
  let ingestRejected = 0;
  let ingestDuplicates = 0;
  try {
    sc.steps.forEach((step, index) => {
      const at = stepInstant(step, tz);
      if (new Date(at) > sb.clock.now()) sb.clock.set(at);
      const before = progressRows(r);
      const events = buildEvents(r, step);
      const results = events.length ? sb.engine.ingestAndProcess(events).results : [];
      if (step.kind === 'CLOSE') sb.engine.closePeriods();
      sb.engine.dispatchNudges();
      const delta = collectDelta(r);
      for (const x of results) {
        if (x.status === 'REJECTED') ingestRejected++;
        if (x.status === 'DUPLICATE') ingestDuplicates++;
      }
      const after = progressRows(r);
      const res: SimStepResult = {
        index, kind: step.kind, label: step.label, at, description: describeStep(step),
        ingest: results.map((x) => ({ sourceEventId: x.sourceEventId, status: x.status, processingStatus: x.processingStatus, errors: x.errors })),
        ...delta, progressBefore: before, progressAfter: after,
      };
      steps.push(res);
      const pts = delta.ledger.reduce((a, l) => a + l.points, 0);
      log.push(`#${index + 1} ${res.description} -> ${results.map((x) => x.status).join('/') || 'no event'}${pts ? `, ${pts > 0 ? '+' : ''}${pts} XP` : ''}`);
    });

    // Take the final reading as of a date (advances the clock and closes periods).
    const lastDate = localDate(sb.clock.now().toISOString(), tz);
    const asOf = sc.asOf ?? lastDate;
    const asOfInstant = zonedToIso(asOf, '23:59', tz);
    if (new Date(asOfInstant) > sb.clock.now()) sb.clock.set(asOfInstant);
    const beforeFinal = progressRows(r);
    sb.engine.closePeriods();
    sb.engine.dispatchNudges();
    const tail = collectDelta(r);
    if (tail.ledger.length || tail.evaluations.length || tail.nudges.length) {
      steps.push({
        index: steps.length, kind: 'FINAL', at: sb.clock.now().toISOString(), description: `Close of day ${asOf}: periods that ended are finalised`, ingest: [],
        ...tail, progressBefore: beforeFinal, progressAfter: progressRows(r),
      });
      log.push(`Closed periods as of ${asOf}: ${tail.ledger.reduce((a, l) => a + l.points, 0)} XP`);
    }

    const result = summarise(r, steps, rules, asOf, ingestRejected, ingestDuplicates, input, started, log);
    return result;
  } catch (e: any) {
    log.push(`ERROR: ${e.message}`);
    return { ...fail(e.code ?? 'SIMULATION_ERROR', e.message, e.details), rules, steps };
  } finally {
    sb.db.close();
  }
}

function summarise(r: Runner, steps: SimStepResult[], rules: SimResult['rules'], asOf: string, rejected: number, duplicates: number, input: SimInput, started: number, log: string[]): SimResult {
  const { db } = r.sb;
  const ledger: SimLedger[] = db
    .all<any>(`SELECT l.*, r.rule_code FROM xp_ledger l LEFT JOIN rule r ON r.rule_id = l.rule_id WHERE l.customer_id = ? ORDER BY l.ledger_id`, r.customerId)
    .map((x) => ({ ledgerId: x.ledger_id, ruleCode: x.rule_code, type: x.entry_type, points: x.points, period: x.period_key, slot: x.slot, reason: x.reason_code, text: x.reason_text }));
  const byRule: Record<string, number> = {};
  for (const x of rules) byRule[x.ruleCode] = 0;
  for (const l of ledger) if (l.ruleCode) byRule[l.ruleCode] = (byRule[l.ruleCode] ?? 0) + l.points;
  const progress = progressRows(r);
  const achievedTier: Record<string, number> = {};
  for (const p of progress) achievedTier[p.ruleCode] = Math.max(achievedTier[p.ruleCode] ?? 0, p.achievedTier);
  for (const x of rules) achievedTier[x.ruleCode] ??= 0;
  // A duplicate award is more than one net AWARD in a slot whose value is fixed (tier:N), or a "best" slot that
  // holds more than the richest tier is worth. A HIGHEST_ONLY upgrade tops up the "best" slot and is not a duplicate.
  const dup = db.value<number>(
    `SELECT COUNT(*) FROM (
       SELECT l.rule_version_id AS rvid, l.slot AS slot,
              SUM(CASE WHEN l.entry_type='AWARD' THEN 1 ELSE 0 END) - SUM(CASE WHEN l.entry_type='REVERSAL' THEN 1 ELSE 0 END) AS net_n,
              SUM(l.points) AS net_points
         FROM xp_ledger l
        WHERE l.customer_id = ? AND l.rule_id IS NOT NULL AND l.entry_type IN ('AWARD','REVERSAL') AND (l.slot LIKE 'tier:%' OR l.slot = 'best')
        GROUP BY l.rule_version_id, l.period_key, l.slot) g
      WHERE (g.slot LIKE 'tier:%' AND g.net_n > 1)
         OR (g.slot = 'best' AND g.net_points > COALESCE((SELECT MAX(t.points) FROM rule_tier t WHERE t.rule_version_id = g.rvid), 0))`,
    r.customerId,
  ) ?? 0;
  const events: Record<string, number> = {};
  for (const x of db.all<{ processing_status: string; n: number }>('SELECT processing_status, COUNT(*) n FROM ingestion_event GROUP BY 1')) events[x.processing_status] = x.n;
  const nudges: SimNudge[] = db
    .all<any>(`SELECT n.*, r.rule_code FROM nudge n LEFT JOIN rule r ON r.rule_id = n.rule_id WHERE n.customer_id = ? ORDER BY n.rowid`, r.customerId)
    .map((x) => ({ type: x.nudge_type, channel: x.channel, status: x.status, ruleCode: x.rule_code, message: x.message, suppressReason: x.suppress_reason }));
  const final: NonNullable<SimResult['final']> = {
    totalPoints: ledger.reduce((a, l) => a + l.points, 0),
    pointsByRule: byRule,
    awards: ledger.filter((l) => l.type === 'AWARD').length,
    reversals: ledger.filter((l) => l.type === 'REVERSAL').length,
    duplicateAwards: dup,
    ledger, progress, nudges, achievedTier, events, rejected, duplicates, asOf,
  };
  const result: SimResult = { ok: true, name: input.name, rules, steps, final, checks: [], passed: null, durationMs: 0, log };
  if (input.expected) {
    result.checks = compareExpected(result, input.expected);
    result.passed = result.checks.every((c) => c.pass);
  }
  result.durationMs = Math.round(performance.now() - started);
  return result;
}

// ---------------------------------------------------------------------
// Expected vs actual
// ---------------------------------------------------------------------
export function compareExpected(res: SimResult, exp: SimExpected): SimCheck[] {
  const f = res.final;
  if (!f) return [{ name: 'Simulation completed', expected: 'completed', actual: res.error?.message ?? 'did not complete', pass: false }];
  const checks: SimCheck[] = [];
  const add = (name: string, expected: unknown, actual: unknown) =>
    checks.push({ name, expected: String(expected), actual: String(actual), pass: String(expected) === String(actual) });

  if (exp.totalPoints !== undefined) add('Total XP', exp.totalPoints, f.totalPoints);
  for (const [code, pts] of Object.entries(exp.pointsByRule ?? {})) add(`XP for ${code}`, pts, f.pointsByRule[code] ?? 0);
  for (const [code, tier] of Object.entries(exp.achievedTier ?? {})) add(`Highest tier credited for ${code}`, tier, f.achievedTier[code] ?? 0);
  for (const [code, v] of Object.entries(exp.metric ?? {})) {
    const rows = f.progress.filter((p) => p.ruleCode === code);
    const last = rows[rows.length - 1];
    add(`Final metric of ${code}`, v, last ? Math.round(last.metric * 100) / 100 : 'no progress');
  }
  for (const [code, st] of Object.entries(exp.progressStatus ?? {})) {
    const rows = f.progress.filter((p) => p.ruleCode === code);
    add(`Final status of ${code}`, st, rows[rows.length - 1]?.status ?? 'no progress');
  }
  if (exp.awards !== undefined) add('Number of award entries', exp.awards, f.awards);
  if (exp.reversals !== undefined) add('Number of reversal entries', exp.reversals, f.reversals);
  if (exp.noDuplicateAwards) add('No duplicate awards', 0, f.duplicateAwards);
  for (const [type, n] of Object.entries(exp.nudges ?? {})) add(`Nudges of type ${type}`, n, f.nudges.filter((x) => x.type === type && x.status !== 'SUPPRESSED').length);
  if (exp.rejectedEvents !== undefined) add('Rejected events', exp.rejectedEvents, f.rejected);
  if (exp.duplicateEvents !== undefined) add('Duplicate deliveries ignored', exp.duplicateEvents, f.duplicates);
  for (const o of exp.outcomes ?? []) {
    const step = res.steps[o.step];
    const evs = step?.evaluations.filter((e) => e.ruleCode === o.ruleCode) ?? [];
    const actual = evs.length ? evs[evs.length - 1].outcome : 'no evaluation';
    add(`Outcome of ${o.ruleCode} at step ${o.step + 1}`, o.outcome, actual);
  }
  return checks;
}

/** Convenience for tests and the API: run and return only when the expectation holds. */
export function assertScenario(source: RuleSource, input: SimInput): SimResult {
  const res = runScenario(source, input);
  if (!res.ok) throw new MxpError(res.error!.code, res.error!.message);
  return res;
}

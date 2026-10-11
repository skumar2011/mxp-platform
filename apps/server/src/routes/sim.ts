import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MxpError, audit, archiveCase, cloneCase, generateMatrix, getCase, getRun, getSuiteRun, listCases, listRuns, listRules, listSuiteRuns, listVersions, previewForCustomer,
  runAndRecord, runCase, runPerformance, runScenario, runSuite, saveCase, saveMatrix, type SimInput, type SimResult,
} from '@mxp/engine';
import type { AppCtx } from '../context';
import { need, parse, sendCsv, sendJsonDownload, toCsv, userOf } from '../util';

const ruleRef = z.object({ ruleCode: z.string().min(1), versionNo: z.number().int().min(1).optional(), definition: z.unknown().optional() });
const inputSchema = z.object({
  name: z.string().max(200).optional(),
  rules: z.array(ruleRef).max(20),
  includeActive: z.boolean().optional(),
  scenario: z.object({ accounts: z.array(z.any()), steps: z.array(z.any()).max(5000) }).passthrough(),
  expected: z.any().optional(),
}) as unknown as z.ZodType<SimInput>;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function simRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { db, sim, source } = ctx;
  const who = (req: any) => userOf(req).username;

  /** Picker data: every rule with its versions, so a test can pin a version, use the live one, or test a draft. */
  app.get('/sim/rules', async (req) => {
    need(req, 'simulate');
    return {
      rules: listRules(db).map((r) => ({
        ruleCode: r.ruleCode, name: r.name, kind: r.kind, liveVersionNo: r.liveVersionNo,
        versions: listVersions(db, r.ruleCode).map((v) => ({ versionNo: v.versionNo, status: v.status, name: v.name })),
      })),
    };
  });

  app.post('/sim/run', async (req) => {
    need(req, 'simulate');
    const b = parse(z.object({ input: inputSchema, record: z.boolean().optional() }), req.body);
    if (b.record === false) return { runId: null, status: null, result: runScenario(source, b.input) };
    return runAndRecord(source, sim, who(req), b.input);
  });

  // ---------- scenario matrix ----------
  app.post('/sim/matrix', async (req) => {
    need(req, 'simulate');
    const b = parse(z.object({ rule: ruleRef, save: z.boolean().optional(), run: z.boolean().optional(), mode: z.enum(['PINNED', 'LIVE']).optional() }), req.body);
    const m = generateMatrix(source, b.rule);
    const status = new Map<string, { status: string; runId?: string; failedChecks: unknown[]; durationMs?: number }>();
    let suite: { suiteRunId: string; total: number; passed: number; failed: number; errors: number } | null = null;
    if (b.save) {
      need(req, 'testcases:write');
      const saved = saveMatrix(sim, who(req), m);
      if (b.run) {
        const r = runSuite(source, sim, who(req), { caseIds: saved.map((s) => s.caseId) }, b.mode ?? 'PINNED', `Matrix ${m.ruleCode} v${m.versionNo}`);
        suite = r;
        const nameOf = new Map(saved.map((s) => [s.caseId, s.name]));
        for (const row of r.rows) status.set(nameOf.get(row.caseId)!, { status: row.status, runId: row.runId, failedChecks: row.failedChecks, durationMs: row.durationMs });
      }
    } else if (b.run) {
      let passed = 0, failed = 0, errors = 0;
      for (const c of m.cases) {
        const res = runScenario(source, { name: c.name, rules: c.rules, scenario: c.scenario, expected: c.expected });
        const st = !res.ok ? 'ERROR' : res.passed ? 'PASSED' : 'FAILED';
        if (st === 'PASSED') passed++; else if (st === 'FAILED') failed++; else errors++;
        status.set(c.name, { status: st, failedChecks: res.checks.filter((x) => !x.pass), durationMs: res.durationMs });
      }
      suite = { suiteRunId: '', total: m.cases.length, passed, failed, errors };
    }
    // Evidence for approvers: the outcome of a full matrix run is recorded against the exact rule version.
    if (suite && b.run && b.rule.definition === undefined) {
      audit(ctx.db, ctx.clock, { username: who(req), roles: userOf(req).roles }, 'SIMULATION_RUN', 'rule_version', `${m.ruleCode}@${m.versionNo}`, null, { total: suite.total, passed: suite.passed, failed: suite.failed, errors: suite.errors, kind: 'MATRIX' });
    }
    return { ruleCode: m.ruleCode, versionNo: m.versionNo, notes: m.notes, suite, cases: m.cases.map((c) => ({ ...c, result: status.get(c.name) ?? null })) };
  });

  // ---------- saved test cases ----------
  app.get('/sim/cases', async (req) => {
    need(req, 'simulate');
    const q = req.query as any;
    return {
      cases: listCases(sim, { ruleCode: q.ruleCode, category: q.category, q: q.q, includeArchived: q.archived === '1' }).map(({ input, ...c }) => ({
        ...c, steps: input.scenario.steps.length, hasExpectation: !!input.expected,
      })),
    };
  });
  app.get('/sim/cases/:id', async (req) => {
    need(req, 'simulate');
    const c = getCase(sim, (req.params as any).id);
    if (!c) throw new MxpError('NOT_FOUND', 'Test case not found.', 404);
    return { case: c, runs: listRuns(sim, { caseId: c.caseId, limit: 20 }) };
  });
  const caseBody = z.object({
    name: z.string().min(3).max(200), description: z.string().max(1000).optional(), category: z.string().max(30).optional(), tags: z.array(z.string().max(30)).max(10).optional(), input: inputSchema,
  });
  app.post('/sim/cases', async (req, reply) => {
    need(req, 'testcases:write');
    return reply.code(201).send(saveCase(sim, who(req), parse(caseBody, req.body)));
  });
  app.put('/sim/cases/:id', async (req) => {
    need(req, 'testcases:write');
    return saveCase(sim, who(req), parse(caseBody, req.body), (req.params as any).id);
  });
  app.post('/sim/cases/:id/clone', async (req, reply) => {
    need(req, 'testcases:write');
    const b = parse(z.object({ name: z.string().min(3).max(200).optional() }), req.body ?? {});
    return reply.code(201).send(cloneCase(sim, who(req), (req.params as any).id, b.name));
  });
  app.delete('/sim/cases/:id', async (req) => {
    need(req, 'testcases:write');
    archiveCase(sim, (req.params as any).id, true);
    return { ok: true };
  });
  app.post('/sim/cases/:id/run', async (req) => {
    need(req, 'simulate');
    const b = parse(z.object({ mode: z.enum(['PINNED', 'LIVE']).optional() }), req.body ?? {});
    return runCase(source, sim, who(req), (req.params as any).id, b.mode ?? 'PINNED');
  });

  // ---------- suites (regression) ----------
  app.post('/sim/suites/run', async (req) => {
    need(req, 'simulate');
    const b = parse(
      z.object({ ruleCode: z.string().optional(), category: z.string().optional(), caseIds: z.array(z.string()).max(2000).optional(), mode: z.enum(['PINNED', 'LIVE']).optional(), label: z.string().max(120).optional() }),
      req.body ?? {},
    );
    return runSuite(source, sim, who(req), { ruleCode: b.ruleCode, category: b.category, caseIds: b.caseIds }, b.mode ?? 'PINNED', b.label);
  });
  app.get('/sim/suites', async (req) => {
    need(req, 'simulate');
    return { suites: listSuiteRuns(sim) };
  });
  app.get('/sim/suites/:id', async (req) => {
    need(req, 'simulate');
    const s = getSuiteRun(sim, (req.params as any).id);
    if (!s) throw new MxpError('NOT_FOUND', 'Suite run not found.', 404);
    return s;
  });
  app.get('/sim/suites/:id/download', async (req, reply) => {
    need(req, 'simulate');
    const s = getSuiteRun(sim, (req.params as any).id);
    if (!s) throw new MxpError('NOT_FOUND', 'Suite run not found.', 404);
    if ((req.query as any).format === 'json') return sendJsonDownload(reply, `suite-${s.suite.suite_run_id}.json`, s);
    const rows = s.runs.flatMap((r: any) => {
      const failed = (r.checks as any[]).filter((c) => !c.pass);
      if (!failed.length) return [{ testCase: r.case_name, status: r.status, check: '', expected: '', actual: '', durationMs: r.duration_ms }];
      return failed.map((c) => ({ testCase: r.case_name, status: r.status, check: c.name, expected: c.expected, actual: c.actual, durationMs: r.duration_ms }));
    });
    return sendCsv(reply, `suite-${s.suite.suite_run_id}.csv`, toCsv(['testCase', 'status', 'check', 'expected', 'actual', 'durationMs'], rows));
  });

  // ---------- single runs ----------
  app.get('/sim/runs', async (req) => {
    need(req, 'simulate');
    const q = req.query as any;
    return { runs: listRuns(sim, { caseId: q.caseId, limit: Math.min(Number(q.limit) || 100, 500) }) };
  });
  app.get('/sim/runs/:id', async (req) => {
    need(req, 'simulate');
    const r = getRun(sim, (req.params as any).id);
    if (!r) throw new MxpError('NOT_FOUND', 'Run not found.', 404);
    return r;
  });
  app.get('/sim/runs/:id/download', async (req, reply) => {
    need(req, 'simulate');
    const r = getRun(sim, (req.params as any).id);
    if (!r) throw new MxpError('NOT_FOUND', 'Run not found.', 404);
    if ((req.query as any).format === 'json') return sendJsonDownload(reply, `run-${r.run_id}.json`, r);
    return sendCsv(reply, `run-${r.run_id}.csv`, runCsv(r.case_name, r.status, r.result));
  });

  // ---------- performance ----------
  app.post('/sim/perf', async (req) => {
    need(req, 'simulate');
    const b = parse(
      z.object({ rule: ruleRef, customers: z.number().int().min(1).max(5000).optional(), txnsPerCustomer: z.number().int().min(1).max(200).optional(), duplicateRatio: z.number().min(0).max(0.5).optional() }),
      req.body,
    );
    const events = (b.customers ?? 200) * (b.txnsPerCustomer ?? 10);
    if (events > 20_000) {
      throw new MxpError('TOO_LARGE', `That is ${events.toLocaleString()} events. Keep customers x transactions at or below 20,000 per run; run bigger loads on a dedicated simulation instance.`, 422);
    }
    return runPerformance(source, { rule: b.rule, customers: b.customers, txnsPerCustomer: b.txnsPerCustomer, duplicateRatio: b.duplicateRatio });
  });

  // ---------- preview against real customers (reads production; the replay itself runs in a sandbox) ----------
  app.post('/sim/preview', async (req) => {
    need(req, 'simulate');
    need(req, 'customers:read');
    const b = parse(z.object({ rule: ruleRef, customerRef: z.string().min(1).max(64), fromDate: isoDate.optional(), toDate: isoDate.optional(), includeActive: z.boolean().optional() }), req.body);
    return previewForCustomer(db, source, b.rule, b.customerRef, b);
  });

  app.post('/sim/preview-sample', async (req) => {
    need(req, 'simulate');
    need(req, 'customers:read');
    const b = parse(z.object({ rule: ruleRef, limit: z.number().int().min(1).max(50).optional() }), req.body);
    const refs = db.all<{ customer_ref: string }>(
      `SELECT c.customer_ref FROM customer c WHERE c.status = 'ACTIVE'
        ORDER BY (SELECT COUNT(*) FROM txn_master t WHERE t.customer_id = c.customer_id) DESC, c.customer_ref LIMIT ?`,
      b.limit ?? 25,
    );
    const rows: any[] = [];
    for (const { customer_ref } of refs) {
      try {
        const r = previewForCustomer(db, source, b.rule, customer_ref);
        const prog = r.final?.progress?.at(-1);
        rows.push({ customerRef: customer_ref, ok: r.ok, points: r.final?.totalPoints ?? 0, awards: r.final?.awards ?? 0, status: prog?.status ?? null, metric: prog?.metric ?? null, tier: prog?.achievedTier ?? 0, error: r.error?.message });
      } catch (e: any) {
        rows.push({ customerRef: customer_ref, ok: false, points: 0, awards: 0, error: e.message });
      }
    }
    const earning = rows.filter((r) => r.points > 0);
    return { customersEvaluated: rows.length, customersEarning: earning.length, totalPoints: earning.reduce((a, r) => a + r.points, 0), rows };
  });
}

/** Flat CSV of one run: checks, evaluations, then the XP ledger it produced. */
function runCsv(name: string, status: string, res: SimResult | null): string {
  const cols = ['section', 'name', 'expected', 'actual', 'result'];
  if (!res) return toCsv(cols, []);
  const rows: Record<string, unknown>[] = [{ section: 'RUN', name, expected: '', actual: '', result: status }];
  for (const c of res.checks) rows.push({ section: 'CHECK', name: c.name, expected: c.expected, actual: c.actual, result: c.pass ? 'PASS' : 'FAIL' });
  res.steps.forEach((s, i) => {
    for (const e of s.evaluations) rows.push({ section: 'EVALUATION', name: `step ${i + 1} ${e.ruleCode} v${e.versionNo}`, expected: e.reasonText ?? '', actual: `${e.outcome} (${e.pointsDelta >= 0 ? '+' : ''}${e.pointsDelta})`, result: e.eligible ? 'eligible' : 'not eligible' });
  });
  for (const l of res.final?.ledger ?? []) rows.push({ section: 'LEDGER', name: `${l.ruleCode ?? ''} ${l.type}`.trim(), expected: '', actual: String(l.points), result: l.text ?? l.reason });
  return toCsv(cols, rows);
}

import { Db } from './db';
import { runScenario } from './sim';
import type { MatrixResult } from './simgen';
import type { RuleSource, SimInput, SimResult } from './simtypes';
import { MxpError, uid } from './util';

/**
 * Test-case and run history live in their own database file, separate from production data.
 * A simulation can therefore never write into the production ledger or transaction master.
 */
const SIM_DDL = `
CREATE TABLE IF NOT EXISTS sim_test_case (
  case_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  category     TEXT NOT NULL DEFAULT 'CUSTOM',
  tags_json    TEXT NOT NULL DEFAULT '[]',
  rule_code    TEXT,
  input_json   TEXT NOT NULL,
  matrix_key   TEXT UNIQUE,
  cloned_from  TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stc_rule ON sim_test_case(rule_code);

CREATE TABLE IF NOT EXISTS sim_suite_run (
  suite_run_id TEXT PRIMARY KEY,
  label        TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  total        INTEGER NOT NULL DEFAULT 0,
  passed       INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  errors       INTEGER NOT NULL DEFAULT 0,
  version_mode TEXT NOT NULL DEFAULT 'PINNED',
  run_by       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_test_run (
  run_id       TEXT PRIMARY KEY,
  case_id      TEXT,
  suite_run_id TEXT,
  case_name    TEXT,
  started_at   TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('PASSED','FAILED','ERROR','NO_EXPECTATION')),
  checks_json  TEXT NOT NULL DEFAULT '[]',
  rules_json   TEXT NOT NULL DEFAULT '[]',
  result_json  TEXT,
  run_by       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_str_case ON sim_test_run(case_id, started_at);
CREATE INDEX IF NOT EXISTS ix_str_suite ON sim_test_run(suite_run_id);
`;

export function openSimStore(path = ':memory:'): Db {
  const db = new Db(path);
  db.exec(SIM_DDL);
  return db;
}

export interface SavedCase {
  caseId: string;
  name: string;
  description: string | null;
  category: string;
  tags: string[];
  ruleCode: string | null;
  input: SimInput;
  clonedFrom: string | null;
  archived: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRun?: { runId: string; status: string; at: string } | null;
}

const toCase = (r: any, lastRun?: any): SavedCase => ({
  caseId: r.case_id, name: r.name, description: r.description, category: r.category, tags: JSON.parse(r.tags_json), ruleCode: r.rule_code,
  input: JSON.parse(r.input_json), clonedFrom: r.cloned_from, archived: !!r.archived, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  lastRun: lastRun ? { runId: lastRun.run_id, status: lastRun.status, at: lastRun.started_at } : null,
});

export interface CaseInput {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  input: SimInput;
}

function checkInput(i: CaseInput) {
  if (!i.name || i.name.trim().length < 3) throw new MxpError('BAD_NAME', 'A test case needs a name (min 3 characters).', 422);
  if (!i.input?.scenario || !Array.isArray(i.input.scenario.steps)) throw new MxpError('BAD_SCENARIO', 'The test case needs a scenario with steps.', 422);
  if (!i.input.rules?.length && !i.input.includeActive) throw new MxpError('NO_RULES', 'Select at least one rule.', 422);
  if (JSON.stringify(i.input).length > 1_000_000) throw new MxpError('TOO_LARGE', 'The test case is too large (max 1 MB).', 413);
}

export function saveCase(store: Db, by: string, i: CaseInput, caseId?: string): SavedCase {
  checkInput(i);
  const now = new Date().toISOString();
  const ruleCode = i.input.rules?.[0]?.ruleCode ?? null;
  if (caseId) {
    const cur = store.get('SELECT 1 FROM sim_test_case WHERE case_id = ?', caseId);
    if (!cur) throw new MxpError('NOT_FOUND', 'Test case not found.', 404);
    store.run(
      'UPDATE sim_test_case SET name=?, description=?, category=?, tags_json=?, rule_code=?, input_json=?, updated_at=? WHERE case_id=?',
      i.name.trim(), i.description ?? null, i.category ?? 'CUSTOM', JSON.stringify(i.tags ?? []), ruleCode, JSON.stringify(i.input), now, caseId,
    );
    return getCase(store, caseId)!;
  }
  const id = uid();
  store.run(
    `INSERT INTO sim_test_case(case_id, name, description, category, tags_json, rule_code, input_json, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, i.name.trim(), i.description ?? null, i.category ?? 'CUSTOM', JSON.stringify(i.tags ?? []), ruleCode, JSON.stringify(i.input), by, now, now,
  );
  return getCase(store, id)!;
}

export function getCase(store: Db, caseId: string): SavedCase | undefined {
  const r = store.get('SELECT * FROM sim_test_case WHERE case_id = ?', caseId);
  return r ? toCase(r) : undefined;
}

export function listCases(store: Db, f: { ruleCode?: string; category?: string; q?: string; includeArchived?: boolean } = {}): SavedCase[] {
  const where: string[] = [];
  const args: string[] = [];
  if (!f.includeArchived) where.push('c.archived = 0');
  if (f.ruleCode) { where.push('c.rule_code = ?'); args.push(f.ruleCode); }
  if (f.category) { where.push('c.category = ?'); args.push(f.category); }
  if (f.q) { where.push('(c.name LIKE ? OR c.description LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`); }
  const rows = store.all<any>(
    `SELECT c.*, r.run_id, r.status, r.started_at FROM sim_test_case c
       LEFT JOIN sim_test_run r ON r.run_id = (SELECT run_id FROM sim_test_run WHERE case_id = c.case_id ORDER BY started_at DESC, rowid DESC LIMIT 1)
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.rule_code, c.created_at, c.name LIMIT 2000`,
    ...args,
  );
  return rows.map((r) => toCase(r, r.run_id ? r : null));
}

export function cloneCase(store: Db, by: string, caseId: string, name?: string): SavedCase {
  const c = getCase(store, caseId);
  if (!c) throw new MxpError('NOT_FOUND', 'Test case not found.', 404);
  const copy = saveCase(store, by, { name: name ?? `${c.name} (copy)`, description: c.description ?? undefined, category: 'CUSTOM', tags: c.tags.filter((t) => t !== 'matrix'), input: c.input });
  store.run('UPDATE sim_test_case SET cloned_from = ? WHERE case_id = ?', caseId, copy.caseId);
  return getCase(store, copy.caseId)!;
}

export function archiveCase(store: Db, caseId: string, archived = true) {
  store.run('UPDATE sim_test_case SET archived = ?, updated_at = ? WHERE case_id = ?', archived ? 1 : 0, new Date().toISOString(), caseId);
}

/** Stores generated matrix scenarios. Re-saving updates the same cases instead of piling up duplicates. */
export function saveMatrix(store: Db, by: string, m: MatrixResult): SavedCase[] {
  const now = new Date().toISOString();
  const out: SavedCase[] = [];
  store.tx(() => {
    for (const c of m.cases) {
      const key = `${m.ruleCode}|${c.name}`;
      const input: SimInput = { name: c.name, rules: c.rules, scenario: c.scenario, expected: c.expected };
      const cur = store.get<{ case_id: string }>('SELECT case_id FROM sim_test_case WHERE matrix_key = ?', key);
      if (cur) {
        store.run('UPDATE sim_test_case SET description=?, category=?, input_json=?, archived=0, updated_at=? WHERE case_id=?', c.description, c.category, JSON.stringify(input), now, cur.case_id);
        out.push(getCase(store, cur.case_id)!);
      } else {
        const id = uid();
        store.run(
          `INSERT INTO sim_test_case(case_id, name, description, category, tags_json, rule_code, input_json, matrix_key, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          id, c.name, c.description, c.category, JSON.stringify(['matrix', m.ruleCode]), m.ruleCode, JSON.stringify(input), key, by, now, now,
        );
        out.push(getCase(store, id)!);
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------
export type VersionMode = 'PINNED' | 'LIVE';

function withMode(input: SimInput, mode: VersionMode): SimInput {
  if (mode === 'PINNED') return input;
  return { ...input, rules: input.rules.map((r) => (r.definition === undefined ? { ruleCode: r.ruleCode } : r)) };
}

function statusOf(res: SimResult, hasExpectation: boolean): 'PASSED' | 'FAILED' | 'ERROR' | 'NO_EXPECTATION' {
  if (!res.ok) return 'ERROR';
  if (!hasExpectation) return 'NO_EXPECTATION';
  return res.passed ? 'PASSED' : 'FAILED';
}

function recordRun(store: Db, by: string, c: { caseId: string | null; name: string }, res: SimResult, hasExpectation: boolean, suiteRunId: string | null) {
  const runId = uid();
  const status = statusOf(res, hasExpectation);
  let json = JSON.stringify(res);
  if (json.length > 3_000_000) json = JSON.stringify({ ...res, steps: res.steps.map((s) => ({ ...s, evaluations: s.evaluations.map((e) => ({ ...e, trace: null })) })) });
  store.run(
    `INSERT INTO sim_test_run(run_id, case_id, suite_run_id, case_name, started_at, duration_ms, status, checks_json, rules_json, result_json, run_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    runId, c.caseId, suiteRunId, c.name, new Date().toISOString(), res.durationMs, status, JSON.stringify(res.checks), JSON.stringify(res.rules), json, by,
  );
  return { runId, status };
}

/** Runs ad-hoc input (not necessarily saved) and records it in the run history. */
export function runAndRecord(source: RuleSource, store: Db, by: string, input: SimInput, caseId: string | null = null) {
  const res = runScenario(source, input);
  const rec = recordRun(store, by, { caseId, name: input.name ?? 'Ad-hoc simulation' }, res, !!input.expected, null);
  return { ...rec, result: res };
}

export function runCase(source: RuleSource, store: Db, by: string, caseId: string, mode: VersionMode = 'PINNED', suiteRunId: string | null = null) {
  const c = getCase(store, caseId);
  if (!c) throw new MxpError('NOT_FOUND', 'Test case not found.', 404);
  const input = withMode(c.input, mode);
  const res = runScenario(source, { ...input, name: c.name });
  const rec = recordRun(store, by, { caseId, name: c.name }, res, !!input.expected, suiteRunId);
  return { ...rec, result: res };
}

export interface SuiteFilter {
  ruleCode?: string;
  category?: string;
  caseIds?: string[];
}

export function runSuite(source: RuleSource, store: Db, by: string, filter: SuiteFilter = {}, mode: VersionMode = 'PINNED', label?: string) {
  const suiteRunId = uid();
  const started = new Date().toISOString();
  store.run('INSERT INTO sim_suite_run(suite_run_id, label, started_at, version_mode, run_by) VALUES (?,?,?,?,?)', suiteRunId, label ?? null, started, mode, by);
  let cases = listCases(store, { ruleCode: filter.ruleCode, category: filter.category });
  if (filter.caseIds?.length) cases = cases.filter((c) => filter.caseIds!.includes(c.caseId));
  let passed = 0, failed = 0, errors = 0;
  const rows: { caseId: string; name: string; status: string; runId: string; durationMs: number; failedChecks: unknown[] }[] = [];
  for (const c of cases) {
    const r = runCase(source, store, by, c.caseId, mode, suiteRunId);
    if (r.status === 'PASSED' || r.status === 'NO_EXPECTATION') passed++;
    else if (r.status === 'FAILED') failed++;
    else errors++;
    rows.push({ caseId: c.caseId, name: c.name, status: r.status, runId: r.runId, durationMs: r.result.durationMs, failedChecks: r.result.checks.filter((x) => !x.pass) });
  }
  store.run('UPDATE sim_suite_run SET finished_at = ?, total = ?, passed = ?, failed = ?, errors = ? WHERE suite_run_id = ?', new Date().toISOString(), cases.length, passed, failed, errors, suiteRunId);
  return { suiteRunId, total: cases.length, passed, failed, errors, rows };
}

export function listSuiteRuns(store: Db, limit = 50) {
  return store.all<any>('SELECT * FROM sim_suite_run ORDER BY started_at DESC, rowid DESC LIMIT ?', limit);
}

export function getSuiteRun(store: Db, suiteRunId: string) {
  const suite = store.get<any>('SELECT * FROM sim_suite_run WHERE suite_run_id = ?', suiteRunId);
  if (!suite) return undefined;
  const runs = store.all<any>(
    'SELECT run_id, case_id, case_name, status, duration_ms, checks_json, started_at FROM sim_test_run WHERE suite_run_id = ? ORDER BY rowid',
    suiteRunId,
  ).map((r) => ({ ...r, checks: JSON.parse(r.checks_json) }));
  return { suite, runs };
}

export function listRuns(store: Db, f: { caseId?: string; limit?: number } = {}) {
  return store.all<any>(
    `SELECT run_id, case_id, suite_run_id, case_name, started_at, duration_ms, status, rules_json, run_by FROM sim_test_run
      ${f.caseId ? 'WHERE case_id = ?' : ''} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
    ...(f.caseId ? [f.caseId] : []), f.limit ?? 100,
  ).map((r) => ({ ...r, rules: JSON.parse(r.rules_json) }));
}

export function getRun(store: Db, runId: string) {
  const r = store.get<any>('SELECT * FROM sim_test_run WHERE run_id = ?', runId);
  if (!r) return undefined;
  return { ...r, checks: JSON.parse(r.checks_json), rules: JSON.parse(r.rules_json), result: r.result_json ? (JSON.parse(r.result_json) as SimResult) : null };
}

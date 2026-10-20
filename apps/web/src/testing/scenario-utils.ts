import type { Outcome, ProcessResult, Scenario, ScenarioResult, StepExpect } from '@mxp/rules';
import { api } from '../shared/api';

/** Outcomes that mean "this rule did not apply"; recording them as expectations is noise. */
export const SKIPPED = new Set(['OUT_OF_SCOPE', 'NOT_EFFECTIVE', 'NOT_ELIGIBLE', 'NOT_ENROLLED']);

const pointsOf = (res: ProcessResult, focusRule?: string) =>
  res.effects.reduce((s, f) => s + ((f.type === 'AWARD' || f.type === 'CLAWBACK') && (!focusRule || f.ruleCode === focusRule) ? f.points : 0), 0);

/** Expectations that a step's actual result satisfies (used to record a journey). */
export function expectOf(res: ProcessResult | undefined, focusRule?: string): StepExpect | undefined {
  if (!res) return undefined;
  const outcomes: Record<string, Outcome> = {};
  for (const e of res.evaluations) if (!SKIPPED.has(e.outcome) && (!focusRule || e.ruleCode === focusRule) && !outcomes[e.ruleCode]) outcomes[e.ruleCode] = e.outcome;
  return { outcomes, decision: res.decision, points: pointsOf(res, focusRule) };
}

/** Rewrites a scenario's existing expectations with what the current pack produced (same keys only). */
export function acceptResults(sc: Scenario, run: ScenarioResult): Scenario {
  const steps = sc.steps.map((s, i) => {
    if (!('expect' in s) || !s.expect) return s;
    const res = run.steps[i]?.result;
    if (!res) return s;
    const ex: StepExpect = {};
    if (s.expect.outcomes) ex.outcomes = Object.fromEntries(Object.keys(s.expect.outcomes).map((code) => [code, res.evaluations.find((e) => e.ruleCode === code)?.outcome ?? s.expect!.outcomes![code]]));
    if (s.expect.decision) ex.decision = res.decision;
    if (s.expect.points !== undefined) ex.points = run.steps[i].points;
    return { ...s, expect: ex };
  });
  return { ...sc, steps, expect: sc.expect?.totalPoints !== undefined ? { ...sc.expect, totalPoints: run.totalPoints } : sc.expect };
}

export interface SavedScenario { scenario_id: string; name: string; description?: string; focus_rule_code?: string; tags: string[]; last_status?: string; last_run_at?: string; created_by: string; updated_at: string; definition: Scenario }

export const saveScenario = (scenario: Scenario) => api<SavedScenario>('/test-scenarios', { body: { scenario } });

export function recordRun(kind: 'SCENARIO' | 'SUITE' | 'MATRIX', packSource: string, packHash: string | null, results: { scenarioId?: string; name: string; passed: boolean; failures: string[] }[]) {
  return api<{ runId: string }>('/test-runs', {
    body: {
      kind, packSource, packHash: packHash ?? undefined, scenarioId: kind === 'SCENARIO' ? results[0]?.scenarioId : undefined,
      passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length,
      results: results.map((r) => ({ ...r, failures: r.failures.slice(0, 20) })),
    },
  });
}

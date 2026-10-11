import { describe, expect, it } from 'vitest';
import { DbRuleSource, generateMatrix, runScenario } from '../../src/index';
import { seededDb } from '../helpers';

/**
 * Regression gate: for every sample rule, MXP generates its scenarios (boundary, duplicate, reversal, refund,
 * status, period, cap, eligibility, combined...) with expectations derived from the rule's own definition,
 * then runs them through the real engine. A change to the engine that alters any rule's behaviour fails here.
 */
const db = seededDb();
const source = new DbRuleSource(db);
const rules = db.all<{ rule_code: string }>('SELECT rule_code FROM rule ORDER BY rule_code').map((r) => r.rule_code);

describe('auto-generated scenario matrix for every sample rule', () => {
  it('covers all seven sample rules', () => {
    expect(rules).toEqual(['BALANCE_PLUS_CARD', 'CARD_SPEND_10K', 'SAV_AVG_BAL_50K', 'SAV_GROWTH_25K', 'UPI_10_TXNS', 'UPI_MERCHANT_PER_TXN', 'UTILITY_3_BILLS']);
  });

  for (const code of rules) {
    describe(code, () => {
      const matrix = generateMatrix(source, { ruleCode: code });
      it('generates a meaningful set of scenarios', () => {
        expect(matrix.cases.length).toBeGreaterThanOrEqual(5);
        expect(new Set(matrix.cases.map((c) => c.name)).size).toBe(matrix.cases.length);
      });
      for (const c of matrix.cases) {
        it(`[${c.category}] ${c.name}`, () => {
          const res = runScenario(source, { name: c.name, rules: c.rules, scenario: c.scenario, expected: c.expected });
          expect(res.ok, JSON.stringify(res.error)).toBe(true);
          const failed = res.checks.filter((k) => !k.pass).map((k) => `${k.name}: expected ${k.expected}, got ${k.actual}`);
          expect(failed).toEqual([]);
          expect(res.final!.duplicateAwards).toBe(0);
        });
      }
    });
  }
});

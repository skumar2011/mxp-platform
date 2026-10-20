import { describe, expect, it } from 'vitest';
import { RulePackError, RulesEngine, validatePack, checkTemplate, parseTemplate } from '../src';
import { CATALOG_TEMPLATES, samplePack } from '../src/catalog';
import { engine } from './helpers';

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('rule pack validation', () => {
  it('accepts the sample pack with no errors or warnings', () => {
    const r = validatePack(samplePack());
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('covers every capability in the catalogue', () => {
    const names = CATALOG_TEMPLATES.map((t) => t.code);
    expect(names).toHaveLength(16);
    const controls = CATALOG_TEMPLATES.filter((t) => t.family === 'SPEND_CONTROL').map((t) => t.code);
    expect(controls).toEqual(['DAILY_SPEND_LIMIT', 'MONTHLY_SPEND_LIMIT', 'CATEGORY_SPEND_LIMIT', 'MERCHANT_RESTRICTION', 'TXN_TYPE_RESTRICTION', 'TIMING_RESTRICTION']);
  });

  it('rejects a mission with a customer-set parameter', () => {
    const t = structuredClone(CATALOG_TEMPLATES.find((x) => x.code === 'UPI_TXN_COUNT')!);
    t.params![0].setBy = 'CUSTOMER';
    const { template } = parseTemplate(t);
    expect(codes(checkTemplate(template!))).toContain('MISSION_CUSTOMER_PARAM');
  });

  it('rejects a spend control without a customer parameter or minimum activity', () => {
    const t = structuredClone(CATALOG_TEMPLATES.find((x) => x.code === 'DAILY_SPEND_LIMIT')!);
    t.params![0].setBy = 'BANK';
    delete (t.logic.reward as { minActivity?: unknown }).minActivity;
    const { template } = parseTemplate(t);
    const c = codes(checkTemplate(template!));
    expect(c).toContain('CONTROL_NEEDS_CUSTOMER_PARAM');
    expect(c).toContain('MIN_ACTIVITY_REQUIRED');
  });

  it('rejects undeclared parameter references and bad combinations', () => {
    const t = structuredClone(CATALOG_TEMPLATES.find((x) => x.code === 'AVG_MONTHLY_BALANCE')!);
    (t.logic.reward as { awardAt?: string }).awardAt = 'GOAL_MET';
    (t.logic.goal as { tiers: { target: unknown }[] }).tiers[0].target = { $param: 'nope' };
    const c = codes(checkTemplate(parseTemplate(t).template!));
    expect(c).toContain('UNDECLARED_PARAM');
    expect(c).toContain('AVG_AWARD_AT');
  });

  it('stops the bank from setting a customer value, and checks bounds against the template', () => {
    const pack = samplePack();
    const r = pack.rules!.find((x) => x.code === 'DSL_MASS')!;
    r.params = { ...r.params, limit: 5000 };
    r.customerParams = { limit: { min: 50, max: 2_000_000 } };
    const v = validatePack(pack);
    expect(v.ok).toBe(false);
    expect(codes(v.issues)).toEqual(expect.arrayContaining(['CUSTOMER_PARAM_SET_BY_BANK', 'BOUNDS_OUTSIDE_TEMPLATE']));
  });

  it('warns when a customer limit has no maximum', () => {
    const pack = samplePack();
    const t = pack.templates!.find((x) => x.code === 'DAILY_SPEND_LIMIT')!;
    delete t.params![0].max;
    pack.rules!.find((x) => x.code === 'DSL_MASS')!.customerParams = { limit: { min: 500 } };
    expect(codes(validatePack(pack).issues)).toContain('UNBOUNDED_MAX');
  });

  it('fromPack throws with issues, or skips only the invalid rules when asked', () => {
    const pack = samplePack();
    pack.rules!.push({ kind: 'Rule', code: 'BROKEN_RULE', template: 'NO_SUCH_TEMPLATE', name: 'Broken' });
    expect(() => RulesEngine.fromPack(pack)).toThrow(RulePackError);
    const e = RulesEngine.fromPack(pack, { skipInvalidRules: true });
    expect(e.getRule('BROKEN_RULE')).toBeUndefined();
    expect(e.getRule('DSL_MASS')).toBeDefined();
  });

  it('rejects schema errors with readable paths', () => {
    const r = validatePack({ kind: 'RulePack', pack: 'x', version: '1', rules: [{ kind: 'Rule', code: 'bad code', template: 'X', name: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.issues[0].path).toMatch(/^rules\.0\./);
  });
});

describe('customer values (spend controls)', () => {
  const e = engine();
  it('enforces the bank bounds', () => {
    expect(e.validateSetting('DSL_MASS', { limit: 3000 })).toEqual([]);
    expect(codes(e.validateSetting('DSL_MASS', { limit: 100 }))).toContain('PARAM_MIN');
    expect(codes(e.validateSetting('DSL_MASS', { limit: 30000 }))).toContain('PARAM_MAX');
    expect(codes(e.validateSetting('DSL_MASS', { limit: 3050 }))).toContain('PARAM_STEP');
  });
  it('limits options and selections to what the bank allows', () => {
    expect(codes(e.validateSetting('CSL_MASS', { categories: ['TRAVEL'], limit: 5000 }))).toContain('PARAM_OPTION');
    expect(codes(e.validateSetting('CSL_MASS', { categories: ['FOOD_GROCERY', 'DINING', 'FUEL', 'SHOPPING'], limit: 5000 }))).toContain('PARAM_MAX_ITEMS');
  });
  it('refuses bank parameters and missions', () => {
    expect(codes(e.validateSetting('DSL_MASS', { limit: 3000, points: 999 }))).toContain('BANK_PARAM');
    expect(codes(e.validateSetting('UPI_STREAK_MASS', {}))).toContain('NOT_A_CONTROL');
  });
  it('describes rules in plain language', () => {
    expect(e.describe('DSL_MASS', { limit: 3000 })).toBe('Keep total daily spend on card pos, card online, upi within ₹3,000. Earn 10 points for each day you stay within it.');
    expect(e.describe('DSL_MASS')).toContain('your daily limit (₹500 – ₹25,000)');
  });
});

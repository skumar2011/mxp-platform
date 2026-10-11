import { describe, expect, it } from 'vitest';
import { evalNode, validateTree, countLeaves, collectFields, type ConditionNode, type Issue } from '../../src/index';

const leaf = (field: string, operator: string, value?: unknown) => ({ type: 'condition', field, operator, value }) as ConditionNode;
const group = (op: 'AND' | 'OR', children: ConditionNode[], negate = false) => ({ type: 'group', op, negate, children }) as ConditionNode;

describe('condition evaluation', () => {
  const facts = { 'txn.channel': 'UPI', 'txn.category': 'GROCERY', 'txn.amount': 15000, 'txn.dr_cr': 'D' };

  it('treats an empty group as always true', () => {
    expect(evalNode(group('AND', []), facts).pass).toBe(true);
  });

  it('AND requires every child, OR requires one', () => {
    expect(evalNode(group('AND', [leaf('txn.channel', 'EQ', 'UPI'), leaf('txn.dr_cr', 'EQ', 'C')]), facts).pass).toBe(false);
    expect(evalNode(group('OR', [leaf('txn.channel', 'EQ', 'ATM'), leaf('txn.dr_cr', 'EQ', 'D')]), facts).pass).toBe(true);
  });

  it('negation inverts a group, which is how exclusions are written', () => {
    const notRent = group('AND', [leaf('txn.category', 'IN', ['RENT'])], true);
    expect(evalNode(notRent, facts).pass).toBe(true);
    expect(evalNode(notRent, { ...facts, 'txn.category': 'RENT' }).pass).toBe(false);
  });

  it('nested groups evaluate recursively and keep a trace for every node', () => {
    const tree = group('AND', [leaf('txn.channel', 'EQ', 'UPI'), group('OR', [leaf('txn.category', 'EQ', 'FUEL'), leaf('txn.category', 'EQ', 'GROCERY')])]);
    const r = evalNode(tree, facts);
    expect(r.pass).toBe(true);
    expect(r.children).toHaveLength(2);
    expect(r.children![1].children!.map((c) => c.pass)).toEqual([false, true]);
    expect(r.children![0].text).toContain('txn.channel');
  });

  it('money thresholds are written in rupees and compared in minor units', () => {
    // txn.amount facts are minor units (paise); the rule says ₹10,000
    expect(evalNode(leaf('txn.amount', 'GTE', 10000), { 'txn.amount': 1_000_000 }).pass).toBe(true);
    expect(evalNode(leaf('txn.amount', 'GTE', 10000), { 'txn.amount': 999_999 }).pass).toBe(false);
    expect(evalNode(leaf('txn.amount', 'GT', 10000), { 'txn.amount': 1_000_000 }).pass).toBe(false);
    expect(evalNode(leaf('txn.amount', 'BETWEEN', [100, 200]), { 'txn.amount': 15_000 }).pass).toBe(true);
  });

  it('shows the actual value in rupees in the explanation', () => {
    const r = evalNode(leaf('txn.amount', 'GTE', 10000), { 'txn.amount': 999_999 });
    expect(r.actual).toBe(9999.99);
  });

  it('missing data fails positive checks and passes negative ones', () => {
    expect(evalNode(leaf('txn.category', 'EQ', 'GROCERY'), {}).pass).toBe(false);
    expect(evalNode(leaf('txn.category', 'NE', 'RENT'), {}).pass).toBe(true);
    expect(evalNode(leaf('txn.category', 'NOT_IN', ['RENT']), {}).pass).toBe(true);
    expect(evalNode(leaf('txn.category', 'IS_NULL'), {}).pass).toBe(true);
    expect(evalNode(leaf('txn.category', 'NOT_NULL'), {}).pass).toBe(false);
  });

  it('IN and NOT_IN work with lists', () => {
    expect(evalNode(leaf('txn.channel', 'IN', ['UPI', 'CARD_POS']), facts).pass).toBe(true);
    expect(evalNode(leaf('txn.channel', 'NOT_IN', ['UPI']), facts).pass).toBe(false);
  });

  it('segments (array facts) match IN and CONTAINS', () => {
    const f = { 'customer.segments': ['AFFLUENT', 'SALARIED'] };
    expect(evalNode(leaf('customer.segments', 'IN', ['SALARIED']), f).pass).toBe(true);
    expect(evalNode(leaf('customer.segments', 'CONTAINS', 'MASS'), f).pass).toBe(false);
  });

  it('counts leaves and lists fields', () => {
    const tree = group('AND', [leaf('txn.channel', 'EQ', 'UPI'), group('OR', [leaf('txn.category', 'EQ', 'FUEL'), leaf('txn.dr_cr', 'EQ', 'D')])]);
    expect(countLeaves(tree)).toBe(3);
    expect(collectFields(tree).sort()).toEqual(['txn.category', 'txn.channel', 'txn.dr_cr']);
  });
});

describe('condition validation', () => {
  const run = (node: ConditionNode, scopes = ['txn', 'account', 'customer']) => {
    const issues: Issue[] = [];
    validateTree(node, scopes, 'q', issues);
    return issues;
  };

  it('accepts a well-formed tree', () => {
    expect(run(group('AND', [leaf('txn.channel', 'EQ', 'UPI'), leaf('txn.amount', 'GTE', 100)])).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('rejects unknown fields, wrong operators and missing values with clear codes', () => {
    expect(run(leaf('txn.nope', 'EQ', 'x'))[0].code).toBe('UNKNOWN_FIELD');
    expect(run(leaf('txn.channel', 'GTE', 3))[0].code).toBe('OPERATOR_NOT_ALLOWED');
    expect(run(leaf('txn.channel', 'EQ'))[0].code).toBe('VALUE_REQUIRED');
    expect(run(leaf('txn.channel', 'IN', []))[0].code).toBe('VALUE_LIST_REQUIRED');
    expect(run(leaf('txn.amount', 'BETWEEN', [10, 1]))[0].code).toBe('BETWEEN_INVALID');
    expect(run(leaf('txn.amount', 'GTE', -5))[0].code).toBe('NEGATIVE_AMOUNT');
  });

  it('flags fields used outside their allowed scope', () => {
    expect(run(leaf('txn.channel', 'EQ', 'UPI'), ['customer'])[0].code).toBe('FIELD_OUT_OF_SCOPE');
  });

  it('warns (does not block) on values outside the reference list', () => {
    const issues = run(leaf('customer.status', 'EQ', 'SLEEPING'));
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'UNKNOWN_VALUE' });
  });

  it('caps nesting depth', () => {
    let n: ConditionNode = leaf('txn.channel', 'EQ', 'UPI');
    for (let i = 0; i < 8; i++) n = group('AND', [n]);
    expect(run(n).some((i) => i.code === 'TREE_TOO_DEEP')).toBe(true);
  });
});

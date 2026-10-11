import { z } from 'zod';
import { OPERATORS, OPERATOR_LABELS, OPERATORS_BY_TYPE, getField, type Operator } from './fields';
import { toMinor, fromMinor } from './util';

// ---------- Condition tree -------------------------------------------
export interface ConditionLeaf {
  type: 'condition';
  field: string;
  operator: Operator;
  value?: unknown;
}

export interface ConditionGroup {
  type: 'group';
  op: 'AND' | 'OR';
  negate?: boolean;
  children: ConditionNode[];
}

export type ConditionNode = ConditionLeaf | ConditionGroup;

const leafSchema = z.object({
  type: z.literal('condition'),
  field: z.string().min(1),
  operator: z.enum(OPERATORS),
  value: z.unknown().optional(),
});

export const groupSchema: z.ZodType<ConditionGroup, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    type: z.literal('group'),
    op: z.enum(['AND', 'OR']),
    negate: z.boolean().optional(),
    children: z.array(z.union([leafSchema, groupSchema])),
  }),
) as z.ZodType<ConditionGroup, z.ZodTypeDef, unknown>;

export const emptyGroup = (): ConditionGroup => ({ type: 'group', op: 'AND', children: [] });

// ---------- Evaluation -----------------------------------------------
export type Facts = Record<string, unknown>;

export interface NodeResult {
  kind: 'group' | 'condition';
  pass: boolean;
  text: string;
  /** Present for conditions. */
  field?: string;
  operator?: Operator;
  expected?: unknown;
  actual?: unknown;
  /** Present for groups. */
  op?: 'AND' | 'OR';
  negate?: boolean;
  children?: NodeResult[];
}

function isMoneyField(path: string): boolean {
  return getField(path)?.type === 'money';
}

function show(path: string, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  return isMoneyField(path) && typeof v === 'number' ? fromMinor(v) : v;
}

function toComparable(path: string, v: unknown): unknown {
  if (isMoneyField(path) && (typeof v === 'number' || typeof v === 'string')) return toMinor(v);
  return v;
}

function evalLeaf(leaf: ConditionLeaf, facts: Facts): NodeResult {
  const { field, operator } = leaf;
  const raw = facts[field];
  const missing = raw === undefined || raw === null || raw === '';
  const expectedRaw = leaf.value;
  let pass = false;

  const exp = Array.isArray(expectedRaw)
    ? expectedRaw.map((x) => toComparable(field, x))
    : toComparable(field, expectedRaw);

  switch (operator) {
    case 'IS_NULL':
      pass = missing;
      break;
    case 'NOT_NULL':
      pass = !missing;
      break;
    case 'NE':
      pass = missing ? true : raw !== exp;
      break;
    case 'NOT_IN':
      if (missing) pass = true;
      else if (Array.isArray(raw)) pass = !raw.some((r) => (exp as unknown[]).includes(r));
      else pass = !(exp as unknown[]).includes(raw);
      break;
    default:
      if (missing) {
        pass = false;
        break;
      }
      switch (operator) {
        case 'EQ':
          pass = raw === exp;
          break;
        case 'GT':
          pass = (raw as number) > (exp as number);
          break;
        case 'GTE':
          pass = (raw as number) >= (exp as number);
          break;
        case 'LT':
          pass = (raw as number) < (exp as number);
          break;
        case 'LTE':
          pass = (raw as number) <= (exp as number);
          break;
        case 'IN':
          pass = Array.isArray(raw) ? raw.some((r) => (exp as unknown[]).includes(r)) : (exp as unknown[]).includes(raw);
          break;
        case 'BETWEEN': {
          const [lo, hi] = exp as [number, number];
          pass = (raw as number) >= lo && (raw as number) <= hi;
          break;
        }
        case 'CONTAINS':
          pass = Array.isArray(raw) ? raw.includes(exp) : String(raw).includes(String(exp));
          break;
        case 'STARTS_WITH':
          pass = String(raw).startsWith(String(exp));
          break;
      }
  }

  const actualShown = show(field, raw);
  const expectedShown = Array.isArray(expectedRaw) ? expectedRaw : expectedRaw;
  const valueText =
    operator === 'IS_NULL' || operator === 'NOT_NULL'
      ? ''
      : ' ' + (Array.isArray(expectedShown) ? `[${expectedShown.join(', ')}]` : String(expectedShown));
  return {
    kind: 'condition',
    pass,
    field,
    operator,
    expected: expectedShown,
    actual: actualShown,
    text: `${field} ${OPERATOR_LABELS[operator]}${valueText} (actual: ${actualShown === null ? 'none' : JSON.stringify(actualShown)})`,
  };
}

/** Evaluates a condition tree and returns a full trace. Empty groups pass. */
export function evalNode(node: ConditionNode, facts: Facts): NodeResult {
  if (node.type === 'condition') return evalLeaf(node, facts);
  if (node.children.length === 0) {
    return { kind: 'group', pass: true, op: node.op, negate: !!node.negate, children: [], text: 'no conditions (always true)' };
  }
  const children = node.children.map((c) => evalNode(c, facts));
  let pass = node.op === 'AND' ? children.every((c) => c.pass) : children.some((c) => c.pass);
  if (node.negate) pass = !pass;
  return {
    kind: 'group',
    pass,
    op: node.op,
    negate: !!node.negate,
    children,
    text: `${node.negate ? 'NOT ' : ''}${node.op} of ${children.length} condition(s)`,
  };
}

export function walk(node: ConditionNode, fn: (n: ConditionNode, depth: number) => void, depth = 0) {
  fn(node, depth);
  if (node.type === 'group') for (const c of node.children) walk(c, fn, depth + 1);
}

export function collectFields(node: ConditionNode): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (n.type === 'condition') out.push(n.field);
  });
  return out;
}

export function countLeaves(node: ConditionNode): number {
  let n = 0;
  walk(node, (x) => {
    if (x.type === 'condition') n++;
  });
  return n;
}

// ---------- Static validation -----------------------------------------
export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export function validateTree(
  node: ConditionNode,
  allowedScopes: string[],
  path: string,
  issues: Issue[],
  depth = 0,
): void {
  if (depth > 6) {
    issues.push({ severity: 'error', code: 'TREE_TOO_DEEP', path, message: 'Condition groups are nested too deeply (max 6 levels).' });
    return;
  }
  if (node.type === 'group') {
    node.children.forEach((c, i) => validateTree(c, allowedScopes, `${path}.children[${i}]`, issues, depth + 1));
    return;
  }
  const f = getField(node.field);
  if (!f) {
    issues.push({ severity: 'error', code: 'UNKNOWN_FIELD', path, message: `Unknown field "${node.field}".` });
    return;
  }
  if (!allowedScopes.includes(f.scope)) {
    issues.push({
      severity: 'error',
      code: 'FIELD_OUT_OF_SCOPE',
      path,
      message: `Field "${node.field}" cannot be used here (allowed: ${allowedScopes.join(', ')}).`,
    });
  }
  if (!OPERATORS_BY_TYPE[f.type].includes(node.operator)) {
    issues.push({
      severity: 'error',
      code: 'OPERATOR_NOT_ALLOWED',
      path,
      message: `Operator ${node.operator} is not valid for ${f.type} field "${node.field}".`,
    });
    return;
  }
  const v = node.value;
  const needsValue = node.operator !== 'IS_NULL' && node.operator !== 'NOT_NULL';
  if (!needsValue) return;
  if (v === undefined || v === null || v === '') {
    issues.push({ severity: 'error', code: 'VALUE_REQUIRED', path, message: `Condition on "${node.field}" needs a value.` });
    return;
  }
  const numeric = f.type === 'number' || f.type === 'money';
  const check = (x: unknown) => (numeric ? typeof x === 'number' && Number.isFinite(x) : typeof x === 'string' || typeof x === 'number');
  if (node.operator === 'IN' || node.operator === 'NOT_IN') {
    if (!Array.isArray(v) || v.length === 0 || !v.every(check)) {
      issues.push({ severity: 'error', code: 'VALUE_LIST_REQUIRED', path, message: `${node.operator} on "${node.field}" needs a non-empty list.` });
    }
  } else if (node.operator === 'BETWEEN') {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number') || v[0] > v[1]) {
      issues.push({ severity: 'error', code: 'BETWEEN_INVALID', path, message: `BETWEEN on "${node.field}" needs [low, high] with low <= high.` });
    }
  } else if (f.type === 'boolean') {
    if (typeof v !== 'boolean') issues.push({ severity: 'error', code: 'VALUE_TYPE', path, message: `"${node.field}" needs true or false.` });
  } else if (!check(v)) {
    issues.push({ severity: 'error', code: 'VALUE_TYPE', path, message: `Value for "${node.field}" must be ${numeric ? 'a number' : 'text'}.` });
  }
  if (f.type === 'money' && typeof v === 'number' && v < 0) {
    issues.push({ severity: 'error', code: 'NEGATIVE_AMOUNT', path, message: `Amount for "${node.field}" cannot be negative.` });
  }
  if (f.values && !numeric) {
    const list = Array.isArray(v) ? v : [v];
    const bad = list.filter((x) => !f.values!.includes(String(x)));
    if (bad.length) {
      issues.push({ severity: 'warning', code: 'UNKNOWN_VALUE', path, message: `"${bad.join(', ')}" is not a known value for "${node.field}".` });
    }
  }
}

import type { Condition, FactDef, Operator } from './schema';
import { resolvePath, type FactFrame } from './facts';
import type { Issue } from './params';
import { timeInRange } from './time';

export interface CondTrace {
  pass: boolean;
  text: string;
  children?: CondTrace[];
}

const LABEL: Record<Operator, string> = {
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'in', not_in: 'not in', between: 'between',
  contains: 'contains', starts_with: 'starts with', exists: 'exists', not_exists: 'is missing', time_between: 'time between',
};

const isMissing = (v: unknown) => v === undefined || v === null || v === '';
const show = (v: unknown) => (Array.isArray(v) ? `[${v.join(', ')}]` : v === undefined ? '∅' : JSON.stringify(v));

function leaf(field: string, op: Operator, expected: unknown, frame: FactFrame): CondTrace {
  const actual = resolvePath(frame, field);
  const missing = isMissing(actual);
  const list = Array.isArray(expected) ? expected : [expected];
  let pass = false;
  switch (op) {
    case 'exists': pass = !missing; break;
    case 'not_exists': pass = missing; break;
    case 'ne': pass = missing ? true : actual !== expected; break;
    case 'not_in':
      pass = missing ? true : Array.isArray(actual) ? !actual.some((a) => list.includes(a)) : !list.includes(actual);
      break;
    default:
      if (missing) break;
      switch (op) {
        case 'eq': pass = actual === expected; break;
        case 'gt': pass = (actual as number) > (expected as number); break;
        case 'gte': pass = (actual as number) >= (expected as number); break;
        case 'lt': pass = (actual as number) < (expected as number); break;
        case 'lte': pass = (actual as number) <= (expected as number); break;
        case 'in': pass = Array.isArray(actual) ? actual.some((a) => list.includes(a)) : list.includes(actual); break;
        case 'between': pass = (actual as number) >= (list[0] as number) && (actual as number) <= (list[1] as number); break;
        case 'contains': pass = Array.isArray(actual) ? actual.includes(expected) : String(actual).includes(String(expected)); break;
        case 'starts_with': pass = String(actual).startsWith(String(expected)); break;
        case 'time_between': pass = timeInRange(String(actual), String(list[0]), String(list[1])); break;
      }
  }
  const valueText = op === 'exists' || op === 'not_exists' ? '' : ` ${show(expected)}`;
  return { pass, text: `${field} ${LABEL[op]}${valueText} (actual ${show(actual)})` };
}

/** Evaluates a condition with a full trace. A missing condition passes. */
export function evalCondition(c: Condition | undefined, frame: FactFrame): CondTrace {
  if (!c) return { pass: true, text: 'no conditions' };
  if ('all' in c) {
    const children = c.all.map((x) => evalCondition(x, frame));
    return { pass: children.every((x) => x.pass), text: children.length ? `ALL of ${children.length}` : 'no conditions', children };
  }
  if ('any' in c) {
    const children = c.any.map((x) => evalCondition(x, frame));
    return { pass: children.length === 0 || children.some((x) => x.pass), text: `ANY of ${children.length}`, children };
  }
  if ('not' in c) {
    const inner = evalCondition(c.not, frame);
    return { pass: !inner.pass, text: 'NOT', children: [inner] };
  }
  return leaf(c.field, c.op, c.value, frame);
}

/** Fast path without trace building. */
export function test(c: Condition | undefined, frame: FactFrame): boolean {
  return evalCondition(c, frame).pass;
}

export function walkLeaves(c: Condition | undefined, fn: (l: { field: string; op: Operator; value?: unknown }, path: string) => void, path = ''): void {
  if (!c) return;
  if ('all' in c) c.all.forEach((x, i) => walkLeaves(x, fn, `${path}.all[${i}]`));
  else if ('any' in c) c.any.forEach((x, i) => walkLeaves(x, fn, `${path}.any[${i}]`));
  else if ('not' in c) walkLeaves(c.not, fn, `${path}.not`);
  else fn(c, path);
}

const OPS_BY_TYPE: Record<string, Operator[]> = {
  string: ['eq', 'ne', 'in', 'not_in', 'starts_with', 'contains', 'exists', 'not_exists'],
  enum: ['eq', 'ne', 'in', 'not_in', 'exists', 'not_exists'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'not_exists'],
  money: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'not_exists'],
  boolean: ['eq', 'ne', 'exists', 'not_exists'],
  array: ['contains', 'in', 'not_in', 'exists', 'not_exists'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'not_exists'],
  time: ['time_between', 'eq', 'ne', 'gte', 'lt', 'exists'],
};
export const operatorsFor = (type: string): Operator[] => OPS_BY_TYPE[type] ?? OPS_BY_TYPE.string;

const ROOTS = new Set(['event', 'customer', 'account']);

/** Static checks on a (possibly parameterised) condition tree. Parameter references are checked elsewhere. */
export function checkCondition(c: Condition | undefined, facts: Map<string, FactDef>, path: string, issues: Issue[], depth = 0): void {
  if (!c) return;
  if (depth > 8) {
    issues.push({ severity: 'error', code: 'TREE_TOO_DEEP', path, message: 'Conditions are nested too deeply (max 8 levels).' });
    return;
  }
  if ('all' in c) return c.all.forEach((x, i) => checkCondition(x, facts, `${path}.all[${i}]`, issues, depth + 1));
  if ('any' in c) return c.any.forEach((x, i) => checkCondition(x, facts, `${path}.any[${i}]`, issues, depth + 1));
  if ('not' in c) return checkCondition(c.not, facts, `${path}.not`, issues, depth + 1);
  const root = c.field.split('.')[0];
  if (!ROOTS.has(root)) {
    issues.push({ severity: 'error', code: 'BAD_FIELD_ROOT', path, message: `Field "${c.field}" must start with event., customer. or account.` });
    return;
  }
  const f = facts.get(c.field);
  if (!f) {
    issues.push({ severity: 'warning', code: 'UNKNOWN_FIELD', path, message: `"${c.field}" is not in the fact model; it will be read from the event as-is.` });
  } else if (!operatorsFor(f.type).includes(c.op)) {
    issues.push({ severity: 'error', code: 'OPERATOR_NOT_ALLOWED', path, message: `Operator ${c.op} is not valid for ${f.type} field "${c.field}".` });
  }
  const isRef = c.value && typeof c.value === 'object' && !Array.isArray(c.value) && '$param' in (c.value as object);
  if (isRef) return;
  if (c.op === 'exists' || c.op === 'not_exists') return;
  if (c.value === undefined) issues.push({ severity: 'error', code: 'VALUE_REQUIRED', path, message: `Condition on "${c.field}" needs a value.` });
  if ((c.op === 'in' || c.op === 'not_in') && !Array.isArray(c.value)) issues.push({ severity: 'error', code: 'VALUE_LIST_REQUIRED', path, message: `${c.op} needs a list.` });
  if ((c.op === 'between' || c.op === 'time_between') && (!Array.isArray(c.value) || c.value.length !== 2))
    issues.push({ severity: 'error', code: 'RANGE_REQUIRED', path, message: `${c.op} needs [from, to].` });
}

import type { CustomerParamBounds, ParamDef, Rule, RuleTemplate } from './schema';

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

const isRef = (v: unknown): v is { $param: string } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $param?: unknown }).$param === 'string';

/** Replaces every { $param } in a structure with its value. Unknown references become undefined. */
export function substitute<T>(node: T, values: Record<string, unknown>): T {
  if (isRef(node)) return values[node.$param] as T;
  if (Array.isArray(node)) return node.map((n) => substitute(n, values)) as T;
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, values);
    return out as T;
  }
  return node;
}

export function collectRefs(node: unknown, out = new Set<string>()): Set<string> {
  if (isRef(node)) out.add(node.$param);
  else if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => collectRefs(n, out));
  return out;
}

/** Effective definition of a customer parameter: template definition narrowed by the bank's bounds. */
export function effectiveParam(def: ParamDef, bounds?: CustomerParamBounds): ParamDef & { maxItems?: number } {
  if (!bounds) return def;
  return {
    ...def,
    min: bounds.min ?? def.min,
    max: bounds.max ?? def.max,
    step: bounds.step ?? def.step,
    options: bounds.options ?? def.options,
    default: bounds.default ?? def.default,
    maxItems: bounds.maxItems,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Checks one value against a parameter definition. */
export function checkParamValue(def: ParamDef & { maxItems?: number }, value: unknown, path: string, references: Record<string, string[]> = {}): Issue[] {
  const issues: Issue[] = [];
  const err = (code: string, message: string) => issues.push({ severity: 'error', code, path, message });
  if (value === undefined || value === null || value === '') {
    if (def.required !== false) err('PARAM_REQUIRED', `${def.label} is required.`);
    return issues;
  }
  const options = def.options ?? (def.optionsFrom ? references[def.optionsFrom] : undefined);
  switch (def.type) {
    case 'number':
    case 'money':
    case 'integer':
    case 'percent': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        err('PARAM_TYPE', `${def.label} must be a number.`);
        break;
      }
      if (def.type === 'integer' && !Number.isInteger(value)) err('PARAM_TYPE', `${def.label} must be a whole number.`);
      if (def.type === 'percent' && (value < 0 || value > 100)) err('PARAM_RANGE', `${def.label} must be between 0 and 100.`);
      if (def.min !== undefined && value < def.min) err('PARAM_MIN', `${def.label} must be at least ${def.min}.`);
      if (def.max !== undefined && value > def.max) err('PARAM_MAX', `${def.label} must be at most ${def.max}.`);
      if (def.step && def.min !== undefined) {
        const k = (value - def.min) / def.step;
        if (Math.abs(k - Math.round(k)) > 1e-9) err('PARAM_STEP', `${def.label} must be in steps of ${def.step}.`);
      }
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') err('PARAM_TYPE', `${def.label} must be true or false.`);
      break;
    case 'time':
      if (typeof value !== 'string' || !TIME_RE.test(value)) err('PARAM_TYPE', `${def.label} must be a time HH:mm.`);
      break;
    case 'string':
      if (typeof value !== 'string') err('PARAM_TYPE', `${def.label} must be text.`);
      break;
    case 'enum':
      if (typeof value !== 'string') err('PARAM_TYPE', `${def.label} must be one value.`);
      else if (options && !options.includes(value)) err('PARAM_OPTION', `${def.label}: "${value}" is not allowed (allowed: ${options.join(', ')}).`);
      break;
    case 'enum[]':
    case 'string[]': {
      if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
        err('PARAM_TYPE', `${def.label} must be a list.`);
        break;
      }
      if (def.required !== false && value.length === 0) err('PARAM_REQUIRED', `${def.label} needs at least one value.`);
      if (def.maxItems && value.length > def.maxItems) err('PARAM_MAX_ITEMS', `${def.label} allows at most ${def.maxItems} values.`);
      if (def.type === 'enum[]' && options) {
        const bad = value.filter((x) => !options.includes(x));
        if (bad.length) err('PARAM_OPTION', `${def.label}: ${bad.join(', ')} not allowed (allowed: ${options.join(', ')}).`);
      }
      if (new Set(value).size !== value.length) err('PARAM_DUPLICATE', `${def.label} has duplicate values.`);
      break;
    }
  }
  return issues;
}

/** Validates bank configuration of a template: BANK values present and valid, CUSTOMER bounds sensible. */
export function checkRuleParams(rule: Rule, template: RuleTemplate, references: Record<string, string[]>): Issue[] {
  const issues: Issue[] = [];
  const defs = new Map(template.params.map((p) => [p.name, p]));
  for (const name of Object.keys(rule.params)) {
    const d = defs.get(name);
    if (!d) issues.push({ severity: 'error', code: 'UNKNOWN_PARAM', path: `params.${name}`, message: `Template ${template.code} has no parameter "${name}".` });
    else if (d.setBy === 'CUSTOMER')
      issues.push({ severity: 'error', code: 'CUSTOMER_PARAM_SET_BY_BANK', path: `params.${name}`, message: `"${d.label}" is set by the customer. Configure its bounds under customerParams instead of a value.` });
  }
  for (const d of template.params) {
    if (d.setBy !== 'BANK') continue;
    const v = rule.params[d.name] ?? d.default;
    issues.push(...checkParamValue(d, v, `params.${d.name}`, references));
  }
  for (const [name, b] of Object.entries(rule.customerParams)) {
    const d = defs.get(name);
    const path = `customerParams.${name}`;
    if (!d) {
      issues.push({ severity: 'error', code: 'UNKNOWN_PARAM', path, message: `Template ${template.code} has no parameter "${name}".` });
      continue;
    }
    if (d.setBy !== 'CUSTOMER') {
      issues.push({ severity: 'error', code: 'BANK_PARAM_BOUNDED', path, message: `"${d.label}" is set by the bank; give it a value under params.` });
      continue;
    }
    if (b.min !== undefined && b.max !== undefined && b.min > b.max) issues.push({ severity: 'error', code: 'BOUNDS_INVERTED', path, message: `${d.label}: min is greater than max.` });
    if (b.min !== undefined && d.min !== undefined && b.min < d.min) issues.push({ severity: 'error', code: 'BOUNDS_OUTSIDE_TEMPLATE', path, message: `${d.label}: min ${b.min} is below the template minimum ${d.min}.` });
    if (b.max !== undefined && d.max !== undefined && b.max > d.max) issues.push({ severity: 'error', code: 'BOUNDS_OUTSIDE_TEMPLATE', path, message: `${d.label}: max ${b.max} is above the template maximum ${d.max}.` });
    const all = d.options ?? (d.optionsFrom ? references[d.optionsFrom] : undefined);
    if (b.options && all) {
      const bad = b.options.filter((o) => !all.includes(o));
      if (bad.length) issues.push({ severity: 'error', code: 'BOUNDS_OPTION', path, message: `${d.label}: ${bad.join(', ')} is not a known option.` });
    }
    if (b.default !== undefined) issues.push(...checkParamValue(effectiveParam(d, b), b.default, `${path}.default`, references));
  }
  return issues;
}

/** Validates the values a customer chose for a spend control. */
export function checkCustomerValues(rule: Rule, template: RuleTemplate, values: Record<string, unknown>, references: Record<string, string[]>): Issue[] {
  const issues: Issue[] = [];
  const defs = new Map(template.params.map((p) => [p.name, p]));
  for (const k of Object.keys(values)) {
    const d = defs.get(k);
    if (!d) issues.push({ severity: 'error', code: 'UNKNOWN_PARAM', path: k, message: `Unknown setting "${k}".` });
    else if (d.setBy !== 'CUSTOMER') issues.push({ severity: 'error', code: 'BANK_PARAM', path: k, message: `"${d.label}" is set by the bank and cannot be changed by the customer.` });
  }
  for (const d of template.params) {
    if (d.setBy !== 'CUSTOMER') continue;
    const eff = effectiveParam(d, rule.customerParams[d.name]);
    issues.push(...checkParamValue(eff, values[d.name] ?? eff.default, d.name, references));
  }
  return issues;
}

/** Final parameter values for evaluation: template defaults, then bank values, then customer values. */
export function resolveValues(rule: Rule, template: RuleTemplate, customerValues: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of template.params) {
    if (d.setBy === 'BANK') out[d.name] = rule.params[d.name] ?? d.default;
    else out[d.name] = customerValues[d.name] ?? rule.customerParams[d.name]?.default ?? d.default;
  }
  return out;
}

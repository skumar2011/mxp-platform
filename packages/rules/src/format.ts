import type { ParamDef, Rule, RuleTemplate } from './schema';
import { effectiveParam, resolveValues } from './params';

const nf = new Map<string, Intl.NumberFormat>();
export function money(v: number, currency = 'INR'): string {
  let f = nf.get(currency);
  if (!f) {
    f = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 0 });
    nf.set(currency, f);
  }
  return f.format(v);
}

export const num = (v: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v);

export const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export function formatParam(def: Pick<ParamDef, 'type' | 'unit'>, v: unknown, currency = 'INR'): string {
  if (v === undefined || v === null || v === '') return '—';
  switch (def.type) {
    case 'money': return typeof v === 'number' ? money(v, currency) : String(v);
    case 'percent': return `${v}%`;
    case 'number': case 'integer': return typeof v === 'number' ? `${num(v)}${def.unit ? ` ${def.unit}` : ''}` : String(v);
    case 'boolean': return v ? 'yes' : 'no';
    case 'enum': return humanize(String(v));
    case 'enum[]': case 'string[]': return Array.isArray(v) ? v.map((x) => (def.type === 'enum[]' ? humanize(String(x)) : String(x))).join(', ') : String(v);
    default: return String(v);
  }
}

/** Plain-language summary: template.summary with {param} tokens filled in. Unset customer values show their allowed range. */
export function describeRule(rule: Rule, template: RuleTemplate, customerValues?: Record<string, unknown>, currency = 'INR'): string {
  const values = resolveValues(rule, template, customerValues ?? {});
  const text = template.summary ?? template.description ?? template.name;
  return text.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const def = template.params.find((p) => p.name === name);
    if (!def) return `{${name}}`;
    if (def.setBy === 'CUSTOMER' && (!customerValues || customerValues[name] === undefined)) {
      const eff = effectiveParam(def, rule.customerParams[name]);
      if (eff.min !== undefined || eff.max !== undefined) return `your ${def.label.toLowerCase()} (${formatParam(def, eff.min, currency)} – ${formatParam(def, eff.max, currency)})`;
      return `your ${def.label.toLowerCase()}`;
    }
    return formatParam(def, values[name], currency);
  });
}

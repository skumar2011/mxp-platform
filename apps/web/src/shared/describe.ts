import { inr, num } from './format';

const PERIOD: Record<string, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'calendar month', QUARTERLY: 'quarter', CAMPAIGN: 'campaign period' };

const val = (v: any) => (Array.isArray(v) ? v.join(' – ') : String(v));
const OPW: Record<string, string> = { EQ: 'is', NE: 'is not', GT: '>', GTE: '≥', LT: '<', LTE: '≤', IN: 'is one of', NOT_IN: 'is not one of', BETWEEN: 'is between', CONTAINS: 'includes', STARTS_WITH: 'starts with', IS_NULL: 'is empty', NOT_NULL: 'is present' };

export function describeNode(n: any): string {
  if (!n) return '';
  if (n.type === 'condition') return `${n.field} ${OPW[n.operator] ?? n.operator}${['IS_NULL', 'NOT_NULL'].includes(n.operator) ? '' : ` ${val(n.value)}`}`;
  const parts = (n.children ?? []).map(describeNode).filter(Boolean);
  if (!parts.length) return '';
  const body = parts.length === 1 ? parts[0] : `(${parts.join(n.op === 'OR' ? ' OR ' : ' AND ')})`;
  return n.negate ? `NOT ${body}` : body;
}

/** One-paragraph plain-English summary of a rule definition, shown to makers and approvers. */
export function describeRule(d: any): string[] {
  if (!d) return [];
  const out: string[] = [];
  const per = PERIOD[d.period?.type] ?? '';
  const money = ['SUM', 'AVG_BALANCE', 'MIN_BALANCE', 'BALANCE_GROWTH'].includes(d.metric?.type);
  const fmt = (t: number) => (money ? inr(t) : num(t));
  const cmp = d.metric?.operator === 'GT' ? 'more than' : 'at least';
  if (d.kind === 'GOAL') {
    const what: Record<string, string> = { COUNT: 'number of qualifying transactions', SUM: 'total amount of qualifying transactions', AVG_BALANCE: 'average daily balance', MIN_BALANCE: 'minimum balance', BALANCE_GROWTH: 'growth in balance' };
    out.push(`Goal: the ${what[d.metric?.type] ?? 'metric'} in each ${per} (${d.period?.timezone}).`);
    (d.tiers ?? []).forEach((t: any, i: number) => out.push(`Reach ${cmp} ${fmt(t.threshold)} → ${num(t.points)} XP${t.label ? ` (${t.label})` : ''}${d.tierMode === 'HIGHEST_ONLY' ? '' : i > 0 ? ' in addition' : ''}.`));
    if (d.tierMode === 'HIGHEST_ONLY') out.push('Only the highest tier reached is paid.');
  } else if (d.kind === 'PER_EVENT') {
    const p = d.perEvent;
    if (p) out.push(p.mode === 'FIXED' ? `Earn ${num(p.points)} XP for every qualifying transaction.` : `Earn ${num(p.points)} XP for every ${inr(p.perAmount)} of qualifying spend.`);
  } else if (d.kind === 'COMBINED') {
    out.push(`Combined goal: meet ${(d.combined?.components ?? []).map((c: any) => c.ruleCode).join(' + ') || 'the component goals'} in the same ${per}.`);
    (d.tiers ?? []).forEach((t: any) => out.push(`${num(t.threshold)} component goal(s) met → ${num(t.points)} XP${t.label ? ` (${t.label})` : ''}.`));
  }
  const q = describeNode(d.qualifying);
  if (q && d.kind !== 'COMBINED') out.push(`Counts: ${q}.`);
  const e = describeNode(d.eligibility);
  if (e) out.push(`Customer must satisfy: ${e}.`);
  const l = d.limits ?? {};
  const lim: string[] = [];
  if (l.frequency === 'ONCE') lim.push('only once per customer');
  if (l.maxOccurrences) lim.push(`at most ${l.maxOccurrences} times`);
  if (l.capPointsPerPeriod) lim.push(`max ${num(l.capPointsPerPeriod)} XP per period`);
  if (l.capPointsLifetime) lim.push(`max ${num(l.capPointsLifetime)} XP lifetime`);
  if (lim.length) out.push(`Limits: ${lim.join(', ')}.`);
  out.push(`If a transaction is reversed or refunded: ${d.handling?.reversal === 'GRANDFATHER' ? 'points already earned are kept' : 'points are clawed back'}.`);
  if (d.effective?.from || d.effective?.to) out.push(`Effective ${d.effective.from ?? 'immediately'} to ${d.effective.to ?? 'until retired'}.`);
  return out;
}

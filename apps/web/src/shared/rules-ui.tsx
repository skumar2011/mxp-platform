import { useState, type ReactNode } from 'react';
import type { Condition, CondTrace, CustomerParamBounds, Evaluation, FactDef, Issue, ParamDef } from '@mxp/rules';
import { Badge, StatusBadge } from './ui';
import { familyLabel, inr, num, pretty, pts } from './format';
import { useAsync } from './hooks';
import { api } from './api';

// ---------------------------------------------------------------------------
// Metadata (cached for the session)
// ---------------------------------------------------------------------------
export interface Meta {
  references: Record<string, string[]>;
  facts: FactDef[];
  eventTypes: string[];
  operators: string[];
  operatorsByType: Record<string, string[]>;
  segments: { segment_code: string; name: string; description: string }[];
  merchants: { merchant_id: string; name: string; category_code: string }[];
}
let metaPromise: Promise<Meta> | null = null;
export const loadMeta = () => (metaPromise ??= api<Meta>('/meta').catch((e) => { metaPromise = null; throw e; }));
export const useMeta = () => useAsync(loadMeta, []);

export const FamilyBadge = ({ family }: { family: string }) => <Badge tone={family === 'MISSION' ? 'violet' : 'blue'}>{familyLabel(family)}</Badge>;

// ---------------------------------------------------------------------------
// Parameter inputs, generated from the template's parameter definitions
// ---------------------------------------------------------------------------
export const optionsOf = (p: ParamDef, refs: Record<string, string[]>) => p.options ?? (p.optionsFrom ? refs[p.optionsFrom] : undefined) ?? refs[p.name];

export function formatValue(p: Pick<ParamDef, 'type' | 'unit'>, v: unknown): string {
  if (v === undefined || v === null || v === '') return '-';
  if (Array.isArray(v)) return v.map((x) => pretty(String(x))).join(', ');
  if (p.type === 'money' && typeof v === 'number') return inr(v);
  if (p.type === 'percent') return `${v}%`;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return `${num(v)}${p.unit ? ` ${p.unit}` : ''}`;
  return p.type === 'enum' ? pretty(String(v)) : String(v);
}

export function ParamInput({ def, value, onChange, refs, labels, disabled }: {
  def: ParamDef & { maxItems?: number }; value: unknown; onChange: (v: unknown) => void; refs: Record<string, string[]>; labels?: Record<string, string>; disabled?: boolean;
}) {
  const opts = optionsOf(def, refs);
  const label = (o: string) => labels?.[o] ?? pretty(o);
  switch (def.type) {
    case 'number': case 'money': case 'integer': case 'percent':
      return (
        <input className="input" type="number" disabled={disabled} value={value === undefined || value === null ? '' : String(value)} min={def.min} max={def.max} step={def.step ?? (def.type === 'integer' ? 1 : 'any')}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      );
    case 'boolean':
      return <label className="check"><input type="checkbox" disabled={disabled} checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {def.label}</label>;
    case 'time':
      return <input className="input" type="time" disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'enum':
      return (
        <select className="input" disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">Select…</option>
          {(opts ?? []).map((o) => <option key={o} value={o}>{label(o)}</option>)}
        </select>
      );
    case 'enum[]': case 'string[]': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      const toggle = (o: string) => onChange(arr.includes(o) ? arr.filter((x) => x !== o) : [...arr, o]);
      const extra = arr.filter((x) => !(opts ?? []).includes(x));
      return (
        <div className="chips">
          {[...(opts ?? []), ...extra].map((o) => (
            <button key={o} type="button" disabled={disabled || (!arr.includes(o) && !!def.maxItems && arr.length >= def.maxItems)} className={`chip ${arr.includes(o) ? 'on' : ''}`} onClick={() => toggle(o)}>{label(o)}</button>
          ))}
          {def.type === 'string[]' && !disabled && <AddChip onAdd={(v) => !arr.includes(v) && onChange([...arr, v])} />}
          {def.maxItems ? <small className="muted">max {def.maxItems}</small> : null}
        </div>
      );
    }
    default:
      return <input className="input" disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || undefined)} />;
  }
}

function AddChip({ onAdd }: { onAdd: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <span className="row gap">
      <input className="input input-sm" style={{ width: 130 }} placeholder="Add value" value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) { e.preventDefault(); onAdd(v.trim()); setV(''); } }} />
    </span>
  );
}

const hintFor = (p: ParamDef & { maxItems?: number }) => {
  const parts: string[] = [];
  if (p.min !== undefined || p.max !== undefined) parts.push(`${p.min !== undefined ? formatValue(p, p.min) : '…'} – ${p.max !== undefined ? formatValue(p, p.max) : '…'}`);
  if (p.step) parts.push(`step ${formatValue(p, p.step)}`);
  if (p.description) parts.push(p.description);
  return parts.join(' · ') || undefined;
};

export function ParamForm({ defs, values, onChange, refs, labels, issues, prefix = 'params' }: {
  defs: (ParamDef & { maxItems?: number })[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; refs: Record<string, string[]>; labels?: Record<string, string>; issues?: Issue[]; prefix?: string;
}) {
  if (!defs.length) return <p className="muted">No parameters.</p>;
  return (
    <div className="form-grid">
      {defs.map((d) => {
        const err = issues?.find((i) => i.path === (prefix ? `${prefix}.${d.name}` : d.name) && i.severity === 'error')?.message;
        return (
          <div key={d.name} className={`field ${d.type.endsWith('[]') ? 'field-wide' : ''}`}>
            <label>{d.label}{d.unit ? <span className="muted"> ({d.unit})</span> : null}</label>
            <ParamInput def={d} value={values[d.name]} refs={refs} labels={labels} onChange={(v) => onChange({ ...values, [d.name]: v })} />
            {err ? <small className="err">{err}</small> : hintFor(d) && <small className="muted">{hintFor(d)}</small>}
          </div>
        );
      })}
    </div>
  );
}

/** Bank-side limits on a CUSTOMER parameter: range/step for numbers, allowed options for lists. */
export function BoundsEditor({ def, value, onChange, refs, labels }: { def: ParamDef; value: CustomerParamBounds; onChange: (b: CustomerParamBounds) => void; refs: Record<string, string[]>; labels?: Record<string, string> }) {
  const numeric = ['number', 'money', 'integer', 'percent'].includes(def.type);
  const list = def.type.endsWith('[]') || def.type === 'enum';
  const set = (k: keyof CustomerParamBounds, v: unknown) => {
    const next = { ...value, [k]: v } as Record<string, unknown>;
    if (v === undefined || (Array.isArray(v) && !v.length)) delete next[k];
    onChange(next as CustomerParamBounds);
  };
  const n = (k: 'min' | 'max' | 'step') => (
    <input className="input" type="number" placeholder={def[k] !== undefined ? `template ${def[k]}` : ''} value={value[k] ?? ''} onChange={(e) => set(k, e.target.value === '' ? undefined : Number(e.target.value))} />
  );
  const opts = optionsOf(def, refs) ?? [];
  return (
    <div className="bounds">
      <div className="row gap between"><strong>{def.label}</strong><Badge tone="blue">customer sets</Badge></div>
      {numeric && (
        <div className="form-grid">
          <div className="field"><label>Minimum</label>{n('min')}</div>
          <div className="field"><label>Maximum</label>{n('max')}</div>
          <div className="field"><label>Step</label>{n('step')}</div>
          <div className="field"><label>Suggested default</label><ParamInput def={{ ...def, min: value.min ?? def.min, max: value.max ?? def.max }} value={value.default} refs={refs} onChange={(v) => set('default', v)} /></div>
        </div>
      )}
      {list && (
        <div className="stack" style={{ marginTop: 8 }}>
          <div className="field"><label>Options offered to the customer <span className="muted">(none selected = all)</span></label>
            {def.type === 'string[]' && !opts.length
              ? <ParamInput def={{ ...def, required: false }} value={value.options ?? []} refs={refs} labels={labels} onChange={(v) => set('options', v)} />
              : <ParamInput def={{ ...def, type: 'enum[]', options: opts, required: false }} value={value.options ?? []} refs={refs} labels={labels} onChange={(v) => set('options', v)} />}
          </div>
          {def.type !== 'enum' && (
            <div className="form-grid">
              <div className="field"><label>Max selections</label><input className="input" type="number" min={1} value={value.maxItems ?? ''} onChange={(e) => set('maxItems', e.target.value === '' ? undefined : Number(e.target.value))} /></div>
            </div>
          )}
          <div className="field"><label>Suggested default</label>
            <ParamInput def={{ ...def, options: value.options?.length ? value.options : opts, required: false }} value={value.default} refs={refs} labels={labels} onChange={(v) => set('default', v)} />
          </div>
        </div>
      )}
      {def.type === 'time' && (
        <div className="form-grid"><div className="field"><label>Suggested default</label><ParamInput def={def} value={value.default} refs={refs} onChange={(v) => set('default', v)} /></div></div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conditions (eligibility) builder
// ---------------------------------------------------------------------------
type Leaf = { field: string; op: string; value?: unknown };
const isGroup = (c: Condition): c is { all: Condition[] } | { any: Condition[] } => 'all' in c || 'any' in c;

export function ConditionEditor({ value, onChange, facts, refs, operatorsByType, fieldFilter }: {
  value: Condition | undefined; onChange: (c: Condition | undefined) => void; facts: FactDef[]; refs: Record<string, string[]>; operatorsByType: Record<string, string[]>; fieldFilter?: (f: FactDef) => boolean;
}) {
  const root: Condition = value ?? { all: [] };
  const group = isGroup(root) ? root : { all: [root] };
  const fs = fieldFilter ? facts.filter(fieldFilter) : facts;
  return <GroupEditor node={group} onChange={(g) => onChange(isEmpty(g) ? undefined : g)} facts={fs} refs={refs} opsBy={operatorsByType} depth={0} />;
}
const isEmpty = (g: Condition) => isGroup(g) && ('all' in g ? g.all : g.any).length === 0;

function GroupEditor({ node, onChange, facts, refs, opsBy, depth, onRemove }: { node: { all: Condition[] } | { any: Condition[] }; onChange: (c: Condition) => void; facts: FactDef[]; refs: Record<string, string[]>; opsBy: Record<string, string[]>; depth: number; onRemove?: () => void }) {
  const mode = 'all' in node ? 'all' : 'any';
  const items = 'all' in node ? node.all : node.any;
  const set = (xs: Condition[]) => onChange(mode === 'all' ? { all: xs } : { any: xs });
  return (
    <div className="cond-group">
      <div className="row gap wrap">
        <div className="pill">
          <button type="button" className={mode === 'all' ? 'on' : ''} onClick={() => onChange({ all: items })}>ALL</button>
          <button type="button" className={mode === 'any' ? 'on' : ''} onClick={() => onChange({ any: items })}>ANY</button>
        </div>
        <span className="muted">of these must be true</span>
        <span className="grow" />
        <button type="button" className="btn btn-sm" onClick={() => set([...items, { field: facts[0]?.path ?? 'customer.segment', op: 'eq', value: '' }])}>+ Condition</button>
        {depth < 2 && <button type="button" className="btn btn-sm" onClick={() => set([...items, { all: [] }])}>+ Group</button>}
        {onRemove && <button type="button" className="btn btn-sm btn-ghost" onClick={onRemove}>Remove group</button>}
      </div>
      {items.length === 0 && <div className="muted" style={{ marginTop: 6 }}>No conditions: always true.</div>}
      {items.map((c, i) => {
        const upd = (x: Condition) => set(items.map((y, j) => (j === i ? x : y)));
        const del = () => set(items.filter((_, j) => j !== i));
        if (isGroup(c)) return <GroupEditor key={i} node={c} onChange={upd} facts={facts} refs={refs} opsBy={opsBy} depth={depth + 1} onRemove={del} />;
        if ('not' in c) return <div key={i} className="muted">NOT (edit in JSON)</div>;
        return <LeafEditor key={i} leaf={c as Leaf} onChange={upd} onRemove={del} facts={facts} refs={refs} opsBy={opsBy} />;
      })}
    </div>
  );
}

function LeafEditor({ leaf, onChange, onRemove, facts, refs, opsBy }: { leaf: Leaf; onChange: (c: Condition) => void; onRemove: () => void; facts: FactDef[]; refs: Record<string, string[]>; opsBy: Record<string, string[]> }) {
  const fact = facts.find((f) => f.path === leaf.field);
  const type = fact?.type ?? 'string';
  const ops = opsBy[type] ?? opsBy.string ?? [];
  const values = fact?.values ?? (fact?.valuesFrom ? refs[fact.valuesFrom] : undefined);
  const multi = leaf.op === 'in' || leaf.op === 'not_in';
  const noValue = leaf.op === 'exists' || leaf.op === 'not_exists';
  const set = (p: Partial<Leaf>) => onChange({ ...leaf, ...p } as Condition);
  let input: ReactNode = null;
  if (noValue) input = <span className="muted">no value</span>;
  else if (type === 'boolean') input = <select className="input" value={String(leaf.value)} onChange={(e) => set({ value: e.target.value === 'true' })}><option value="true">true</option><option value="false">false</option></select>;
  else if (multi && values) input = <ParamInput def={{ name: 'v', label: 'values', type: 'enum[]', setBy: 'BANK', required: true, options: values }} value={Array.isArray(leaf.value) ? leaf.value : []} refs={refs} onChange={(v) => set({ value: v })} />;
  else if (values) input = <select className="input" value={String(leaf.value ?? '')} onChange={(e) => set({ value: e.target.value })}><option value="">Select…</option>{values.map((v) => <option key={v} value={v}>{pretty(v)}</option>)}</select>;
  else if (type === 'number' || type === 'money') input = <input className="input" type="number" value={leaf.value === undefined ? '' : String(leaf.value)} onChange={(e) => set({ value: e.target.value === '' ? undefined : Number(e.target.value) })} />;
  else input = <input className="input" value={Array.isArray(leaf.value) ? leaf.value.join(',') : String(leaf.value ?? '')} onChange={(e) => set({ value: multi ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value })} placeholder={multi ? 'comma separated' : ''} />;
  return (
    <div className="cond-row">
      <select className="input" value={leaf.field} onChange={(e) => set({ field: e.target.value, value: undefined })}>
        {!fact && <option value={leaf.field}>{leaf.field}</option>}
        {facts.map((f) => <option key={f.path} value={f.path}>{f.label} ({f.path})</option>)}
      </select>
      <select className="input" value={leaf.op} onChange={(e) => set({ op: e.target.value, value: ['in', 'not_in'].includes(e.target.value) ? [] : undefined })}>
        {ops.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
      </select>
      {input}
      <button type="button" className="btn btn-sm btn-ghost" onClick={onRemove} aria-label="Remove condition">✕</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
export function TraceView({ trace }: { trace?: CondTrace | null }) {
  if (!trace) return null;
  return (
    <div className="trace">
      <span className={trace.pass ? 'trace-ok' : 'trace-no'}>{trace.pass ? '✓' : '✗'}</span> {trace.text}
      {trace.children?.length ? <div style={{ paddingLeft: 16 }}>{trace.children.map((c, i) => <TraceView key={i} trace={c} />)}</div> : null}
    </div>
  );
}

export function IssueList({ issues, max = 20 }: { issues: (Issue & { doc?: string })[]; max?: number }) {
  if (!issues.length) return <div className="alert alert-ok">No issues found.</div>;
  const errors = issues.filter((i) => i.severity === 'error');
  return (
    <div className={`alert ${errors.length ? 'alert-err' : 'alert-warn'}`}>
      <strong>{errors.length} error(s), {issues.length - errors.length} warning(s)</strong>
      <ul>{issues.slice(0, max).map((i, k) => <li key={k}><Badge tone={i.severity === 'error' ? 'red' : 'amber'}>{i.code}</Badge> {i.doc ? <code>{i.doc}</code> : null} {i.path ? <code>{i.path}</code> : null} {i.message}</li>)}</ul>
    </div>
  );
}

/** Evaluation rows from the engine (in-browser) or the database. */
export function EvaluationList({ items, showCustomer }: { items: (Partial<Evaluation> & { rule_code?: string; outcome: string; message: string })[]; showCustomer?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!items.length) return <div className="muted">No rules applied.</div>;
  return (
    <div className="evals">
      {items.map((e, i) => {
        const code = e.ruleCode ?? e.rule_code;
        const p = e.points ?? 0;
        return (
          <div key={i} className="eval">
            <div className="row gap wrap">
              <StatusBadge status={e.outcome} />
              {e.decision && e.decision !== 'ALLOW' && <StatusBadge status={e.decision} />}
              <strong>{code}</strong>
              {showCustomer && e.customerId && <span className="muted">{e.customerId}</span>}
              {e.windowKey && <span className="muted">{e.windowKey}</span>}
              <span className="grow" />
              {p !== 0 && <Badge tone={p > 0 ? 'green' : 'red'}>{pts(p)} pts</Badge>}
              {e.trace && <button className="btn btn-sm btn-ghost" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Hide trace' : 'Trace'}</button>}
            </div>
            <div className="muted" style={{ marginTop: 2 }}>{e.message}</div>
            {open === i && e.trace && (
              <div className="trace-box">
                {e.trace.eligibility && <><small className="muted">Eligibility</small><TraceView trace={e.trace.eligibility} /></>}
                {e.trace.scope && <><small className="muted">Scope</small><TraceView trace={e.trace.scope} /></>}
                {e.trace.filter && <><small className="muted">Filter</small><TraceView trace={e.trace.filter} /></>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Progress({ value, target, op }: { value: number; target: number | null | undefined; op?: string }) {
  if (!target) return null;
  const pct = Math.max(0, Math.min(100, (value / target) * 100));
  const limit = op === 'lte' || op === 'lt';
  return <div className="meter" title={`${num(value)} / ${num(target)}`}><i style={{ width: `${pct}%`, background: limit ? (pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)') : undefined }} /></div>;
}

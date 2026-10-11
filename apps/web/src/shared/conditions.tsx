import { useState } from 'react';
import type { Meta } from './meta';
import { valuesFor } from './meta';
import { Button } from './ui';

export interface Leaf { type: 'condition'; field: string; operator: string; value?: unknown }
export interface Group { type: 'group'; op: 'AND' | 'OR'; negate?: boolean; children: (Leaf | Group)[] }
export const emptyGroup = (): Group => ({ type: 'group', op: 'AND', negate: false, children: [] });
const newLeaf = (meta: Meta): Leaf => ({ type: 'condition', field: meta.fields[0].path, operator: 'EQ', value: '' });

function ValueInput({ meta, leaf, onChange }: { meta: Meta; leaf: Leaf; onChange: (v: unknown) => void }) {
  const f = meta.fields.find((x) => x.path === leaf.field);
  const type = f?.type ?? 'string';
  const opts = valuesFor(meta, leaf.field);
  const op = leaf.operator;
  if (op === 'IS_NULL' || op === 'NOT_NULL') return <span className="muted">no value needed</span>;
  if (op === 'BETWEEN') {
    const [a, b] = Array.isArray(leaf.value) ? (leaf.value as number[]) : ['', ''];
    return (
      <div className="row gap">
        <input className="input input-sm" type="number" value={a as any} placeholder="from" onChange={(e) => onChange([e.target.value === '' ? '' : Number(e.target.value), b])} aria-label="From" />
        <span>and</span>
        <input className="input input-sm" type="number" value={b as any} placeholder="to" onChange={(e) => onChange([a, e.target.value === '' ? '' : Number(e.target.value)])} aria-label="To" />
      </div>
    );
  }
  if (op === 'IN' || op === 'NOT_IN') {
    const cur = Array.isArray(leaf.value) ? (leaf.value as string[]) : [];
    if (opts) {
      return (
        <div className="row wrap" style={{ gap: '4px 10px' }}>
          {opts.map((o) => (
            <label key={o.code} className="check" title={o.name}>
              <input type="checkbox" checked={cur.includes(o.code)} onChange={(e) => onChange(e.target.checked ? [...cur, o.code] : cur.filter((x) => x !== o.code))} />
              <span>{o.code}</span>
            </label>
          ))}
        </div>
      );
    }
    return <input className="input input-sm" value={cur.join(', ')} placeholder="comma separated" onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
  }
  if (type === 'number' || type === 'money') {
    return <input className="input input-sm" type="number" step="any" value={(leaf.value as any) ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Value" />;
  }
  if (opts && (op === 'EQ' || op === 'NE' || op === 'CONTAINS')) {
    return (
      <select className="input input-sm" value={String(leaf.value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label="Value">
        <option value="">Select...</option>
        {opts.map((o) => <option key={o.code} value={o.code}>{o.code}{o.name ? ` - ${o.name}` : ''}</option>)}
      </select>
    );
  }
  return <input className="input input-sm" value={String(leaf.value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label="Value" />;
}

function LeafEditor({ meta, leaf, onChange, onRemove }: { meta: Meta; leaf: Leaf; onChange: (l: Leaf) => void; onRemove: () => void }) {
  const known = meta.fields.some((f) => f.path === leaf.field);
  const f = meta.fields.find((x) => x.path === leaf.field);
  const ops = meta.operatorsByType[f?.type ?? 'string'] ?? meta.operatorsByType.string;
  const groups = ['txn', 'account', 'customer'] as const;
  const setField = (path: string) => {
    const nf = meta.fields.find((x) => x.path === path);
    const nops = meta.operatorsByType[nf?.type ?? 'string'];
    onChange({ type: 'condition', field: path, operator: nops.includes(leaf.operator) ? leaf.operator : nops[0], value: '' });
  };
  return (
    <div className="cond-row">
      <div>
        <select className="input input-sm" value={known ? leaf.field : '__custom'} onChange={(e) => setField(e.target.value === '__custom' ? 'txn.attr.' : e.target.value)} aria-label="Field">
          {groups.map((g) => (
            <optgroup key={g} label={g === 'txn' ? 'Transaction' : g === 'account' ? 'Account' : 'Customer'}>
              {meta.fields.filter((x) => x.scope === g).map((x) => <option key={x.path} value={x.path}>{x.label}</option>)}
            </optgroup>
          ))}
          <option value="__custom">Custom attribute (txn.attr.…)</option>
        </select>
        {!known && <input className="input input-sm" style={{ marginTop: 4 }} value={leaf.field} onChange={(e) => onChange({ ...leaf, field: e.target.value })} placeholder="txn.attr.your_key" aria-label="Attribute path" />}
      </div>
      <select className="input input-sm" value={leaf.operator} onChange={(e) => onChange({ ...leaf, operator: e.target.value, value: e.target.value === 'IN' || e.target.value === 'NOT_IN' ? [] : e.target.value === 'BETWEEN' ? ['', ''] : '' })} aria-label="Operator">
        {ops.map((o) => <option key={o} value={o}>{meta.operators.find((x) => x.code === o)?.label ?? o}</option>)}
      </select>
      <ValueInput meta={meta} leaf={leaf} onChange={(value) => onChange({ ...leaf, value })} />
      <Button small variant="ghost" onClick={onRemove} aria-label="Remove condition">✕</Button>
    </div>
  );
}

/** Nested AND/OR/NOT condition builder. Edits a plain JSON tree (same shape the engine stores). */
export function GroupEditor({ meta, value, onChange, onRemove, depth = 0 }: { meta: Meta; value: Group; onChange: (g: Group) => void; onRemove?: () => void; depth?: number }) {
  const [, force] = useState(0);
  const set = (children: Group['children']) => onChange({ ...value, children });
  void force;
  return (
    <div className="cond-group">
      <div className="row gap wrap between">
        <div className="row gap wrap">
          <span className="muted">{value.negate ? 'NOT, when' : 'When'}</span>
          <div className="pill" role="group" aria-label="Match mode">
            <button type="button" className={value.op === 'AND' ? 'on' : ''} onClick={() => onChange({ ...value, op: 'AND' })}>ALL of</button>
            <button type="button" className={value.op === 'OR' ? 'on' : ''} onClick={() => onChange({ ...value, op: 'OR' })}>ANY of</button>
          </div>
          <label className="check"><input type="checkbox" checked={!!value.negate} onChange={(e) => onChange({ ...value, negate: e.target.checked })} /> negate (NOT)</label>
        </div>
        {onRemove && <Button small variant="ghost" onClick={onRemove}>Remove group</Button>}
      </div>
      {value.children.length === 0 && <div className="muted" style={{ margin: '8px 0' }}>{depth === 0 ? 'No conditions: everything matches.' : 'Empty group.'}</div>}
      {value.children.map((c, i) =>
        c.type === 'group' ? (
          <div key={i} style={{ marginTop: 8 }}><GroupEditor meta={meta} value={c} depth={depth + 1} onChange={(g) => set(value.children.map((x, j) => (j === i ? g : x)))} onRemove={() => set(value.children.filter((_, j) => j !== i))} /></div>
        ) : (
          <LeafEditor key={i} meta={meta} leaf={c} onChange={(l) => set(value.children.map((x, j) => (j === i ? l : x)))} onRemove={() => set(value.children.filter((_, j) => j !== i))} />
        ),
      )}
      <div className="row gap" style={{ marginTop: 10 }}>
        <Button small onClick={() => set([...value.children, newLeaf(meta)])}>+ Condition</Button>
        {depth < 3 && <Button small onClick={() => set([...value.children, { ...emptyGroup(), op: 'OR' }])}>+ Group</Button>}
      </div>
    </div>
  );
}

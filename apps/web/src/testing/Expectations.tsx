import { Button } from '../shared/ui';

export type ExpRow = { id: number; kind: string; key?: string; step?: number; value: string };

export const EXP_KINDS: { id: string; label: string; needsKey?: 'rule' | 'none'; needsStep?: boolean; boolean?: boolean }[] = [
  { id: 'totalPoints', label: 'Total XP earned' },
  { id: 'pointsByRule', label: 'XP earned by rule', needsKey: 'rule' },
  { id: 'achievedTier', label: 'Highest tier credited', needsKey: 'rule' },
  { id: 'metric', label: 'Final metric value (₹ or count)', needsKey: 'rule' },
  { id: 'progressStatus', label: 'Final progress status', needsKey: 'rule' },
  { id: 'awards', label: 'Number of awards' },
  { id: 'reversals', label: 'Number of reversals' },
  { id: 'noDuplicateAwards', label: 'No duplicate awards', boolean: true },
  { id: 'rejectedEvents', label: 'Rejected events' },
  { id: 'duplicateEvents', label: 'Duplicate events detected' },
  { id: 'nudges', label: 'Nudges of a type (e.g. TIER_ACHIEVED)' },
  { id: 'outcome', label: 'Outcome of a rule at a step', needsKey: 'rule', needsStep: true },
];

let seq = 1;
export const newRow = (): ExpRow => ({ id: seq++, kind: 'totalPoints', value: '' });

export function toExpected(rows: ExpRow[]): any | undefined {
  const e: any = {};
  for (const r of rows) {
    if (r.value === '' && r.kind !== 'noDuplicateAwards') continue;
    const n = Number(r.value);
    switch (r.kind) {
      case 'totalPoints': case 'awards': case 'reversals': case 'rejectedEvents': case 'duplicateEvents': e[r.kind] = n; break;
      case 'noDuplicateAwards': e.noDuplicateAwards = r.value !== 'false'; break;
      case 'pointsByRule': case 'achievedTier': case 'metric': if (r.key) (e[r.kind] ??= {})[r.key] = n; break;
      case 'progressStatus': if (r.key) (e.progressStatus ??= {})[r.key] = r.value; break;
      case 'nudges': if (r.key) (e.nudges ??= {})[r.key] = n; break;
      case 'outcome': if (r.key) (e.outcomes ??= []).push({ step: r.step ?? 0, ruleCode: r.key, outcome: r.value }); break;
    }
  }
  return Object.keys(e).length ? e : undefined;
}

export function fromExpected(e: any): ExpRow[] {
  const rows: ExpRow[] = [];
  if (!e) return rows;
  for (const k of ['totalPoints', 'awards', 'reversals', 'rejectedEvents', 'duplicateEvents']) if (e[k] !== undefined) rows.push({ id: seq++, kind: k, value: String(e[k]) });
  if (e.noDuplicateAwards !== undefined) rows.push({ id: seq++, kind: 'noDuplicateAwards', value: String(e.noDuplicateAwards) });
  for (const k of ['pointsByRule', 'achievedTier', 'metric', 'progressStatus', 'nudges']) for (const [key, v] of Object.entries(e[k] ?? {})) rows.push({ id: seq++, kind: k, key, value: String(v) });
  for (const o of e.outcomes ?? []) rows.push({ id: seq++, kind: 'outcome', key: o.ruleCode, step: o.step, value: o.outcome });
  return rows;
}

const OUTCOMES = ['AWARDED', 'REVERSED', 'ACHIEVED', 'IN_PROGRESS', 'NOT_QUALIFYING', 'INELIGIBLE', 'NO_CHANGE', 'CAPPED', 'SUPPRESSED', 'DATA_UNAVAILABLE', 'PERIOD_CLOSED'];
const PROGRESS = ['IN_PROGRESS', 'ACHIEVED', 'CLOSED_ACHIEVED', 'CLOSED_NOT_ACHIEVED', 'DATA_UNAVAILABLE'];
const NUDGES = ['PROGRESS', 'NEAR_TARGET', 'TIER_ACHIEVED', 'REWARD_REVERSED'];

export function Expectations({ rows, onChange, ruleCodes }: { rows: ExpRow[]; onChange: (r: ExpRow[]) => void; ruleCodes: string[] }) {
  const upd = (id: number, patch: Partial<ExpRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.length === 0 && <p className="muted" style={{ marginTop: 0 }}>No expectations: the run just shows what happened. Add some to make this a pass/fail test.</p>}
      {rows.map((r) => {
        const kind = EXP_KINDS.find((k) => k.id === r.kind)!;
        return (
          <div key={r.id} className="row gap wrap" style={{ marginBottom: 8 }}>
            <select className="input input-sm" style={{ width: 250 }} value={r.kind} onChange={(e) => upd(r.id, { kind: e.target.value, key: undefined, value: '' })} aria-label="Expectation">{EXP_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
            {kind.needsKey === 'rule' && <select className="input input-sm" style={{ width: 200 }} value={r.key ?? ''} onChange={(e) => upd(r.id, { key: e.target.value })} aria-label="Rule"><option value="">Rule...</option>{ruleCodes.map((c) => <option key={c}>{c}</option>)}</select>}
            {r.kind === 'nudges' && <select className="input input-sm" style={{ width: 170 }} value={r.key ?? ''} onChange={(e) => upd(r.id, { key: e.target.value })} aria-label="Nudge type"><option value="">Type...</option>{NUDGES.map((c) => <option key={c}>{c}</option>)}</select>}
            {kind.needsStep && <input className="input input-sm" style={{ width: 90 }} type="number" min={0} value={r.step ?? 0} onChange={(e) => upd(r.id, { step: Number(e.target.value) })} aria-label="Step index" title="Step index (starts at 0)" />}
            <span className="muted">=</span>
            {r.kind === 'noDuplicateAwards' ? <select className="input input-sm" style={{ width: 100 }} value={r.value || 'true'} onChange={(e) => upd(r.id, { value: e.target.value })}><option>true</option><option>false</option></select>
              : r.kind === 'progressStatus' ? <select className="input input-sm" style={{ width: 200 }} value={r.value} onChange={(e) => upd(r.id, { value: e.target.value })}><option value="">Status...</option>{PROGRESS.map((c) => <option key={c}>{c}</option>)}</select>
              : r.kind === 'outcome' ? <select className="input input-sm" style={{ width: 200 }} value={r.value} onChange={(e) => upd(r.id, { value: e.target.value })}><option value="">Outcome...</option>{OUTCOMES.map((c) => <option key={c}>{c}</option>)}</select>
              : <input className="input input-sm" style={{ width: 120 }} type="number" value={r.value} onChange={(e) => upd(r.id, { value: e.target.value })} aria-label="Expected value" />}
            <Button small variant="ghost" onClick={() => onChange(rows.filter((x) => x.id !== r.id))} aria-label="Remove">✕</Button>
          </div>
        );
      })}
      <Button small onClick={() => onChange([...rows, newRow()])}>+ Add expectation</Button>
    </div>
  );
}

import { Badge, Json } from './ui';
import { inr, num } from './format';

interface Node { kind: 'group' | 'condition'; pass: boolean; text: string; children?: Node[]; op?: string; negate?: boolean; expected?: unknown; actual?: unknown }

function NodeView({ n, depth = 0 }: { n: Node; depth?: number }) {
  return (
    <div style={{ marginLeft: depth ? 16 : 0 }}>
      <div className="row gap" style={{ alignItems: 'flex-start' }}>
        <span className={n.pass ? 'trace-ok' : 'trace-no'} aria-label={n.pass ? 'passed' : 'failed'}>{n.pass ? '✔' : '✘'}</span>
        <span>{n.text}</span>
      </div>
      {n.children?.map((c, i) => <NodeView key={i} n={c} depth={depth + 1} />)}
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ marginBottom: 12 }}><div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>{title}</div>{children}</div>
);

/** Renders the per-condition pass/fail trace stored with every evaluation. */
export function TraceView({ trace }: { trace: any }) {
  if (!trace || !Object.keys(trace).length) return <div className="muted">No trace was stored for this evaluation.</div>;
  return (
    <div>
      {trace.txn && <Section title="Transaction"><span>{trace.txn.sourceTxnId} · {inr(trace.txn.amount, 2)} · {trace.txn.status} · {trace.txn.date}</span></Section>}
      {trace.period && <Section title="Period"><code>{trace.period}</code></Section>}
      {trace.eligibility && <Section title="Customer eligibility"><NodeView n={trace.eligibility.tree ?? trace.eligibility} /></Section>}
      {trace.qualifying && <Section title="Qualifying conditions"><NodeView n={trace.qualifying.tree ?? trace.qualifying} /></Section>}
      {trace.contribution && (
        <Section title="Contribution to goal">
          Counted {trace.contribution.count} txn, {inr(trace.contribution.amount, 2)}
          {trace.contribution.changes?.map((c: any, i: number) => <div key={i} className="muted">period {c.period}: amount {c.amountDelta >= 0 ? '+' : ''}{c.amountDelta}, count {c.countDelta >= 0 ? '+' : ''}{c.countDelta}</div>)}
        </Section>
      )}
      {trace.balance && <Section title="Balance computation"><Json value={trace.balance} max={160} /></Section>}
      {trace.components && (
        <Section title="Component goals">
          {trace.components.map((c: any, i: number) => <div key={i}>{c.met ? '✔' : '✘'} {c.rule}: reached tier {c.achievedTier} (needs tier {c.minTier})</div>)}
        </Section>
      )}
      {trace.slots?.length > 0 && (
        <Section title="Reward decision">
          <div className="table-wrap"><table className="table"><thead><tr><th>Slot</th><th>Target</th><th>Already in ledger</th><th>Change</th><th>Action</th><th>Note</th></tr></thead>
            <tbody>{trace.slots.map((s: any, i: number) => (
              <tr key={i}><td><code>{s.slot}</code></td><td>{num(s.targetPoints)}</td><td>{num(s.ledgerNet)}</td><td>{num(s.granted ?? s.delta)}</td><td><Badge tone={s.action === 'AWARD' ? 'green' : s.action === 'REVERSE' ? 'red' : 'gray'}>{s.action}</Badge></td><td>{s.note ?? ''}</td></tr>
            ))}</tbody></table></div>
        </Section>
      )}
    </div>
  );
}

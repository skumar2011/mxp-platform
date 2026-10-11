import { Link } from 'react-router-dom';
import { api } from '../../shared/api';
import { dt, num } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Bars, Button, Card, DataTable, ErrorBox, Loading, Stat, StatusBadge } from '../../shared/ui';

export function Dashboard() {
  const q = useAsync(() => api<any>('/dashboard'), []);
  const d = q.data;
  if (q.loading && !d) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} retry={q.reload} />;
  if (!d) return null;
  const count = (rows: any[], s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const live = count(d.rulesByStatus, 'ACTIVE');
  const stuck = count(d.events, 'DEAD_LETTER') + count(d.events, 'SUSPENDED');
  return (
    <>
      <PageHead title="Dashboard" sub={`As of ${dt(d.generatedAt)}`} actions={<Button onClick={q.reload}>Refresh</Button>} />
      {d.pendingApprovals > 0 && <Alert tone="warn"><strong>{d.pendingApprovals}</strong> rule version(s) waiting for approval. <Link to="/rules?status=PENDING_APPROVAL">Review</Link></Alert>}
      {d.pendingAdjustments > 0 && <Alert tone="warn"><strong>{d.pendingAdjustments}</strong> manual adjustment(s) waiting for approval. <Link to="/ledger?tab=adjustments">Review</Link></Alert>}
      {stuck > 0 && <Alert tone="err"><strong>{stuck}</strong> event(s) are suspended or dead-lettered. <Link to="/ingestion?status=DEAD_LETTER">Investigate</Link></Alert>}
      {d.lastRecon?.status === 'FAILED' && <Alert tone="err">The last reconciliation run found {d.lastRecon.breaks} break(s). <Link to="/reconciliation">View</Link></Alert>}

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="Live rules" value={live} sub={`${d.rulesByStatus.reduce((a: number, r: any) => a + r.n, 0)} versions in total`} />
        <Stat label="XP issued (net)" value={num(d.xp.net)} sub={`${num(d.xp.awarded)} awarded · ${num(d.xp.reversed)} reversed`} tone="green" />
        <Stat label="Customers rewarded" value={num(d.xp.customers)} sub={`of ${num(d.transactions.customers)} customers`} />
        <Stat label="Transactions" value={num(d.transactions.total)} sub={d.transactions.awaitingEvaluation ? `${d.transactions.awaitingEvaluation} awaiting evaluation` : 'all evaluated'} tone={d.transactions.awaitingEvaluation ? 'amber' : undefined} />
      </div>

      <div className="grid g-main" style={{ marginBottom: 16 }}>
        <Card title="Points awarded and reversed per day">
          <Bars data={d.daily.map((x: any) => ({ label: x.day, a: x.awarded, b: x.reversed }))} />
          <div className="row gap muted" style={{ marginTop: 8, fontSize: 12 }}><span style={{ color: 'var(--brand)' }}>■</span> awarded <span style={{ color: '#f0a39b' }}>■</span> reversed</div>
        </Card>
        <Card title="Evaluation outcomes (7 days)">
          {d.outcomes.length === 0 ? <div className="muted">No evaluations yet.</div> : d.outcomes.map((o: any) => (
            <div key={o.outcome} className="row between" style={{ padding: '4px 0' }}><StatusBadge status={o.outcome} /><strong>{num(o.n)}</strong></div>
          ))}
        </Card>
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <Card title="Top rules by XP" pad={false}>
          <DataTable rows={d.topRules} empty="No rewards yet." cols={[
            { key: 'r', header: 'Rule', render: (r: any) => <Link to={`/rules/${r.ruleCode}`}>{r.ruleCode}</Link> },
            { key: 'c', header: 'Customers', align: 'right', render: (r: any) => num(r.customers) },
            { key: 'p', header: 'XP', align: 'right', render: (r: any) => <strong>{num(r.points)}</strong> },
          ]} />
        </Card>
        <Card title="Campaign budgets" pad={false}>
          <DataTable rows={d.campaigns} empty="No active campaigns." cols={[
            { key: 'n', header: 'Campaign', render: (c: any) => <><strong>{c.name}</strong><br /><small className="muted">{c.code} · ends {c.endDate}</small></> },
            { key: 's', header: 'Status', render: (c: any) => <StatusBadge status={c.status} /> },
            { key: 'b', header: 'Spent / budget', align: 'right', render: (c: any) => (
              <div style={{ minWidth: 120 }}>{num(c.spent)} / {c.budget ? num(c.budget) : 'no cap'}
                {c.budget ? <div className="meter"><i style={{ width: `${Math.min(100, (c.spent / c.budget) * 100)}%` }} /></div> : null}</div>) },
          ]} />
        </Card>
      </div>

      <div className="grid g3">
        <Card title="Ingestion (last 24h)">{d.events24.length === 0 ? <span className="muted">No events.</span> : d.events24.map((e: any) => <div key={e.status} className="row between" style={{ padding: '3px 0' }}><StatusBadge status={e.status} /><strong>{num(e.n)}</strong></div>)}</Card>
        <Card title="Nudges">{d.nudges.length === 0 ? <span className="muted">No nudges yet.</span> : d.nudges.map((e: any) => <div key={e.status} className="row between" style={{ padding: '3px 0' }}><StatusBadge status={e.status} /><strong>{num(e.n)}</strong></div>)}</Card>
        <Card title="Reconciliation">
          {d.lastRecon ? <><StatusBadge status={d.lastRecon.status} /><div className="muted" style={{ marginTop: 6 }}>{dt(d.lastRecon.started_at)} · {d.lastRecon.checked} checked · {d.lastRecon.breaks} break(s)</div></> : <span className="muted">Never run.</span>}
          <div style={{ marginTop: 8 }}><Link to="/reconciliation">Open reconciliation</Link></div>
        </Card>
      </div>
      <p className="muted" style={{ marginTop: 16 }}>MXP records outcomes only. It never posts to, or changes, the core banking transactions. Monetary values are in INR; XP is a separate loyalty currency.</p>
    </>
  );
}

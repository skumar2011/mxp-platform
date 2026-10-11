import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, inr, num, pretty, pts } from '../../shared/format';
import { useAsync, useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Badge, Button, Card, DataTable, ErrorBox, Field, KeyVal, Loading, StatusBadge, useToast } from '../../shared/ui';

export function Customers() {
  const { ref } = useParams();
  return ref ? <Customer360 customerRef={ref} /> : <Search />;
}

function Search() {
  const nav = useNavigate();
  const [text, setText] = useState('');
  const q = useDebounced(text);
  const data = useAsync(() => api<{ rows: any[] }>('/customers', { query: { q, limit: 50 } }), [q]);
  return (
    <>
      <PageHead title="Customers" sub="Look up a customer's progress, rewards, nudges and recent transactions. Names are masked; only tokens are stored." />
      <Card>
        <Field label="Search by customer reference"><input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="CUST-1001" autoFocus /></Field>
        <div style={{ height: 12 }} />
        {data.loading && !data.data ? <Loading /> : data.error ? <ErrorBox error={data.error} /> : (
          <DataTable rows={data.data!.rows} onRow={(r) => nav(`/customers/${r.customerRef}`)} empty="No customers found." cols={[
            { key: 'c', header: 'Customer', render: (r: any) => <strong>{r.customerRef}</strong> }, { key: 'n', header: 'Name (masked)', render: (r: any) => r.name }, { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 't', header: 'Transactions', align: 'right', render: (r: any) => num(r.txns) }, { key: 'x', header: 'XP balance', align: 'right', render: (r: any) => <strong>{num(r.xpBalance)}</strong> },
            { key: 'u', header: 'Nudges', render: (r: any) => (r.nudgeConsent ? 'Consented' : <Badge tone="amber">No consent</Badge>) },
          ]} />
        )}
      </Card>
    </>
  );
}

function Customer360({ customerRef }: { customerRef: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const q = useAsync(() => api<any>(`/customers/${customerRef}`), [customerRef]);
  const rules = useAsync(() => (can('simulate') ? api<{ rules: any[] }>('/sim/rules') : Promise.resolve({ rules: [] })), []);
  const [ruleCode, setRuleCode] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const run = async () => {
    setBusy(true);
    try { setPreview(await api('/sim/preview', { body: { rule: { ruleCode }, customerRef } })); } catch (e) { toast.err(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHead title={<>{d.customer.customerRef} <StatusBadge status={d.customer.status} /></>} sub={<><Link to="/customers">All customers</Link> · {d.customer.name} · {pretty(d.customer.type)} · KYC {d.customer.kyc}</>} />
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Card><KeyVal items={[['XP balance', <strong key="b" style={{ fontSize: 22 }}>{num(d.xp.balance)}</strong>]]} /></Card>
        <Card><KeyVal items={[['Lifetime earned / reversed', `${num(d.xp.earned)} / ${num(d.xp.reversed)}`]]} /></Card>
        <Card><KeyVal items={[['Segments', d.segments.join(', ') || '-']]} /></Card>
        <Card><KeyVal items={[['Nudge consent', d.customer.nudgeConsent ? 'Yes' : <Badge tone="amber" key="n">No: nudges are suppressed</Badge>]]} /></Card>
      </div>
      <Card title="Goal progress" pad={false}>
        <DataTable rows={d.progress} empty="No goal progress yet." cols={[
          { key: 'r', header: 'Rule', render: (p: any) => <Link to={`/rules/${p.ruleCode}`}>{p.name}</Link> }, { key: 'p', header: 'Period', render: (p: any) => <code>{p.period}</code> },
          { key: 's', header: 'Status', render: (p: any) => <><StatusBadge status={p.status} />{p.note && <><br /><small className="muted">{p.note}</small></>}</> },
          { key: 'm', header: 'Progress', align: 'right', render: (p: any) => (p.metricType === 'COUNT' ? num(p.metric) : inr(p.metric)) }, { key: 't', header: 'Tier', align: 'right', render: (p: any) => p.achievedTier },
          { key: 'x', header: 'XP', align: 'right', render: (p: any) => <strong>{num(p.points)}</strong> },
        ]} />
      </Card>
      {can('simulate') && (
        <div style={{ marginTop: 16 }}><Card title="Preview a rule for this customer" actions={<span className="muted">Replays real history in a sandbox. Nothing is written.</span>}>
          <div className="row gap wrap">
            <select className="input" style={{ maxWidth: 360 }} value={ruleCode} onChange={(e) => setRuleCode(e.target.value)} aria-label="Rule"><option value="">Choose a rule...</option>{rules.data?.rules.map((r) => <option key={r.ruleCode} value={r.ruleCode}>{r.ruleCode} - {r.name}</option>)}</select>
            <Button variant="primary" disabled={!ruleCode} busy={busy} onClick={run}>Preview</Button>
          </div>
          {preview && (preview.ok ? (
            <div style={{ marginTop: 12 }}>
              <p><strong>{num(preview.final.totalPoints)} XP</strong> would be earned across {preview.final.awards} award(s){preview.final.reversals ? `, ${preview.final.reversals} reversal(s)` : ''}.</p>
              <DataTable rows={preview.final.progress} empty="No progress." cols={[
                { key: 'p', header: 'Period', render: (p: any) => p.periodKey }, { key: 's', header: 'Status', render: (p: any) => <StatusBadge status={p.status} /> }, { key: 'm', header: 'Metric', align: 'right', render: (p: any) => num(p.metric) }, { key: 't', header: 'Tier', align: 'right', render: (p: any) => p.achievedTier },
              ]} />
            </div>) : <ErrorBox error={new Error(preview.error?.message ?? 'Preview failed')} />)}
        </Card></div>
      )}
      <div className="grid g2" style={{ marginTop: 16 }}>
        <Card title="XP ledger" pad={false}><DataTable rows={d.ledger} empty="No entries." cols={[
          { key: 't', header: 'When', render: (l: any) => dt(l.createdAt) }, { key: 'e', header: 'Type', render: (l: any) => <StatusBadge status={l.entryType} /> }, { key: 'r', header: 'Rule', render: (l: any) => l.ruleCode ?? '-' }, { key: 'p', header: 'XP', align: 'right', render: (l: any) => <strong>{pts(l.points)}</strong> },
        ]} /></Card>
        <Card title="Nudges" pad={false}><DataTable rows={d.nudges} empty="No nudges." cols={[
          { key: 't', header: 'When', render: (n: any) => dt(n.createdAt) }, { key: 'y', header: 'Type', render: (n: any) => pretty(n.type) }, { key: 's', header: 'Status', render: (n: any) => <StatusBadge status={n.status} /> }, { key: 'm', header: 'Message', render: (n: any) => <small>{n.message}{n.suppressReason ? ` (${n.suppressReason})` : ''}</small> },
        ]} /></Card>
      </div>
      <div className="grid g2" style={{ marginTop: 16 }}>
        <Card title="Accounts" pad={false}><DataTable rows={d.accounts} cols={[
          { key: 'a', header: 'Account', render: (a: any) => a.accountRef }, { key: 'p', header: 'Product', render: (a: any) => a.product }, { key: 's', header: 'Status', render: (a: any) => a.status },
          { key: 'b', header: 'Latest balance', align: 'right', render: (a: any) => (a.latestBalance === null ? '-' : <>{inr(a.latestBalance)}<br /><small className="muted">{a.balanceDate}</small></>) },
        ]} /></Card>
        <Card title="Recent transactions" pad={false}><DataTable rows={d.transactions} empty="None." cols={[
          { key: 't', header: 'When', render: (t: any) => dt(t.at) }, { key: 'y', header: 'Type', render: (t: any) => <>{pretty(t.type)}{t.isReversal ? <Badge tone="red"> reversal</Badge> : null}</> }, { key: 'c', header: 'Channel', render: (t: any) => t.channel },
          { key: 'a', header: 'Amount', align: 'right', render: (t: any) => inr(t.amount, 2) }, { key: 's', header: 'Status', render: (t: any) => <small>{t.status}</small> },
        ]} /></Card>
      </div>
    </>
  );
}

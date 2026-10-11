import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, num, pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Badge, Button, Card, DataTable, ErrorBox, Filters, Field, Loading, StatusBadge } from '../../shared/ui';

export function RulesList() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState('');
  const status = sp.get('status') ?? '';
  const data = useAsync(() => api<{ rules: any[] }>('/rules'), []);
  const rows = (data.data?.rules ?? []).filter((r) =>
    (!status || r.status === status) && (!q || `${r.ruleCode} ${r.name} ${r.category}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <PageHead title="Rules" sub="Goals, per-event rewards and combined goals. Every change is versioned and needs a second person's approval."
        actions={can('rules:write') && <Button variant="primary" onClick={() => nav('/rules/new')}>+ New rule</Button>} />
      <Card pad={false}>
        <div style={{ padding: '14px 16px 0' }}>
          <Filters>
            <Field label="Search"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code, name or category" /></Field>
            <Field label="Status">
              <select className="input" value={status} onChange={(e) => setSp(e.target.value ? { status: e.target.value } : {})}>
                <option value="">All</option>
                {['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'PAUSED', 'REJECTED', 'RETIRED', 'SUPERSEDED'].map((s) => <option key={s} value={s}>{pretty(s)}</option>)}
              </select>
            </Field>
          </Filters>
        </div>
        {data.loading && !data.data ? <Loading /> : data.error ? <ErrorBox error={data.error} retry={data.reload} /> : (
          <DataTable rows={rows} onRow={(r) => nav(`/rules/${r.ruleCode}`)} empty="No rules match." cols={[
            { key: 'n', header: 'Rule', render: (r) => <><strong>{r.name}</strong><br /><small className="muted mono">{r.ruleCode}</small></> },
            { key: 'k', header: 'Type', render: (r) => <><Badge tone="violet">{pretty(r.kind)}</Badge> <small className="muted">{pretty(r.category)}</small></> },
            { key: 's', header: 'Status', render: (r) => <><StatusBadge status={r.status} /> <small className="muted">v{r.versionNo}</small>{r.latestVersionNo !== r.versionNo && <small className="muted"> (latest v{r.latestVersionNo})</small>}</> },
            { key: 'c', header: 'Campaign', className: 'hide-sm', render: (r) => r.campaignCode ?? <span className="muted">-</span> },
            { key: 'p', header: 'XP issued', align: 'right', render: (r) => <>{num(r.pointsIssued)}<br /><small className="muted">{num(r.customersRewarded)} customers</small></> },
            { key: 'u', header: 'Updated', className: 'hide-sm', render: (r) => dt(r.activatedAt ?? r.approvedAt ?? r.submittedAt ?? r.createdAt) },
          ]} />
        )}
      </Card>
      <p className="muted" style={{ marginTop: 10 }}>Need to try a rule first? Use the <Link to="/rules/new">builder</Link>, then run scenarios in the <a href="/testing/">Testing app</a> before submitting.</p>
    </>
  );
}

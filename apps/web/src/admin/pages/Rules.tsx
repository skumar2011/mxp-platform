import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { day } from '../../shared/format';
import { useAsync, useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge } from '../../shared/rules-ui';
import { Badge, Button, Card, DataTable, ErrorBox, Field, Filters, Loading, StatusBadge } from '../../shared/ui';

export function Rules() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const family = sp.get('family') ?? '';
  const status = sp.get('status') ?? '';
  const q = useDebounced(sp.get('q') ?? '');
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const { data, error, reload } = useAsync(() => api<any[]>('/rules', { query: { family, status, q } }), [family, status, q]);
  return (
    <div>
      <PageHead title="Bank rules" sub="Configured instances of catalogue templates: values, customer limits, segments and eligibility. Every change is versioned and approved."
        actions={can('rules:write') && <Button variant="primary" onClick={() => nav('/rules/new')}>New rule</Button>} />
      <Filters>
        <Field label="Family"><select className="input" value={family} onChange={(e) => set('family', e.target.value)}><option value="">All</option><option value="SPEND_CONTROL">Spend controls</option><option value="MISSION">Missions</option></select></Field>
        <Field label="Status"><select className="input" value={status} onChange={(e) => set('status', e.target.value)}><option value="">All</option>{['ACTIVE', 'PAUSED', 'DRAFT', 'RETIRED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}</select></Field>
        <Field label="Search"><input className="input" value={sp.get('q') ?? ''} onChange={(e) => set('q', e.target.value)} placeholder="Code or name" /></Field>
      </Filters>
      {error && <ErrorBox error={error} retry={reload} />}
      {!data ? <Loading /> : (
        <Card pad={false}>
          <DataTable rows={data} onRow={(r) => nav(`/rules/${r.code}`)} rowKey={(r) => r.code} cols={[
            { key: 'n', header: 'Rule', render: (r) => <><strong>{r.name}</strong> {r.featured && <Badge tone="amber">featured</Badge>}<br /><code>{r.code}</code></> },
            { key: 'f', header: 'Family', render: (r) => <FamilyBadge family={r.family} /> },
            { key: 't', header: 'Template', render: (r) => <code>{r.template}</code> },
            { key: 's', header: 'Segments', render: (r) => (r.segments.length ? r.segments.join(', ') : <span className="muted">All</span>) },
            { key: 'live', header: 'Live', render: (r) => (r.liveVersion ? <><StatusBadge status={r.liveStatus} /> v{r.liveVersion}</> : <span className="muted">-</span>) },
            { key: 'latest', header: 'Latest', render: (r) => (r.latestVersion !== r.liveVersion ? <><StatusBadge status={r.latestStatus} /> v{r.latestVersion}</> : <span className="muted">same</span>) },
            { key: 'sum', header: 'What it does', render: (r) => <span className="muted">{r.summary}</span> },
            { key: 'u', header: 'Updated', render: (r) => day(r.updatedAt) },
          ]} />
        </Card>
      )}
    </div>
  );
}

import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { day } from '../../shared/format';
import { useAsync, useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge } from '../../shared/rules-ui';
import { Button, Card, DataTable, ErrorBox, Field, Filters, Loading, StatusBadge } from '../../shared/ui';

export function Rules() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const family = sp.get('family') ?? '';
  const status = sp.get('status') ?? '';
  const schedule = sp.get('schedule') ?? '';
  const q = useDebounced(sp.get('q') ?? '');
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const { data, error, reload } = useAsync(() => api<any[]>('/rules', { query: { family, status, schedule, q } }), [family, status, schedule, q]);
  const drafts = (data ?? []).filter((r) => r.latestStatus === 'DRAFT').length;

  return (
    <div>
      <PageHead
        title="Rules"
        sub="Missions (bank targets) and spend controls (customer values). Create a draft, publish it live, then test."
        actions={<>
          {can('rules:write') && <Button variant="primary" onClick={() => nav('/rules/new')}>Create rule</Button>}
          <a className="btn" href="/testing/">Test rules ↗</a>
        </>}
      />

      {drafts > 0 && (
        <div className="alert alert-warn">
          {drafts} draft{drafts === 1 ? '' : 's'} waiting to publish. Open a draft and click <strong>Publish</strong> to put it in the live pack.
        </div>
      )}

      <div className="pill" style={{ marginBottom: 14 }}>
        <button type="button" className={!family ? 'on' : ''} onClick={() => set('family', '')}>All</button>
        <button type="button" className={family === 'MISSION' ? 'on' : ''} onClick={() => set('family', 'MISSION')}>Missions</button>
        <button type="button" className={family === 'SPEND_CONTROL' ? 'on' : ''} onClick={() => set('family', 'SPEND_CONTROL')}>Spend controls</button>
      </div>

      <Filters>
        <Field label="Lifecycle">
          <select className="input" value={status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All</option>
            {['ACTIVE', 'PAUSED', 'DRAFT', 'RETIRED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
          </select>
        </Field>
        <Field label="Schedule">
          <select className="input" value={schedule} onChange={(e) => set('schedule', e.target.value)}>
            <option value="">All</option>
            {['RUNNING', 'EXPIRED', 'PAUSED', 'SCHEDULED', 'DRAFT', 'RETIRED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
          </select>
        </Field>
        <Field label="Search"><input className="input" value={sp.get('q') ?? ''} onChange={(e) => set('q', e.target.value)} placeholder="Code or name" /></Field>
      </Filters>

      {error && <ErrorBox error={error} retry={reload} />}
      {!data ? <Loading /> : (
        <Card pad={false}>
          <DataTable
            rows={data}
            empty="No rules match. Create a mission or spend control to get started."
            onRow={(r) => nav(`/rules/${r.code}`)}
            rowKey={(r) => r.code}
            cols={[
              { key: 'n', header: 'Rule', render: (r) => <><strong>{r.name}</strong><br /><code>{r.code}</code></> },
              { key: 'f', header: 'Type', render: (r) => <FamilyBadge family={r.family} /> },
              { key: 'sched', header: 'Status', render: (r) => <StatusBadge status={r.scheduleStatus} /> },
              { key: 'dates', header: 'Effective', render: (r) => <span className="muted">{r.effectiveFrom ?? '…'} → {r.effectiveTo ?? 'open'}</span> },
              { key: 'sum', header: 'What it does', render: (r) => <span className="muted">{r.summary}</span> },
              { key: 'u', header: 'Updated', render: (r) => day(r.updatedAt) },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

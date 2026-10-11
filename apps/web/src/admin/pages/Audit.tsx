import { useState } from 'react';
import { api, download } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Badge, Button, Card, DataTable, ErrorBox, Field, Filters, Json, Loading, Modal, Pager, useToast } from '../../shared/ui';

export function Audit() {
  const { user } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ entityType: '', entityId: '', actor: '', action: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<any>(null);
  const [chain, setChain] = useState<any>(null);
  const limit = 50;
  const q = useAsync(() => api<any>('/audit', { query: { ...applied, limit, offset } }), [applied, offset]);
  const set = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const canExport = user?.roles.some((r) => ['AUDITOR', 'SYSTEM_ADMIN'].includes(r));
  return (
    <>
      <PageHead title="Audit trail" sub="Every configuration change, approval, login and export. Entries are append-only and hash-chained, so tampering is detectable."
        actions={<><Button onClick={async () => { try { setChain(await api('/audit/verify')); } catch (e) { toast.err(e); } }}>Verify integrity</Button>{canExport && <Button onClick={() => download('/audit/export.csv', applied, 'audit.csv').catch(toast.err)}>Export CSV</Button>}</>} />
      {chain && <Alert tone={chain.ok ? 'ok' : 'err'}>{chain.ok ? `Audit chain verified: ${chain.checked} entries, no tampering detected.` : `INTEGRITY FAILURE at entry #${chain.brokenAt}. Escalate to security.`}</Alert>}
      <Card>
        <Filters onApply={() => { setOffset(0); setApplied(f); }}>
          <Field label="Entity type"><select className="input" value={f.entityType} onChange={set('entityType')}><option value="">All</option>{['rule_version', 'campaign', 'app_user', 'reward_adjustment', 'ingestion_event', 'system_config', 'api_client'].map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Entity id"><input className="input" value={f.entityId} onChange={set('entityId')} placeholder="CARD_SPEND_10K@2" /></Field>
          <Field label="Actor"><input className="input" value={f.actor} onChange={set('actor')} /></Field>
          <Field label="Action"><input className="input" value={f.action} onChange={set('action')} placeholder="RULE_ACTIVATE" /></Field>
          <Field label="From"><input className="input" type="date" value={f.from} onChange={set('from')} /></Field>
          <Field label="To"><input className="input" type="date" value={f.to} onChange={set('to')} /></Field>
          <Button variant="primary" type="submit">Search</Button>
        </Filters>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={q.reload} /> : (
          <>
            <DataTable rows={q.data.rows} onRow={setOpen} empty="No audit entries match." cols={[
              { key: 'i', header: '#', render: (r: any) => r.auditId }, { key: 't', header: 'When', render: (r: any) => dt(r.occurredAt) }, { key: 'a', header: 'Who', render: (r: any) => <>{r.actor}<br /><small className="muted">{r.roles}</small></> },
              { key: 'x', header: 'Action', render: (r: any) => <Badge tone="blue">{pretty(r.action)}</Badge> }, { key: 'e', header: 'Entity', render: (r: any) => <><small className="muted">{r.entityType}</small><br /><code>{r.entityId}</code></> }, { key: 'r', header: 'Reason', className: 'hide-sm', render: (r: any) => r.reason ?? '' },
            ]} />
            <Pager total={q.data.total} limit={limit} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>
      {open && (
        <Modal wide title={`Audit entry #${open.auditId}`} onClose={() => setOpen(null)}>
          <p><strong>{open.actor}</strong> · {pretty(open.action)} · {open.entityType} <code>{open.entityId}</code> · {dt(open.occurredAt)}</p>
          {open.reason && <p>Reason: {open.reason}</p>}
          <div className="grid g2"><div><h3>Before</h3><Json value={open.before ? JSON.parse(open.before) : null} max={320} /></div><div><h3>After</h3><Json value={open.after ? JSON.parse(open.after) : null} max={320} /></div></div>
        </Modal>
      )}
    </>
  );
}

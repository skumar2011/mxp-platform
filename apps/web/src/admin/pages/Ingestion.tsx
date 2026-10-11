import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, num, pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Badge, Button, Card, DataTable, ErrorBox, Field, Filters, Json, KeyVal, Loading, Modal, Pager, Stat, StatusBadge, Tabs, useToast } from '../../shared/ui';

const STATUSES = ['RECEIVED', 'NORMALIZED', 'PROCESSING', 'PROCESSED', 'SUSPENDED', 'REJECTED', 'FAILED', 'DEAD_LETTER'];

export function Ingestion() {
  const [sp, setSp] = useSearchParams();
  const [tab, setTab] = useState<'events' | 'batches'>('events');
  const health = useAsync(() => api<any>('/ops/health'), []);
  const h = health.data;
  return (
    <>
      <PageHead title="Ingestion" sub="Events arriving from source systems: validation, de-duplication, retry and dead letters." actions={<Button onClick={health.reload}>Refresh</Button>} />
      {h && (
        <div className="grid g4" style={{ marginBottom: 16 }}>
          <Stat label="Queue depth" value={num(h.queueDepth)} sub={h.oldestPending ? `oldest ${dt(h.oldestPending)}` : 'empty'} />
          <Stat label="Suspended (retrying)" value={num(h.suspended)} tone={h.suspended ? 'amber' : undefined} sub="waiting for missing reference data" />
          <Stat label="Dead letters" value={num(h.deadLetters)} tone={h.deadLetters ? 'red' : undefined} sub="need a person" />
          <Stat label="Worker" value={h.workerEnabled ? 'Running' : 'Off'} sub={`${num(h.txnAwaitingEvaluation)} txn awaiting evaluation`} tone={h.workerEnabled ? 'green' : 'amber'} />
        </div>
      )}
      <Tabs tabs={[{ id: 'events', label: 'Events' }, { id: 'batches', label: 'Batches' }]} value={tab} onChange={setTab} />
      {tab === 'events' ? <Events initial={sp.get('status') ?? ''} onChange={(s) => setSp(s ? { status: s } : {})} refresh={health.reload} /> : <Batches />}
    </>
  );
}

function Events({ initial, onChange, refresh }: { initial: string; onChange: (s: string) => void; refresh: () => void }) {
  const { can } = useAuth();
  const [f, setF] = useState({ status: initial, source: '', q: '' });
  const [applied, setApplied] = useState(f);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const limit = 50;
  const q = useAsync(() => api<any>('/events', { query: { ...applied, limit, offset } }), [applied, offset]);
  return (
    <Card>
      <Filters onApply={() => { setOffset(0); setApplied(f); onChange(f.status); }}>
        <Field label="Status"><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{pretty(s)}</option>)}</select></Field>
        <Field label="Source system"><input className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value.toUpperCase() })} placeholder="CBS" /></Field>
        <Field label="Source event id"><input className="input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
        <Button variant="primary" type="submit">Search</Button>
      </Filters>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={q.reload} /> : (
        <>
          <DataTable rows={q.data.rows} onRow={(r: any) => setOpen(r.eventId)} empty="No events." cols={[
            { key: 'r', header: 'Received', render: (r: any) => dt(r.receivedAt) }, { key: 's', header: 'Source', render: (r: any) => <>{r.sourceSystem}<br /><small className="muted mono">{r.sourceEventId}</small></> },
            { key: 't', header: 'Type', render: (r: any) => pretty(r.eventType) }, { key: 'p', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'a', header: 'Attempts', align: 'right', render: (r: any) => r.attempts }, { key: 'd', header: 'Deliveries', align: 'right', render: (r: any) => (r.deliveries > 1 ? <Badge tone="blue">{r.deliveries}x</Badge> : 1) },
            { key: 'e', header: 'Error', className: 'hide-sm', render: (r: any) => (r.errorCode ? <small className="err">{r.errorCode}: {r.lastError}</small> : '') },
          ]} />
          <Pager total={q.data.total} limit={limit} offset={offset} onChange={setOffset} />
        </>
      )}
      {open && <EventModal id={open} canReplay={can('ops:write')} onClose={() => setOpen(null)} onChanged={() => { q.reload(); refresh(); }} />}
    </Card>
  );
}

function EventModal({ id, canReplay, onClose, onChanged }: { id: string; canReplay: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const q = useAsync(() => api<any>(`/events/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const e = q.data;
  const replay = async () => { setBusy(true); try { await api(`/events/${id}/replay`, { body: {} }); toast.ok('Event replayed.'); q.reload(); onChanged(); } catch (x) { toast.err(x); } finally { setBusy(false); } };
  return (
    <Modal wide title="Event detail" onClose={onClose} footer={canReplay && e && ['DEAD_LETTER', 'FAILED', 'REJECTED', 'SUSPENDED'].includes(e.processing_status) ? <Button variant="primary" busy={busy} onClick={replay}>Replay event</Button> : undefined}>
      {q.loading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : e && (
        <>
          <KeyVal items={[['Source', `${e.source_system} / ${e.source_event_id}`], ['Status', <StatusBadge key="s" status={e.processing_status} />], ['Attempts', e.attempts], ['Received', dt(e.received_at)], ['Processed', dt(e.processed_at)], ['Error', e.error_code ? `${e.error_code}: ${e.last_error}` : '-']]} />
          <h3 style={{ margin: '14px 0 6px' }}>Processing history</h3>
          <DataTable rows={e.history} cols={[{ key: 'a', header: 'When', render: (h: any) => dt(h.at) }, { key: 's', header: 'Stage', render: (h: any) => h.stage }, { key: 'o', header: 'Outcome', render: (h: any) => h.outcome }, { key: 'd', header: 'Detail', render: (h: any) => h.detail ?? '' }]} />
          <h3 style={{ margin: '14px 0 6px' }}>Payload (as received)</h3>
          <Json value={e.payload} max={260} />
        </>
      )}
    </Modal>
  );
}

function Batches() {
  const q = useAsync(() => api<{ rows: any[] }>('/ingest/batches'), []);
  return (
    <Card pad={false}>
      {q.loading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <DataTable rows={q.data!.rows} empty="No batches have been received." cols={[
          { key: 'c', header: 'Created', render: (b: any) => dt(b.created_at) }, { key: 's', header: 'Source', render: (b: any) => <>{b.source_system}<br /><small className="muted">{b.file_name ?? ''}</small></> }, { key: 't', header: 'Status', render: (b: any) => <StatusBadge status={b.status} /> },
          { key: 'k', header: 'Declared', align: 'right', render: (b: any) => (b.control_count ?? '-') }, { key: 'r', header: 'Received', align: 'right', render: (b: any) => b.received_count },
          { key: 'a', header: 'Accepted', align: 'right', render: (b: any) => b.accepted_count }, { key: 'd', header: 'Duplicates', align: 'right', render: (b: any) => b.duplicate_count }, { key: 'x', header: 'Rejected', align: 'right', render: (b: any) => b.rejected_count },
        ]} />
      )}
    </Card>
  );
}

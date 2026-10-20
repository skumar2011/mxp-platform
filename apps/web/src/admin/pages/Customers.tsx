import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, num } from '../../shared/format';
import { useAsync, useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { useMeta } from '../../shared/rules-ui';
import { Badge, Button, Card, DataTable, ErrorBox, Field, Filters, Loading, Modal, useToast } from '../../shared/ui';

export function Customers() {
  const nav = useNavigate();
  const { can } = useAuth();
  const meta = useMeta();
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q);
  const { data, error, reload } = useAsync(() => api<any[]>('/customers', { query: { q: dq, segment, limit: 200 } }), [dq, segment]);
  return (
    <div>
      <PageHead title="Customers" sub="Controls each customer has set, missions in progress, points and the evaluation trail." actions={can('customers:write') && <Button onClick={() => setCreating(true)}>New test customer</Button>} />
      <Filters>
        <Field label="Search"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, CIF or id" /></Field>
        <Field label="Segment"><select className="input" value={segment} onChange={(e) => setSegment(e.target.value)}><option value="">All</option>{meta.data?.segments.map((s) => <option key={s.segment_code} value={s.segment_code}>{s.name}</option>)}</select></Field>
      </Filters>
      {error && <ErrorBox error={error} retry={reload} />}
      {!data ? <Loading /> : (
        <Card pad={false}>
          <DataTable rows={data} rowKey={(r) => r.customer_id} onRow={(r) => nav(`/customers/${r.customer_id}`)} cols={[
            { key: 'n', header: 'Customer', render: (r) => <><strong>{r.display_name}</strong><br /><code>{r.customer_id}</code> <span className="muted">{r.customer_ref}</span></> },
            { key: 's', header: 'Segment', render: (r) => <Badge tone="blue">{r.segment_code}</Badge> },
            { key: 'tz', header: 'Timezone', render: (r) => r.timezone },
            { key: 'f', header: 'Flags', render: (r) => (r.dormancy_risk ? <Badge tone="amber">dormancy risk</Badge> : null) },
            { key: 'c', header: 'Controls set', align: 'right', render: (r) => r.controls },
            { key: 'p', header: 'Points', align: 'right', render: (r) => <strong>{num(r.points)}</strong> },
            { key: 'l', header: 'Last event', render: (r) => dt(r.last_event_at) },
          ]} />
        </Card>
      )}
      {creating && <NewCustomer onClose={() => setCreating(false)} onDone={(id) => nav(`/customers/${id}`)} segments={meta.data?.segments ?? []} />}
    </div>
  );
}

function NewCustomer({ onClose, onDone, segments }: { onClose: () => void; onDone: (id: string) => void; segments: { segment_code: string; name: string }[] }) {
  const toast = useToast();
  const [f, setF] = useState({ displayName: '', customerRef: `CIF-T${Date.now().toString().slice(-6)}`, segment: 'MASS', timezone: 'Asia/Kolkata', dormancyRisk: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const r = await api<{ customerId: string }>('/customers', { body: { ...f, accounts: [{ accountRef: `${f.customerRef}-SA`, accountType: 'SAVINGS', productFamily: 'SAVINGS', openedOn: today }, { accountRef: `${f.customerRef}-RD`, accountType: 'RECURRING_DEPOSIT', productFamily: 'RECURRING_DEPOSIT', openedOn: today }] } });
      toast.ok('Customer created.'); onDone(r.customerId);
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title="New test customer" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.displayName} onClick={go}>Create</Button></>}>
      <div className="stack">
        {err && <ErrorBox error={err} />}
        <Field label="Display name"><input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
        <Field label="CIF token"><input className="input" value={f.customerRef} onChange={(e) => setF({ ...f, customerRef: e.target.value })} /></Field>
        <Field label="Segment"><select className="input" value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })}>{segments.map((s) => <option key={s.segment_code} value={s.segment_code}>{s.name}</option>)}</select></Field>
        <Field label="Timezone" hint="IANA name, e.g. Asia/Kolkata, America/New_York"><input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.dormancyRisk} onChange={(e) => setF({ ...f, dormancyRisk: e.target.checked })} /> Flag as dormancy risk</label>
        <small className="muted">A savings and an RD account are created with the customer.</small>
      </div>
    </Modal>
  );
}

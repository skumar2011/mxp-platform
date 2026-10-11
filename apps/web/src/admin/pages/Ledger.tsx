import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, download } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, num, pts } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Button, Card, DataTable, ErrorBox, Field, Filters, Loading, Modal, Pager, ReasonDialog, StatusBadge, Tabs, useToast } from '../../shared/ui';

export function Ledger() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'ledger' | 'adjustments') ?? 'ledger';
  return (
    <>
      <PageHead title="XP ledger" sub="Immutable record of every point issued or taken back. Corrections are new entries, never edits." />
      <Tabs tabs={[{ id: 'ledger', label: 'Ledger' }, { id: 'adjustments', label: 'Manual adjustments' }]} value={tab} onChange={(t) => setSp({ tab: t })} />
      {tab === 'ledger' ? <LedgerTab /> : <Adjustments />}
    </>
  );
}

function LedgerTab() {
  const { can } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ customerRef: '', ruleCode: '', type: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const q = useAsync(() => api<any>('/ledger', { query: { ...applied, limit, offset } }), [applied, offset]);
  const set = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card>
      <Filters onApply={() => { setOffset(0); setApplied(f); }}>
        <Field label="Customer"><input className="input" value={f.customerRef} onChange={set('customerRef')} /></Field>
        <Field label="Rule"><input className="input" value={f.ruleCode} onChange={set('ruleCode')} /></Field>
        <Field label="Type"><select className="input" value={f.type} onChange={set('type')}><option value="">All</option><option>AWARD</option><option>REVERSAL</option><option>ADJUSTMENT</option></select></Field>
        <Field label="From"><input className="input" type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="To"><input className="input" type="date" value={f.to} onChange={set('to')} /></Field>
        <Button variant="primary" type="submit">Search</Button>
        {can('export') && <Button onClick={() => download('/ledger/export.csv', applied, 'ledger.csv').catch(toast.err)}>Export CSV</Button>}
      </Filters>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={q.reload} /> : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>{num(q.data.total)} entries · net <strong>{num(q.data.sum)}</strong> XP for this selection</p>
          <DataTable rows={q.data.rows} empty="No ledger entries." cols={[
            { key: 'i', header: '#', render: (r: any) => r.ledgerId }, { key: 't', header: 'When', render: (r: any) => dt(r.createdAt) }, { key: 'c', header: 'Customer', render: (r: any) => r.customerRef },
            { key: 'e', header: 'Type', render: (r: any) => <StatusBadge status={r.entryType} /> }, { key: 'r', header: 'Rule', render: (r: any) => r.ruleCode ?? '-' }, { key: 'p', header: 'Period', render: (r: any) => r.period ?? '-' },
            { key: 'x', header: 'XP', align: 'right', render: (r: any) => <strong className={r.points < 0 ? 'err' : ''}>{pts(r.points)}</strong> },
            { key: 'w', header: 'Reason', className: 'hide-sm', render: (r: any) => <small>{r.reason}{r.reversesLedgerId ? ` (reverses #${r.reversesLedgerId})` : ''}</small> },
          ]} />
          <Pager total={q.data.total} limit={limit} offset={offset} onChange={setOffset} />
        </>
      )}
    </Card>
  );
}

function Adjustments() {
  const { can, user } = useAuth();
  const toast = useToast();
  const q = useAsync(() => api<{ rows: any[] }>('/adjustments'), []);
  const [form, setForm] = useState<null | { customerRef: string; points: string; reason: string }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [decide, setDecide] = useState<null | { id: string; approve: boolean }>(null);
  const submit = async () => {
    if (!form) return;
    try { await api('/adjustments', { body: { customerRef: form.customerRef.trim(), points: Number(form.points), reason: form.reason } }); toast.ok('Adjustment requested. A different person must approve it.'); setForm(null); q.reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Card pad={false} title="Manual adjustments (maker-checker)" actions={can('adjust:request') && <Button variant="primary" onClick={() => { setErr(null); setForm({ customerRef: '', points: '', reason: '' }); }}>+ Request adjustment</Button>}>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <DataTable rows={q.data!.rows} empty="No adjustments." cols={[
          { key: 'w', header: 'Requested', render: (r) => <>{dt(r.requestedAt)}<br /><small className="muted">by {r.requestedBy}</small></> }, { key: 'c', header: 'Customer', render: (r) => r.customerRef },
          { key: 'p', header: 'XP', align: 'right', render: (r) => <strong>{pts(r.points)}</strong> }, { key: 'r', header: 'Reason', render: (r) => r.reason },
          { key: 's', header: 'Status', render: (r) => <><StatusBadge status={r.status} />{r.decidedBy && <><br /><small className="muted">{r.decidedBy}: {r.decisionNote ?? ''}</small></>}</> },
          { key: 'a', header: '', render: (r) => r.status === 'REQUESTED' && can('adjust:approve') && r.requestedBy !== user?.username ? <div className="row gap"><Button small variant="primary" onClick={() => setDecide({ id: r.adjustmentId, approve: true })}>Approve</Button><Button small variant="danger" onClick={() => setDecide({ id: r.adjustmentId, approve: false })}>Reject</Button></div> : null },
        ]} />
      )}
      {form && (
        <Modal title="Request XP adjustment" onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" onClick={submit}>Request</Button></>}>
          {err && <Alert tone="err">{err}</Alert>}
          <div className="stack">
            <Field label="Customer"><input className="input" value={form.customerRef} onChange={(e) => setForm({ ...form, customerRef: e.target.value })} placeholder="CUST-1001" /></Field>
            <Field label="Points" hint="Positive to give, negative to take back. Max 100,000."><input className="input" type="number" value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} /></Field>
            <Field label="Reason"><textarea className="input" rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {decide && <ReasonDialog title={decide.approve ? 'Approve adjustment' : 'Reject adjustment'} required={!decide.approve} danger={!decide.approve} confirm={decide.approve ? 'Approve' : 'Reject'} label="Note"
        onSubmit={(note) => api(`/adjustments/${decide.id}/decide`, { body: { approve: decide.approve, note: note || undefined } }).then(() => { toast.ok('Recorded.'); q.reload(); })} onClose={() => setDecide(null)} />}
    </Card>
  );
}

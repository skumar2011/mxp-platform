import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { num } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Button, Card, DataTable, ErrorBox, Field, Loading, Modal, ReasonDialog, StatusBadge, useToast } from '../../shared/ui';

const blank = { code: '', name: '', description: '', objective: '', startDate: '', endDate: '', pointsBudget: '', enrollmentMode: 'AUTO' };

export function Campaigns() {
  const { can } = useAuth();
  const toast = useToast();
  const q = useAsync(() => api<{ campaigns: any[] }>('/campaigns'), []);
  const [edit, setEdit] = useState<null | { code?: string; f: typeof blank }>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<null | { code: string; status: 'PAUSED' | 'CLOSED' }>(null);
  const [open, setOpen] = useState<any>(null);

  const save = async () => {
    if (!edit) return;
    setBusy(true); setErr(null);
    const f = edit.f;
    const body = { name: f.name, description: f.description || undefined, objective: f.objective || undefined, startDate: f.startDate, endDate: f.endDate, pointsBudget: f.pointsBudget === '' ? null : Number(f.pointsBudget), enrollmentMode: f.enrollmentMode };
    try {
      if (edit.code) await api(`/campaigns/${edit.code}`, { method: 'PATCH', body }); else await api('/campaigns', { body: { code: f.code, ...body } });
      toast.ok('Campaign saved.'); setEdit(null); q.reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const setActive = async (code: string) => { try { await api(`/campaigns/${code}/status`, { body: { status: 'ACTIVE' } }); toast.ok('Campaign is active.'); q.reload(); } catch (e) { toast.err(e); } };
  const show = async (code: string) => { try { setOpen(await api(`/campaigns/${code}`)); } catch (e) { toast.err(e); } };
  const set = (k: string, v: string) => setEdit((e) => e && { ...e, f: { ...e.f, [k]: v } });

  return (
    <>
      <PageHead title="Campaigns" sub="A campaign gives rules a date window, an optional XP budget and a shared objective." actions={can('campaigns:write') && <Button variant="primary" onClick={() => { setErr(null); setEdit({ f: blank }); }}>+ New campaign</Button>} />
      <Card pad={false}>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
          <DataTable rows={q.data!.campaigns} empty="No campaigns yet." cols={[
            { key: 'n', header: 'Campaign', render: (c) => <a href="#open" onClick={(e) => { e.preventDefault(); void show(c.campaign_code); }}><strong>{c.name}</strong></a> },
            { key: 'c', header: 'Code', render: (c) => <code>{c.campaign_code}</code> },
            { key: 'd', header: 'Window', render: (c) => `${c.start_date} → ${c.end_date}` },
            { key: 's', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'r', header: 'Rules', align: 'right', render: (c) => c.rule_count },
            { key: 'e', header: 'Customers', align: 'right', render: (c) => num(c.enrolled) },
            { key: 'p', header: 'XP / budget', align: 'right', render: (c) => `${num(c.points_issued)} / ${c.points_budget ? num(c.points_budget) : 'no cap'}` },
            { key: 'a', header: '', render: (c) => (
              <div className="row gap">
                {can('campaigns:write') && c.status !== 'CLOSED' && <Button small onClick={() => { setErr(null); setEdit({ code: c.campaign_code, f: { code: c.campaign_code, name: c.name, description: c.description ?? '', objective: c.objective ?? '', startDate: c.start_date, endDate: c.end_date, pointsBudget: c.points_budget ?? '', enrollmentMode: c.enrollment_mode } }); }}>Edit</Button>}
                {can('rules:activate') && ['DRAFT', 'PAUSED'].includes(c.status) && <Button small variant="primary" onClick={() => setActive(c.campaign_code)}>{c.status === 'DRAFT' ? 'Activate' : 'Resume'}</Button>}
                {can('rules:activate') && c.status === 'ACTIVE' && <Button small onClick={() => setStatus({ code: c.campaign_code, status: 'PAUSED' })}>Pause</Button>}
                {can('rules:activate') && c.status !== 'CLOSED' && <Button small variant="danger" onClick={() => setStatus({ code: c.campaign_code, status: 'CLOSED' })}>Close</Button>}
              </div>) },
          ]} />
        )}
      </Card>
      {edit && (
        <Modal wide title={edit.code ? `Edit ${edit.code}` : 'New campaign'} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save</Button></>}>
          {err && <Alert tone="err">{err}</Alert>}
          <div className="form-grid">
            {!edit.code && <Field label="Code" hint="Capital letters, digits, underscore"><input className="input mono" value={edit.f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>}
            <Field label="Name"><input className="input" value={edit.f.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Start date"><input className="input" type="date" value={edit.f.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
            <Field label="End date"><input className="input" type="date" value={edit.f.endDate} onChange={(e) => set('endDate', e.target.value)} /></Field>
            <Field label="XP budget" hint="Blank = no cap. Rewards stop (are capped) when the budget is used."><input className="input" type="number" min={1} value={edit.f.pointsBudget} onChange={(e) => set('pointsBudget', e.target.value)} /></Field>
            <Field label="Enrolment"><select className="input" value={edit.f.enrollmentMode} onChange={(e) => set('enrollmentMode', e.target.value)}><option value="AUTO">Automatic for eligible customers</option><option value="OPT_IN">Customer opts in</option></select></Field>
            <Field label="Objective" wide><input className="input" value={edit.f.objective} onChange={(e) => set('objective', e.target.value)} /></Field>
            <Field label="Description" wide><textarea className="input" rows={2} value={edit.f.description} onChange={(e) => set('description', e.target.value)} /></Field>
          </div>
        </Modal>
      )}
      {status && <ReasonDialog title={`${status.status === 'PAUSED' ? 'Pause' : 'Close'} ${status.code}`} danger={status.status === 'CLOSED'} confirm={status.status === 'PAUSED' ? 'Pause' : 'Close campaign'}
        intro={status.status === 'CLOSED' ? 'Closing is permanent. No more rewards are issued under this campaign.' : 'Rewards under this campaign stop until it is resumed.'}
        onSubmit={(reason) => api(`/campaigns/${status.code}/status`, { body: { status: status.status, reason } }).then(() => { toast.ok('Updated.'); q.reload(); })} onClose={() => setStatus(null)} />}
      {open && (
        <Modal wide title={open.campaign.name} onClose={() => setOpen(null)}>
          <p>{open.campaign.description}</p>
          <p><StatusBadge status={open.campaign.status} /> · issued {num(open.pointsIssued)} XP{open.campaign.points_budget ? ` of ${num(open.campaign.points_budget)}` : ''}</p>
          <DataTable rows={open.rules} empty="No rules use this campaign." cols={[
            { key: 'r', header: 'Rule', render: (r: any) => <Link to={`/rules/${r.rule_code}?v=${r.version_no}`}>{r.rule_code}</Link> }, { key: 'v', header: 'Version', render: (r: any) => `v${r.version_no}` }, { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
          ]} />
        </Modal>
      )}
    </>
  );
}

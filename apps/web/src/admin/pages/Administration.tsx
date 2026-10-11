import { useState } from 'react';
import { api } from '../../shared/api';
import { dt } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { loadMeta } from '../../shared/meta';
import { Alert, Badge, Button, Card, DataTable, ErrorBox, Field, Loading, Modal, Tabs, useToast } from '../../shared/ui';

export function Administration() {
  const [tab, setTab] = useState<'users' | 'clients' | 'config'>('users');
  return (
    <>
      <PageHead title="Administration" sub="Users and roles, source-system API keys, and engine settings. All changes are audited." />
      <Tabs tabs={[{ id: 'users', label: 'Users and roles' }, { id: 'clients', label: 'API clients' }, { id: 'config', label: 'Engine settings' }]} value={tab} onChange={setTab} />
      {tab === 'users' ? <Users /> : tab === 'clients' ? <Clients /> : <Config />}
    </>
  );
}

function Users() {
  const toast = useToast();
  const q = useAsync(() => api<{ users: any[] }>('/admin/users'), []);
  const meta = useAsync(loadMeta, []);
  const [form, setForm] = useState<any>(null);
  const [pw, setPw] = useState<{ username: string; password: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const roles = meta.data?.roles ?? [];
  const save = async () => {
    setErr(null);
    try {
      if (form.isNew) await api('/admin/users', { body: { username: form.username, name: form.name, roles: form.roles, password: form.password } });
      else await api(`/admin/users/${form.username}`, { method: 'PATCH', body: { roles: form.roles, name: form.name } });
      toast.ok('Saved.'); setForm(null); q.reload();
    } catch (e) { setErr((e as Error).message); }
  };
  const patch = (u: string, body: any) => api(`/admin/users/${u}`, { method: 'PATCH', body }).then(() => { toast.ok('Updated.'); q.reload(); }).catch(toast.err);
  const toggle = (r: string) => setForm((f: any) => ({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r] }));
  return (
    <Card pad={false} title="Users" actions={<Button variant="primary" onClick={() => { setErr(null); setForm({ isNew: true, username: '', name: '', roles: [], password: '' }); }}>+ New user</Button>}>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <DataTable rows={q.data!.users} cols={[
          { key: 'u', header: 'User', render: (u) => <><strong>{u.name}</strong><br /><small className="muted">{u.username}</small></> },
          { key: 'r', header: 'Roles', render: (u) => <div className="row wrap" style={{ gap: 4 }}>{u.roles.map((r: string) => <Badge key={r} tone="violet">{r.replace(/_/g, ' ').toLowerCase()}</Badge>)}</div> },
          { key: 's', header: 'Status', render: (u) => (u.lockedUntil && u.lockedUntil > new Date().toISOString() ? <Badge tone="red">Locked</Badge> : u.active ? <Badge tone="green">Active</Badge> : <Badge>Disabled</Badge>) },
          { key: 'c', header: 'Created', className: 'hide-sm', render: (u) => dt(u.createdAt) },
          { key: 'a', header: '', render: (u) => (
            <div className="row gap wrap">
              <Button small onClick={() => { setErr(null); setForm({ isNew: false, username: u.username, name: u.name, roles: u.roles }); }}>Edit</Button>
              <Button small onClick={() => setPw({ username: u.username, password: '' })}>Reset password</Button>
              {u.lockedUntil && <Button small onClick={() => patch(u.username, { unlock: true })}>Unlock</Button>}
              <Button small variant={u.active ? 'danger' : 'secondary'} onClick={() => patch(u.username, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</Button>
            </div>) },
        ]} />
      )}
      {form && (
        <Modal title={form.isNew ? 'New user' : `Edit ${form.username}`} onClose={() => setForm(null)} footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
          {err && <Alert tone="err">{err}</Alert>}
          <div className="stack">
            {form.isNew && <Field label="Username" hint="Lower case, 3-32 characters"><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /></Field>}
            <Field label="Display name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Roles" hint="Approvers cannot approve their own work; separate duties by giving makers and approvers different people.">
              <div className="col" style={{ gap: 6 }}>{roles.map((r) => <label key={r} className="check"><input type="checkbox" checked={form.roles.includes(r)} onChange={() => toggle(r)} />{r.replace(/_/g, ' ').toLowerCase()}</label>)}</div></Field>
            {form.isNew && <Field label="Initial password" hint="10+ characters with upper case, lower case and a digit"><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></Field>}
          </div>
        </Modal>
      )}
      {pw && (
        <Modal title={`Reset password for ${pw.username}`} onClose={() => setPw(null)} footer={<><Button onClick={() => setPw(null)}>Cancel</Button><Button variant="primary" onClick={() => api(`/admin/users/${pw.username}/password`, { body: { password: pw.password } }).then(() => { toast.ok('Password reset.'); setPw(null); }).catch(toast.err)}>Reset</Button></>}>
          <Field label="New password"><input className="input" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} autoComplete="new-password" /></Field>
        </Modal>
      )}
    </Card>
  );
}

function Clients() {
  const toast = useToast();
  const q = useAsync(() => api<{ clients: any[] }>('/admin/clients'), []);
  const [src, setSrc] = useState('');
  const [created, setCreated] = useState<any>(null);
  const create = async () => { try { setCreated(await api('/admin/clients', { body: { sourceSystem: src } })); setSrc(''); q.reload(); } catch (e) { toast.err(e); } };
  return (
    <Card title="Source-system API clients" pad={false}>
      <div className="card-b row gap wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Source system code" hint="e.g. CBS, UPI_SWITCH, CARDS"><input className="input mono" value={src} onChange={(e) => setSrc(e.target.value.toUpperCase())} /></Field>
        <Button variant="primary" disabled={!src} onClick={create}>Create API key</Button>
      </div>
      {created && <div className="card-b"><Alert tone="warn"><strong>Copy this key now. It is shown once.</strong><br /><code style={{ wordBreak: 'break-all' }}>{created.apiKey}</code><br />Send it as the <code>x-api-key</code> header to <code>POST /api/ingest</code>. It can only submit events for <strong>{created.sourceSystem}</strong>.</Alert></div>}
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <DataTable rows={q.data!.clients} empty="No API clients." cols={[
          { key: 's', header: 'Source system', render: (c) => <strong>{c.sourceSystem}</strong> }, { key: 'c', header: 'Created', render: (c) => dt(c.createdAt) },
          { key: 'a', header: 'Status', render: (c) => (c.active ? <Badge tone="green">Active</Badge> : <Badge>Revoked</Badge>) },
          { key: 'x', header: '', render: (c) => c.active && <Button small variant="danger" onClick={() => api(`/admin/clients/${c.clientId}`, { method: 'DELETE' }).then(() => { toast.ok('Revoked.'); q.reload(); }).catch(toast.err)}>Revoke</Button> },
        ]} />
      )}
    </Card>
  );
}

function Config() {
  const toast = useToast();
  const q = useAsync(() => api<any>('/admin/config'), []);
  const [c, setC] = useState<any>(null);
  const cfg = c ?? q.data?.config;
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const set = (patch: any) => setC({ ...cfg, ...patch });
  const nudge = (patch: any) => setC({ ...cfg, nudge: { ...cfg.nudge, ...patch } });
  const channels = ['PUSH', 'IN_APP', 'SMS', 'EMAIL', 'WHATSAPP'];
  const save = async () => { try { const r: any = await api('/admin/config', { method: 'PUT', body: cfg }); setC(r.config); toast.ok('Engine settings saved.'); } catch (e) { toast.err(e); } };
  return (
    <Card title="Engine settings" actions={<Button variant="primary" onClick={save} disabled={!c}>Save changes</Button>}>
      <div className="form-grid">
        <Field label="Delivery attempts before dead-letter"><input className="input" type="number" value={cfg.maxAttempts} onChange={(e) => set({ maxAttempts: Number(e.target.value) })} /></Field>
        <Field label="Retry base delay (seconds)" hint="Doubles on each attempt"><input className="input" type="number" value={cfg.retryBaseSeconds} onChange={(e) => set({ retryBaseSeconds: Number(e.target.value) })} /></Field>
        <Field label="Reject events dated in the future by more than (minutes)"><input className="input" type="number" value={cfg.futureToleranceMinutes} onChange={(e) => set({ futureToleranceMinutes: Number(e.target.value) })} /></Field>
        <Field label="Progress nudges per customer per day"><input className="input" type="number" value={cfg.nudge.dailyProgressCap} onChange={(e) => nudge({ dailyProgressCap: Number(e.target.value) })} /></Field>
        <Field label="Approved nudge channels"><div className="row wrap" style={{ gap: 10 }}>{channels.map((ch) => <label key={ch} className="check"><input type="checkbox" checked={cfg.nudge.approvedChannels.includes(ch)} onChange={(e) => nudge({ approvedChannels: e.target.checked ? [...cfg.nudge.approvedChannels, ch] : cfg.nudge.approvedChannels.filter((x: string) => x !== ch) })} />{ch}</label>)}</div></Field>
        <Field label="Default channel"><select className="input" value={cfg.nudge.defaultChannel} onChange={(e) => nudge({ defaultChannel: e.target.value })}>{cfg.nudge.approvedChannels.map((ch: string) => <option key={ch}>{ch}</option>)}</select></Field>
        <Field label="Evaluation trace"><label className="check"><input type="checkbox" checked={cfg.storeTrace} onChange={(e) => set({ storeTrace: e.target.checked })} /> Store the full per-condition trace (turn off to save space at very high volume)</label></Field>
      </div>
    </Card>
  );
}

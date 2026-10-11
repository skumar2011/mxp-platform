import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { describeRule } from '../../shared/describe';
import { dt, inr, num, pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Badge, Button, Card, DataTable, ErrorBox, Field, Json, KeyVal, Loading, Modal, ReasonDialog, StatusBadge, Tabs, useToast } from '../../shared/ui';

const FLOW = ['DRAFT', 'VALIDATED', 'SIMULATED', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE'] as const;
const FLOW_LABEL: Record<string, string> = { DRAFT: 'Draft', VALIDATED: 'Validated', SIMULATED: 'Simulated', PENDING_APPROVAL: 'Submitted', APPROVED: 'Approved', ACTIVE: 'Active' };

function stage(status: string, validated: boolean, simulated: boolean): number {
  if (status === 'ACTIVE' || status === 'PAUSED') return 5;
  if (status === 'APPROVED') return 4;
  if (status === 'PENDING_APPROVAL') return 3;
  if (status === 'DRAFT') return simulated ? 2 : validated ? 1 : 0;
  return -1;
}

export function RuleDetail() {
  const { code = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can, user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const list = useAsync(() => api<{ versions: any[] }>(`/rules/${code}`), [code]);
  const versions = list.data?.versions ?? [];
  const vParam = Number(sp.get('v')) || (versions.find((v) => ['ACTIVE', 'PAUSED'].includes(v.status)) ?? versions[0])?.versionNo;
  const ver = useAsync(() => (vParam ? api<any>(`/rules/${code}/versions/${vParam}`) : Promise.resolve(null)), [code, vParam, list.data]);
  const [tab, setTab] = useState<'summary' | 'history' | 'compare' | 'json'>('summary');
  const [dlg, setDlg] = useState<null | 'reject' | 'pause' | 'retire' | 'rollback' | 'activate' | 'approve'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<any>(null);
  const [impact, setImpact] = useState<any>(null);

  const refresh = () => { list.reload(); ver.reload(); };
  const act = async (name: string, path: string, body: unknown = {}, msg?: string) => {
    setBusy(name);
    try { await api(`/rules/${code}${path}`, { body }); toast.ok(msg ?? 'Done.'); refresh(); } catch (e) { toast.err(e); } finally { setBusy(null); }
  };

  if (list.loading && !list.data) return <Loading />;
  if (list.error) return <ErrorBox error={list.error} />;
  const v = ver.data;
  if (!v) return ver.error ? <ErrorBox error={ver.error} /> : <Loading />;

  const status: string = v.status;
  const mine = v.createdBy === user?.username || v.submittedBy === user?.username;
  const evidence = (v.history as any[]).filter((h) => h.action === 'SIMULATION_RUN').at(-1);
  const sim = evidence ? safeJson(evidence.after_json) : null;
  const validated = !!v.validation?.valid;
  const simulated = !!sim && sim.failed === 0 && sim.errors === 0 && sim.total > 0;
  const cur = stage(status, validated, simulated);
  const hasDraft = versions.some((x) => x.status === 'DRAFT');
  const live = versions.find((x) => ['ACTIVE', 'PAUSED'].includes(x.status));
  const superseded = versions.filter((x) => ['SUPERSEDED', 'RETIRED'].includes(x.status) && x.activatedAt);

  const runMatrix = async () => {
    setBusy('matrix');
    try { setMatrix(await api('/sim/matrix', { body: { rule: { ruleCode: code, versionNo: v.versionNo }, run: true } })); ver.reload(); } catch (e) { toast.err(e); } finally { setBusy(null); }
  };
  const runImpact = async () => {
    setBusy('impact');
    try { setImpact(await api('/sim/preview-sample', { body: { rule: { ruleCode: code, versionNo: v.versionNo }, limit: 25 } })); } catch (e) { toast.err(e); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHead
        title={<>{v.name} <StatusBadge status={status} /></>}
        sub={<><code>{code}</code> · version {v.versionNo} · {pretty(v.kind)} · {pretty(v.category)}{v.campaignCode ? ` · campaign ${v.campaignCode}` : ''}</>}
        actions={<>
          {can('simulate') && <a className="btn" href={`/testing/#/playground?rule=${code}&v=${v.versionNo}`}>Open in testing app ↗</a>}
          {status === 'DRAFT' && can('rules:write') && <Button onClick={() => nav(`/rules/${code}/versions/${v.versionNo}/edit`)}>Edit draft</Button>}
          {!hasDraft && can('rules:write') && <Button onClick={async () => { try { const n: any = await api(`/rules/${code}/versions`, { body: { baseVersionNo: v.versionNo } }); toast.ok(`Created draft v${n.versionNo}.`); setSp({ v: String(n.versionNo) }); list.reload(); } catch (e) { toast.err(e); } }}>New version from v{v.versionNo}</Button>}
        </>}
      />

      <div className="row gap wrap" style={{ marginBottom: 14 }}>
        {versions.map((x) => (
          <button key={x.versionNo} className={`btn btn-sm ${x.versionNo === v.versionNo ? 'btn-primary' : ''}`} onClick={() => setSp({ v: String(x.versionNo) })}>v{x.versionNo} · {pretty(x.status)}</button>
        ))}
      </div>

      {cur >= 0 && (
        <div className="steps" aria-label="Workflow progress">
          {FLOW.map((s, i) => {
            const skipped = s === 'SIMULATED' && cur >= 3 && !simulated;
            return <span key={s} className={`step ${skipped ? 'skip' : i < cur ? 'done' : i === cur ? 'now' : ''}`} title={skipped ? 'No passing simulation evidence is recorded for this version' : undefined}>{skipped ? '!' : i < cur ? '✓' : i + 1} {skipped ? 'No simulation' : FLOW_LABEL[s]}</span>;
          })}
          {status === 'PAUSED' && <span className="step now">Paused</span>}
        </div>
      )}
      {status === 'REJECTED' && <Alert tone="err"><strong>Rejected:</strong> {v.rejectedReason}. Create a new version to address the feedback.</Alert>}
      {status === 'SUPERSEDED' && <Alert tone="info">Replaced by a newer version{live ? ` (v${live.versionNo} is live)` : ''}.</Alert>}

      {/* ---- next-step actions ---- */}
      <Card title="Workflow">
        <div className="row gap wrap">
          {status === 'DRAFT' && <>
            <Button busy={busy === 'validate'} onClick={() => act('validate', `/versions/${v.versionNo}/validate`, {}, 'Validation re-run.')}>Validate</Button>
            {can('simulate') && <Button busy={busy === 'matrix'} onClick={runMatrix}>Run scenario matrix</Button>}
            {can('rules:write') && <Button variant="primary" busy={busy === 'submit'} disabled={!validated} onClick={() => act('submit', `/versions/${v.versionNo}/submit`, {}, 'Submitted for approval.')}>Submit for approval</Button>}
          </>}
          {status === 'PENDING_APPROVAL' && can('rules:approve') && (
            mine ? <Alert tone="warn">Maker-checker: you created or submitted this version, so a different approver must review it.</Alert>
              : <><Button variant="primary" onClick={() => setDlg('approve')}>Approve</Button><Button variant="danger" onClick={() => setDlg('reject')}>Reject</Button></>
          )}
          {status === 'PENDING_APPROVAL' && !can('rules:approve') && <span className="muted">Waiting for an approver (submitted by {v.submittedBy}).</span>}
          {status === 'APPROVED' && can('rules:activate') && <Button variant="primary" onClick={() => setDlg('activate')}>Activate…</Button>}
          {status === 'APPROVED' && !can('rules:activate') && <span className="muted">Approved. Waiting for an approver, operations or admin user to activate it.</span>}
          {status === 'ACTIVE' && can('rules:activate') && <><Button onClick={() => setDlg('pause')}>Pause</Button><Button variant="danger" onClick={() => setDlg('retire')}>Retire</Button></>}
          {status === 'PAUSED' && can('rules:activate') && <><Button variant="primary" busy={busy === 'resume'} onClick={() => act('resume', `/versions/${v.versionNo}/resume`, {}, 'Rule resumed.')}>Resume</Button><Button variant="danger" onClick={() => setDlg('retire')}>Retire</Button></>}
          {can('rules:activate') && superseded.length > 0 && <Button onClick={() => setDlg('rollback')}>Roll back to an earlier version…</Button>}
          {can('simulate') && ['PENDING_APPROVAL', 'APPROVED', 'DRAFT'].includes(status) && <Button busy={busy === 'impact'} onClick={runImpact}>Preview impact on real customers</Button>}
        </div>
        {status === 'DRAFT' && !validated && v.validation && <p className="err" style={{ marginBottom: 0 }}>Fix the validation errors below before submitting.</p>}
        {sim && <p style={{ marginBottom: 0 }}>Simulation evidence: <Badge tone={simulated ? 'green' : 'red'}>{sim.passed}/{sim.total} scenarios passed</Badge> <span className="muted">by {evidence.actor} on {dt(evidence.occurred_at)}</span></p>}
        {!sim && status !== 'ACTIVE' && <p className="muted" style={{ marginBottom: 0 }}>No simulation has been run on this version yet. Approvers will look for evidence.</p>}
      </Card>

      {v.validation && !v.validation.valid && <div style={{ marginTop: 14 }}>{v.validation.errors.map((i: any, k: number) => <Alert key={k} tone="err"><strong>{i.path || 'Rule'}</strong>: {i.message}</Alert>)}</div>}
      {v.validation?.warnings?.map((i: any, k: number) => <Alert key={k} tone="warn"><strong>{i.path || 'Rule'}</strong>: {i.message}</Alert>)}

      {matrix && (
        <Card title={`Scenario matrix: ${matrix.suite.passed}/${matrix.suite.total} passed`} className="" actions={<a href={`/testing/#/matrix?rule=${code}&v=${v.versionNo}`}>Open in testing app ↗</a>}>
          <DataTable rows={matrix.cases} cols={[
            { key: 'c', header: 'Category', render: (c: any) => <Badge tone="violet">{c.category}</Badge> },
            { key: 'n', header: 'Scenario', render: (c: any) => <>{c.name}<br /><small className="muted">{c.description}</small></> },
            { key: 's', header: 'Result', render: (c: any) => <StatusBadge status={c.result?.status} /> },
          ]} />
        </Card>
      )}
      {impact && (
        <Card title={`Impact preview: ${impact.customersEarning} of ${impact.customersEvaluated} customers would earn ${num(impact.totalPoints)} XP`}>
          <p className="muted" style={{ marginTop: 0 }}>Replays each customer's real transactions through this rule in an isolated sandbox. Nothing is written to production.</p>
          <DataTable rows={impact.rows} cols={[
            { key: 'c', header: 'Customer', render: (r: any) => <Link to={`/customers/${r.customerRef}`}>{r.customerRef}</Link> },
            { key: 's', header: 'Status', render: (r: any) => (r.ok ? <StatusBadge status={r.status} /> : <span className="err">{r.error}</span>) },
            { key: 'm', header: 'Metric', align: 'right', render: (r: any) => (r.metric === null || r.metric === undefined ? '-' : num(r.metric)) },
            { key: 'p', header: 'XP', align: 'right', render: (r: any) => <strong>{num(r.points)}</strong> },
          ]} />
        </Card>
      )}

      <div style={{ height: 14 }} />
      <Tabs tabs={[{ id: 'summary', label: 'Summary' }, { id: 'history', label: 'History' }, { id: 'compare', label: 'Compare versions' }, { id: 'json', label: 'Definition (JSON)' }]} value={tab} onChange={setTab} />

      {tab === 'summary' && (
        <div className="grid g-main">
          <Card title="In plain English">{describeRule(v.def).map((l, i) => <p key={i} style={{ margin: '0 0 8px' }}>{l}</p>)}</Card>
          <Card title="Details">
            <KeyVal items={[
              ['Created', `${v.createdBy} · ${dt(v.createdAt)}`], ['Submitted', v.submittedBy ? `${v.submittedBy} · ${dt(v.submittedAt)}` : '-'],
              ['Approved', v.approvedBy ? `${v.approvedBy} · ${dt(v.approvedAt)}` : '-'], ['Activated', v.activatedBy ? `${v.activatedBy} · ${dt(v.activatedAt)}` : '-'],
              ['Priority', v.def.priority], ['Conflict', v.def.conflict.group ? `${v.def.conflict.group} (${pretty(v.def.conflict.policy)})` : 'None'],
              ['Definition fingerprint', <code key="h">{(v.definitionHash ?? '-').slice(0, 16)}</code>], ['Change note', v.changeNote ?? '-'],
            ]} />
            {v.def.tiers.length > 0 && <div style={{ marginTop: 14 }}><DataTable rows={v.def.tiers} cols={[
              { key: 'l', header: 'Tier', render: (t: any) => t.label || '-' },
              { key: 't', header: 'Threshold', align: 'right', render: (t: any) => (v.def.metric?.type === 'COUNT' || v.kind === 'COMBINED' ? num(t.threshold) : inr(t.threshold)) },
              { key: 'p', header: 'XP', align: 'right', render: (t: any) => num(t.points) },
            ]} /></div>}
          </Card>
        </div>
      )}
      {tab === 'history' && (
        <Card pad={false} title="Approval and lifecycle history">
          <DataTable rows={[...v.history].reverse()} empty="No history." cols={[
            { key: 'w', header: 'When', render: (h: any) => dt(h.occurred_at) }, { key: 'a', header: 'Who', render: (h: any) => h.actor },
            { key: 'x', header: 'Action', render: (h: any) => <Badge tone="blue">{pretty(h.action)}</Badge> }, { key: 'r', header: 'Reason', render: (h: any) => h.reason ?? '' },
          ]} />
        </Card>
      )}
      {tab === 'compare' && <Compare code={code} versions={versions} current={v.versionNo} />}
      {tab === 'json' && <Json value={v.def} max={600} />}

      {dlg === 'approve' && <ReasonDialog title="Approve this version" required={false} label="Approval note (optional)" confirm="Approve" intro={`You are approving ${code} v${v.versionNo}. ${simulated ? 'Simulation evidence is attached.' : 'No passing simulation evidence is attached.'}`} onSubmit={(note) => api(`/rules/${code}/versions/${v.versionNo}/approve`, { body: { note } }).then(() => { toast.ok('Approved.'); refresh(); })} onClose={() => setDlg(null)} />}
      {dlg === 'reject' && <ReasonDialog title="Reject this version" danger confirm="Reject" intro="The maker will see your reason." onSubmit={(reason) => api(`/rules/${code}/versions/${v.versionNo}/reject`, { body: { reason } }).then(() => { toast.ok('Rejected.'); refresh(); })} onClose={() => setDlg(null)} />}
      {dlg === 'pause' && <ReasonDialog title="Pause this rule" confirm="Pause" intro="No new rewards are issued while paused. Progress keeps being tracked." onSubmit={(reason) => api(`/rules/${code}/versions/${v.versionNo}/pause`, { body: { reason } }).then(() => { toast.ok('Paused.'); refresh(); })} onClose={() => setDlg(null)} />}
      {dlg === 'retire' && <ReasonDialog title="Retire this rule" danger confirm="Retire" intro="Retired rules stop issuing rewards permanently. Points already earned are kept." onSubmit={(reason) => api(`/rules/${code}/versions/${v.versionNo}/retire`, { body: { reason } }).then(() => { toast.ok('Retired.'); refresh(); })} onClose={() => setDlg(null)} />}
      {dlg === 'activate' && <Activate code={code} v={v} onClose={() => setDlg(null)} onDone={() => { toast.ok('Activated.'); refresh(); }} />}
      {dlg === 'rollback' && <Rollback code={code} options={superseded} onClose={() => setDlg(null)} onDone={() => { toast.ok('Rolled back.'); refresh(); }} />}
    </>
  );
}

const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function Activate({ code, v, onClose, onDone }: { code: string; v: any; onClose: () => void; onDone: () => void }) {
  const [backfill, setBackfill] = useState(!!v.def.backfill);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setBusy(true); setErr(null); try { await api(`/rules/${code}/versions/${v.versionNo}/activate`, { body: { backfill } }); onDone(); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); } };
  return (
    <Modal title={`Activate ${code} v${v.versionNo}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={go}>Activate</Button></>}>
      {err && <Alert tone="err">{err}</Alert>}
      <p>The rule starts evaluating new transactions immediately. Any other live version of this rule is replaced and can be restored by rollback.</p>
      <label className="check"><input type="checkbox" checked={backfill} onChange={(e) => setBackfill(e.target.checked)} /> Also replay this period's existing transactions through the rule</label>
      <p className="muted">Replay is idempotent: rewards already issued are never duplicated.</p>
    </Modal>
  );
}

function Rollback({ code, options, onClose, onDone }: { code: string; options: any[]; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState<number>(options[0]?.versionNo);
  return (
    <ReasonDialog title="Roll back to an earlier version" danger confirm="Roll back" label="Why are you rolling back?"
      intro={<Field label="Restore version"><select className="input" value={target} onChange={(e) => setTarget(Number(e.target.value))}>{options.map((o) => <option key={o.versionNo} value={o.versionNo}>v{o.versionNo} · {pretty(o.status)} · activated {dt(o.activatedAt)}</option>)}</select></Field>}
      onSubmit={(reason) => api(`/rules/${code}/rollback`, { body: { versionNo: target, reason } }).then(onDone)} onClose={onClose} />
  );
}

function Compare({ code, versions, current }: { code: string; versions: any[]; current: number }) {
  const others = versions.filter((x) => x.versionNo !== current);
  const [from, setFrom] = useState<number | undefined>(others[0]?.versionNo);
  const diff = useAsync(() => (from ? api<{ changes: any[] }>(`/rules/${code}/diff`, { query: { from, to: current } }) : Promise.resolve(null)), [from, current]);
  if (!others.length) return <Card>This is the only version.</Card>;
  const show = (x: unknown) => (x === null || x === undefined ? <em className="muted">none</em> : typeof x === 'object' ? JSON.stringify(x) : String(x));
  return (
    <Card title={`Changes from v${from} to v${current}`} actions={<select className="input input-sm" value={from} onChange={(e) => setFrom(Number(e.target.value))} aria-label="Compare against">{others.map((o) => <option key={o.versionNo} value={o.versionNo}>v{o.versionNo} ({pretty(o.status)})</option>)}</select>} pad={false}>
      {diff.loading ? <Loading /> : diff.error ? <ErrorBox error={diff.error} /> : (
        <DataTable rows={diff.data?.changes ?? []} empty="The two versions are identical." cols={[
          { key: 'p', header: 'Setting', render: (c: any) => <code>{c.path}</code> },
          { key: 'b', header: `v${from}`, render: (c: any) => <span className="diff-old">{show(c.before)}</span> },
          { key: 'a', header: `v${current}`, render: (c: any) => <span className="diff-new">{show(c.after)}</span> },
        ]} />
      )}
    </Card>
  );
}

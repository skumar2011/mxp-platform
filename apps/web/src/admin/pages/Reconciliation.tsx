import { useState } from 'react';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, num, pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Button, Card, DataTable, ErrorBox, Field, Json, Loading, StatusBadge, Tabs, useToast } from '../../shared/ui';

export function Reconciliation() {
  const { can } = useAuth();
  const toast = useToast();
  const [runId, setRunId] = useState<string | undefined>();
  const q = useAsync(() => api<any>('/ops/reconciliation', { query: { runId } }), [runId]);
  const [tab, setTab] = useState<'internal' | 'source'>('internal');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const run = async () => { setBusy(true); try { const r: any = await api('/ops/reconcile', { body: {} }); setSummary(r); toast.ok(r.status === 'PASSED' ? 'Reconciliation passed.' : `${r.breaks.length} break(s) found.`); setRunId(undefined); q.reload(); } catch (e) { toast.err(e); } finally { setBusy(false); } };
  return (
    <>
      <PageHead title="Reconciliation" sub="Proves that rewards, progress, the transaction master and the audit trail agree with each other and with the source systems." actions={can('ops:write') && tab === 'internal' && <Button variant="primary" busy={busy} onClick={run}>Run reconciliation now</Button>} />
      <Tabs tabs={[{ id: 'internal', label: 'Internal integrity' }, { id: 'source', label: 'Source system control file' }]} value={tab} onChange={setTab} />
      {tab === 'source' ? <SourceRecon /> : (
        <>
          {summary && <Card title="Latest run: checks"><DataTable rows={summary.checks} cols={[{ key: 't', header: 'Check', render: (c: any) => pretty(c.type) }, { key: 'c', header: 'Items checked', align: 'right', render: (c: any) => num(c.checked) }, { key: 'b', header: 'Breaks', align: 'right', render: (c: any) => (c.breaks ? <strong className="err">{c.breaks}</strong> : 0) }]} /></Card>}
          <div style={{ height: 14 }} />
          <div className="grid g-main">
            <Card title="Breaks" pad={false}>
              {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
                <DataTable rows={q.data.breaks} empty={q.data.runs.length ? 'No breaks in this run. Everything agrees.' : 'No run yet. Run reconciliation to start.'} cols={[
                  { key: 't', header: 'Type', render: (b: any) => <StatusBadge status="ERROR" label={pretty(b.break_type)} /> }, { key: 'e', header: 'Entity', render: (b: any) => <code>{b.entity_ref}</code> },
                  { key: 'x', header: 'Expected', render: (b: any) => b.expected }, { key: 'a', header: 'Actual', render: (b: any) => b.actual }, { key: 'd', header: 'Detail', render: (b: any) => <small>{b.detail}</small> },
                ]} />
              )}
            </Card>
            <Card title="Runs" pad={false}>
              <DataTable rows={q.data?.runs ?? []} onRow={(r: any) => setRunId(r.run_id)} empty="None." cols={[
                { key: 'w', header: 'Started', render: (r: any) => dt(r.started_at) }, { key: 's', header: 'Result', render: (r: any) => <StatusBadge status={r.status} /> }, { key: 'b', header: 'Breaks', align: 'right', render: (r: any) => r.breaks },
              ]} />
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function SourceRecon() {
  const { can } = useAuth();
  const [source, setSource] = useState('CBS');
  const [csv, setCsv] = useState('sourceTxnId,amount,status\n');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const lines = csv.trim().split(/\r?\n/).slice(1).filter(Boolean);
      const entries = lines.map((l) => { const [sourceTxnId, amount, status] = l.split(',').map((x) => x.trim()); return { sourceTxnId, amount, status: status || undefined }; });
      setRes(await api('/ops/reconcile-source', { body: { sourceSystem: source, dateFrom: from || undefined, dateTo: to || undefined, entries } }));
    } catch (e) { setErr(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card title="Compare with a control file">
      <p className="muted" style={{ marginTop: 0 }}>Paste the source system's transaction list (CSV: id, amount, optional status). MXP marks each transaction matched or mismatched and reports gaps in both directions.</p>
      <div className="form-grid">
        <Field label="Source system"><input className="input" value={source} onChange={(e) => setSource(e.target.value.toUpperCase())} /></Field>
        <Field label="Completeness check from" hint="Optional: finds MXP transactions missing from the file"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="to"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Control file (CSV)" wide><textarea className="input mono" rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} /></Field>
      </div>
      <div style={{ marginTop: 12 }}>{can('ops:write') ? <Button variant="primary" busy={busy} onClick={run}>Reconcile</Button> : <Alert tone="info">Operations role required.</Alert>}</div>
      {err && <ErrorBox error={err} />}
      {res && <div style={{ marginTop: 14 }}><Alert tone={res.mismatched.length || res.missingInMxp.length || res.unexpectedInMxp.length ? 'warn' : 'ok'}>{res.matched} of {res.rows} matched · {res.mismatched.length} mismatched · {res.missingInMxp.length} missing in MXP · {res.unexpectedInMxp.length} unexpected in MXP</Alert><Json value={res} max={300} /></div>}
    </Card>
  );
}

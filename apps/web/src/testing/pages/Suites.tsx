import { useState } from 'react';
import { api, download, saveJson } from '../../shared/api';
import { dt, pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Badge, Button, Card, DataTable, ErrorBox, Loading, Modal, StatusBadge, Tabs, useToast } from '../../shared/ui';
import { ResultView } from '../ResultView';

export function Suites() {
  const toast = useToast();
  const [tab, setTab] = useState<'suites' | 'runs'>('suites');
  const suites = useAsync(() => api<{ suites: any[] }>('/sim/suites'), []);
  const runs = useAsync(() => api<{ runs: any[] }>('/sim/runs', { query: { limit: 100 } }), []);
  const [open, setOpen] = useState<string | null>(null);
  const [run, setRun] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const rerunAll = async () => { setBusy(true); try { const r: any = await api('/sim/suites/run', { body: { label: 'Full regression', mode: 'PINNED' } }); toast.ok(`${r.passed} of ${r.total} passed.`); suites.reload(); } catch (e) { toast.err(e); } finally { setBusy(false); } };
  const showRun = async (id: string) => { try { setRun(await api(`/sim/runs/${id}`)); } catch (e) { toast.err(e); } };
  return (
    <>
      <PageHead title="Regression runs" sub="Every run is kept, so you can prove a rule change did not break existing behaviour." actions={<Button variant="primary" busy={busy} onClick={rerunAll}>↻ Run full regression</Button>} />
      <Tabs tabs={[{ id: 'suites', label: 'Suite runs' }, { id: 'runs', label: 'Individual runs' }]} value={tab} onChange={setTab} />
      {tab === 'suites' ? (
        <Card pad={false}>
          {suites.loading && !suites.data ? <Loading /> : suites.error ? <ErrorBox error={suites.error} /> : (
            <DataTable rows={suites.data!.suites} onRow={(s: any) => setOpen(s.suite_run_id)} empty="No suite has been run yet." cols={[
              { key: 'w', header: 'Started', render: (s: any) => dt(s.started_at) }, { key: 'l', header: 'Label', render: (s: any) => s.label ?? '-' }, { key: 'm', header: 'Versions', className: 'hide-sm', render: (s: any) => pretty(s.version_mode) },
              { key: 'r', header: 'Result', render: (s: any) => (s.failed + s.errors === 0 ? <Badge tone="green">All {s.total} passed</Badge> : <Badge tone="red">{s.failed + s.errors} of {s.total} failed</Badge>) },
              { key: 'b', header: 'By', className: 'hide-sm', render: (s: any) => s.run_by },
            ]} />
          )}
        </Card>
      ) : (
        <Card pad={false}>
          {runs.loading && !runs.data ? <Loading /> : runs.error ? <ErrorBox error={runs.error} /> : (
            <DataTable rows={runs.data!.runs} onRow={(r: any) => showRun(r.run_id)} empty="No runs yet." cols={[
              { key: 'w', header: 'Started', render: (r: any) => dt(r.started_at) }, { key: 'n', header: 'Case', render: (r: any) => r.case_name }, { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
              { key: 'r', header: 'Rules', className: 'hide-sm', render: (r: any) => r.rules.map((x: any) => `${x.ruleCode} v${x.versionNo}`).join(', ') }, { key: 'd', header: 'ms', align: 'right', render: (r: any) => r.duration_ms },
            ]} />
          )}
        </Card>
      )}
      {open && <SuiteModal id={open} onClose={() => setOpen(null)} onRun={showRun} />}
      {run && <Modal wide title={`${run.case_name}: ${pretty(run.status)}`} onClose={() => setRun(null)}>{run.result ? <ResultView result={run.result} runId={run.run_id} name={run.case_name} /> : 'No stored result.'}</Modal>}
    </>
  );
}

function SuiteModal({ id, onClose, onRun }: { id: string; onClose: () => void; onRun: (id: string) => void }) {
  const toast = useToast();
  const q = useAsync(() => api<any>(`/sim/suites/${id}`), [id]);
  const d = q.data;
  return (
    <Modal wide title="Suite run" onClose={onClose} footer={d && <><Button onClick={() => saveJson(d, `suite-${id}.json`)}>Download JSON</Button><Button onClick={() => download(`/sim/suites/${id}/download`, { format: 'csv' }, 'suite.csv').catch(toast.err)}>Download CSV</Button></>}>
      {q.loading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
        <>
          <p><strong>{d.suite.passed} of {d.suite.total} passed</strong> · {d.suite.failed} failed · {d.suite.errors} errors · {dt(d.suite.started_at)} by {d.suite.run_by}</p>
          <DataTable rows={d.runs} onRow={(r: any) => onRun(r.run_id)} cols={[
            { key: 'n', header: 'Case', render: (r: any) => r.case_name }, { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'f', header: 'Failed checks', render: (r: any) => (r.checks.filter((c: any) => !c.pass).map((c: any) => <div key={c.name}><small className="err">{c.name}: expected {c.expected}, got {c.actual}</small></div>)) },
          ]} />
        </>
      )}
    </Modal>
  );
}

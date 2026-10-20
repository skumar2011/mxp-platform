import { useMemo, useRef, useState } from 'react';
import { runScenario, type Scenario, type ScenarioResult } from '@mxp/rules';
import { api, saveJson } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, pts } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { EvaluationList } from '../../shared/rules-ui';
import { Alert, Badge, Button, Card, DataTable, ErrorBox, Loading, Modal, StatusBadge, Tabs, useToast } from '../../shared/ui';
import { PackPicker, usePack } from '../pack';
import { acceptResults, recordRun, saveScenario, SKIPPED, type SavedScenario } from '../scenario-utils';

export function Scenarios() {
  const { engine, source, hash } = usePack();
  const { can } = useAuth();
  const toast = useToast();
  const list = useAsync(() => api<SavedScenario[]>('/test-scenarios'), []);
  const runs = useAsync(() => api<any[]>('/test-runs'), []);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Record<string, ScenarioResult>>({});
  const [open, setOpen] = useState<SavedScenario | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => (list.data ?? []).filter((s) => !q || `${s.name} ${s.focus_rule_code ?? ''} ${s.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())), [list.data, q]);

  const run = async (items: SavedScenario[]) => {
    if (!engine || !items.length) return;
    setBusy(true);
    const out: Record<string, ScenarioResult> = {};
    for (const s of items) out[s.scenario_id] = runScenario(engine, { ...s.definition, id: s.scenario_id });
    setResults((r) => ({ ...r, ...out }));
    const summary = items.map((s) => ({ scenarioId: s.scenario_id, name: s.name, passed: out[s.scenario_id].passed, failures: out[s.scenario_id].failures }));
    const failed = summary.filter((x) => !x.passed).length;
    if (can('tests:write')) {
      try { await recordRun(items.length === 1 ? 'SCENARIO' : 'SUITE', source, hash, summary); runs.reload(); list.reload(); } catch (e) { toast.err(e); }
    }
    toast[failed ? 'err' : 'ok'](`${items.length - failed} passed, ${failed} failed`);
    setBusy(false);
  };

  const importFile = async (f: File) => {
    try {
      const data = JSON.parse(await f.text());
      const items: Scenario[] = Array.isArray(data) ? data : Array.isArray(data.scenarios) ? data.scenarios : [data];
      for (const sc of items) await saveScenario(sc);
      toast.ok(`Imported ${items.length} scenario(s).`);
      list.reload();
    } catch (e) { toast.err(e); }
  };
  const remove = async (s: SavedScenario) => {
    if (!confirm(`Delete scenario "${s.name}"?`)) return;
    try { await api(`/test-scenarios/${encodeURIComponent(s.scenario_id)}`, { method: 'DELETE' }); setOpen(null); list.reload(); } catch (e) { toast.err(e); }
  };

  const done = rows.filter((s) => results[s.scenario_id]);
  const passed = done.filter((s) => results[s.scenario_id].passed).length;

  return (
    <div className="stack">
      <PageHead title="Regression scenarios" sub="Scripted customer journeys with expected outcomes, points and decisions. Run them against the live release, the drafts awaiting approval, or any pack file before it goes live."
        actions={<>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
          {can('tests:write') && <Button onClick={() => fileRef.current?.click()}>Import JSON</Button>}
          <Button disabled={!rows.length} onClick={() => saveJson(rows.map((s) => s.definition), 'mxp-scenarios.json')}>Export</Button>
          <Button variant="primary" busy={busy} disabled={!engine || !rows.length} onClick={() => run(rows)}>Run {q ? 'filtered' : 'all'} ({rows.length})</Button>
        </>} />
      <PackPicker />
      {done.length > 0 && (
        <Alert tone={passed === done.length ? 'ok' : 'err'}>
          <strong>{passed} / {done.length} passed</strong> against {source === 'FILE' ? 'the uploaded file' : source === 'OPEN' ? 'live + drafts' : 'the live release'} <code>{hash?.slice(0, 10)}</code>.
          {passed < done.length && ' Open a failed scenario to see which step changed; if the change is intended, accept the new results.'}
        </Alert>
      )}
      <Card pad={false} title={<input className="input" placeholder="Filter by name, rule or tag" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} retry={list.reload} /> : (
          <DataTable rows={rows} rowKey={(s) => s.scenario_id} onRow={setOpen} empty="No scenarios yet. Record one in the simulator or generate boundary cases in the matrix." cols={[
            { key: 'n', header: 'Scenario', render: (s) => <><strong>{s.name}</strong>{s.description && <div className="muted" style={{ fontSize: 12 }}>{s.description}</div>}</> },
            { key: 'r', header: 'Focus rule', render: (s) => s.focus_rule_code ? <code>{s.focus_rule_code}</code> : <span className="muted">all</span> },
            { key: 't', header: 'Tags', render: (s) => <div className="chips">{s.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div> },
            { key: 'st', header: 'Steps', align: 'right', render: (s) => s.definition.steps.length },
            { key: 'l', header: 'Last recorded run', render: (s) => s.last_status ? <><StatusBadge status={s.last_status} /> <span className="muted">{dt(s.last_run_at)}</span></> : <span className="muted">never</span> },
            { key: 'now', header: 'This session', render: (s) => { const r = results[s.scenario_id]; return r ? <><StatusBadge status={r.passed ? 'PASSED' : 'FAILED'} /> <span className="muted">{pts(r.totalPoints)} pts · {r.durationMs} ms</span></> : null; } },
            { key: 'a', header: '', align: 'right', render: (s) => <Button small disabled={!engine} onClick={(e) => { e.stopPropagation(); run([s]); }}>Run</Button> },
          ]} />
        )}
      </Card>
      <Card title="Recent runs" pad={false}>
        <DataTable rows={(runs.data ?? []).slice(0, 15)} rowKey={(r) => r.run_id} empty="No runs recorded." cols={[
          { key: 'w', header: 'When', render: (r) => dt(r.run_at) },
          { key: 'k', header: 'Kind', render: (r) => <Badge>{r.run_kind}</Badge> },
          { key: 's', header: 'Pack', render: (r) => <>{r.pack_source} <code>{(r.pack_hash ?? '').slice(0, 10)}</code></> },
          { key: 'p', header: 'Result', render: (r) => <><Badge tone="green">{r.passed} passed</Badge> {r.failed > 0 && <Badge tone="red">{r.failed} failed</Badge>}</> },
          { key: 'b', header: 'By', render: (r) => r.run_by },
        ]} />
      </Card>
      {open && <ScenarioModal s={open} result={results[open.scenario_id]} onClose={() => setOpen(null)} onRun={() => run([open])} onDelete={() => remove(open)}
        onSaved={(s) => { setOpen(s); list.reload(); setResults((r) => { const x = { ...r }; delete x[s.scenario_id]; return x; }); }} canWrite={can('tests:write')} />}
    </div>
  );
}

function ScenarioModal({ s, result, onClose, onRun, onDelete, onSaved, canWrite }: { s: SavedScenario; result?: ScenarioResult; onClose: () => void; onRun: () => void; onDelete: () => void; onSaved: (s: SavedScenario) => void; canWrite: boolean }) {
  const toast = useToast();
  const [tab, setTab] = useState<'steps' | 'json'>('steps');
  const [text, setText] = useState(() => JSON.stringify(s.definition, null, 2));
  const [busy, setBusy] = useState(false);
  const save = async (sc: Scenario) => {
    setBusy(true);
    try { const saved = await saveScenario({ ...sc, id: s.scenario_id }); toast.ok('Scenario saved.'); setText(JSON.stringify(saved.definition, null, 2)); onSaved(saved); } catch (e) { toast.err(e); }
    setBusy(false);
  };
  const saveText = () => { try { save(JSON.parse(text)); } catch (e) { toast.err(`Invalid JSON: ${(e as Error).message}`); } };
  const sc = s.definition;
  return (
    <Modal wide title={<>{s.name} {result && <StatusBadge status={result.passed ? 'PASSED' : 'FAILED'} />}</>} onClose={onClose} footer={<>
      {canWrite && <Button variant="danger" onClick={onDelete}>Delete</Button>}
      <span className="grow" />
      {canWrite && result && !result.passed && <Button busy={busy} onClick={() => save(acceptResults(sc, result))} title="Rewrite the expectations with what the current pack produced">Accept current results</Button>}
      {canWrite && tab === 'json' && <Button busy={busy} onClick={saveText}>Save JSON</Button>}
      <Button onClick={() => saveJson(sc, `${s.scenario_id}.json`)}>Download</Button>
      <Button variant="primary" onClick={onRun}>Run</Button>
    </>}>
      <div className="stack">
        <div className="muted">Customer <code>{sc.customer.id}</code> · segment {String(sc.customer.segment ?? '-')} · {String(sc.customer.timezone ?? 'pack timezone')}
          {sc.settings?.length ? <> · settings {sc.settings.map((x) => `${x.ruleCode} ${JSON.stringify(x.values)}`).join(', ')}</> : null}
          {sc.enrollments?.length ? <> · enrolled {sc.enrollments.join(', ')}</> : null}
          {sc.expect?.totalPoints !== undefined && <> · expects {pts(sc.expect.totalPoints)} pts in total</>}
        </div>
        {result && !result.passed && <Alert tone="err"><ul style={{ margin: 0 }}>{result.failures.map((f, i) => <li key={i}>{f}</li>)}</ul></Alert>}
        <Tabs tabs={[{ id: 'steps', label: 'Steps' }, { id: 'json', label: 'JSON' }]} value={tab} onChange={setTab} />
        {tab === 'json' ? <textarea className="input code" rows={24} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /> : (
          <div className="timeline">
            {sc.steps.map((st, i) => {
              const r = result?.steps[i];
              const ex = 'expect' in st ? st.expect : undefined;
              return (
                <div key={i} className={`tl-item ${r ? (r.failures.length ? 'bad' : 'ok') : ''}`}>
                  <div className="row gap wrap">
                    <strong>#{i + 1} {st.kind}</strong>{st.label && <span>{st.label}</span>}
                    {'event' in st && <span className="muted">{st.event.type} {st.event.amount !== undefined ? `₹${st.event.amount}` : ''} {dt(st.event.timestamp)}</span>}
                    {st.kind === 'close' && <span className="muted">as of {st.asOf}</span>}
                    {st.kind === 'setting' && <span className="muted">{st.setting.ruleCode} {JSON.stringify(st.setting.values)} from {st.setting.effectiveFrom ?? 'start'}</span>}
                    {st.kind === 'enroll' && <span className="muted">{st.ruleCode}</span>}
                    <span className="grow" />
                    {r?.result && <StatusBadge status={r.result.decision} />}
                    {r && r.points !== 0 && <Badge tone={r.points > 0 ? 'green' : 'red'}>{pts(r.points)}</Badge>}
                  </div>
                  {ex && <div className="muted" style={{ fontSize: 12 }}>expects {[ex.outcomes && Object.entries(ex.outcomes).map(([k, v]) => `${k} ${v}`).join(', '), ex.decision && `decision ${ex.decision}`, ex.points !== undefined && `${ex.points} pts`].filter(Boolean).join(' · ')}</div>}
                  {r?.failures.map((f, k) => <div key={k} style={{ color: 'var(--red)', fontSize: 12.5 }}>✗ {f}</div>)}
                  {r?.result && <div style={{ marginTop: 6 }}><EvaluationList items={r.result.evaluations.filter((e) => !SKIPPED.has(e.outcome) && (!sc.focusRule || e.ruleCode === sc.focusRule))} /></div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

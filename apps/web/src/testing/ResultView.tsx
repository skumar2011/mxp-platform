import { useState } from 'react';
import { download, saveJson } from '../shared/api';
import { dt, num, pretty, pts } from '../shared/format';
import { TraceView } from '../shared/trace';
import { Alert, Badge, Button, Card, DataTable, Json, KeyVal, Stat, StatusBadge, Tabs, useToast } from '../shared/ui';

const prog = (p: any) => `${p.periodKey}: ${num(p.metric)} · tier ${p.achievedTier} · ${pretty(p.status)}`;

/** Full explanation of one simulation: checks, per-step decisions with traces, final state and downloads. */
export function ResultView({ result, runId, name }: { result: any; runId?: string | null; name?: string }) {
  const toast = useToast();
  const [tab, setTab] = useState<'checks' | 'steps' | 'final' | 'log'>(result?.checks?.length ? 'checks' : 'steps');
  if (!result) return null;
  if (!result.ok) return <Alert tone="err"><strong>{result.error?.message ?? 'The simulation failed.'}</strong>{result.error?.details ? <Json value={result.error.details} max={200} /> : null}</Alert>;
  const f = result.final;
  const failed = result.checks.filter((c: any) => !c.pass);
  return (
    <div className="stack">
      <div className="row gap wrap between">
        <div className="row gap wrap">
          {result.passed === null ? <Badge tone="gray">No expectations set</Badge> : result.passed ? <Badge tone="green">PASSED · {result.checks.length} checks</Badge> : <Badge tone="red">FAILED · {failed.length} of {result.checks.length} checks</Badge>}
          <span className="muted">{result.durationMs} ms · isolated sandbox · production untouched</span>
        </div>
        <div className="row gap">
          <Button small onClick={() => saveJson(result, `${(name ?? result.name ?? 'simulation').replace(/\W+/g, '-')}.json`)}>Download JSON</Button>
          {runId && <Button small onClick={() => download(`/sim/runs/${runId}/download`, { format: 'csv' }, 'run.csv').catch(toast.err)}>Download CSV</Button>}
        </div>
      </div>
      <div className="grid g4">
        <Stat label="Total XP" value={num(f.totalPoints)} tone={f.totalPoints > 0 ? 'green' : undefined} />
        <Stat label="Awards / reversals" value={`${f.awards} / ${f.reversals}`} />
        <Stat label="Duplicate awards" value={f.duplicateAwards} tone={f.duplicateAwards ? 'red' : 'green'} sub={f.duplicateAwards ? 'defect!' : 'none'} />
        <Stat label="Events" value={Object.values(f.events as Record<string, number>).reduce((a, b) => a + b, 0)} sub={`${f.rejected} rejected · ${f.duplicates} duplicates`} />
      </div>
      <div className="muted">Rules under test: {result.rules.map((r: any) => <Badge key={r.ruleCode} tone={r.draft ? 'amber' : 'blue'}>{r.ruleCode} v{r.versionNo}{r.draft ? ' (draft)' : ''}</Badge>)} · results as of {f.asOf}</div>
      <Tabs tabs={[{ id: 'checks', label: `Expected vs actual (${result.checks.length})` }, { id: 'steps', label: `Step by step (${result.steps.length})` }, { id: 'final', label: 'Final state' }, { id: 'log', label: 'Run log' }]} value={tab} onChange={setTab} />

      {tab === 'checks' && (
        <Card pad={false}>
          <DataTable rows={result.checks} empty="No expectations were defined. Add expected results to turn this run into a pass/fail test." cols={[
            { key: 'r', header: '', render: (c: any) => (c.pass ? <span className="trace-ok">✔</span> : <span className="trace-no">✘</span>) },
            { key: 'n', header: 'Check', render: (c: any) => c.name }, { key: 'e', header: 'Expected', render: (c: any) => <code>{c.expected}</code> }, { key: 'a', header: 'Actual', render: (c: any) => <code className={c.pass ? '' : 'err'}>{c.actual}</code> },
          ]} />
        </Card>
      )}

      {tab === 'steps' && result.steps.map((s: any) => <StepCard key={s.index} s={s} />)}

      {tab === 'final' && (
        <div className="stack">
          <Card title="Progress at the end" pad={false}><DataTable rows={f.progress} empty="No goal progress." cols={[
            { key: 'r', header: 'Rule', render: (p: any) => `${p.ruleCode} v${p.versionNo}` }, { key: 'p', header: 'Period', render: (p: any) => <code>{p.periodKey}</code> }, { key: 's', header: 'Status', render: (p: any) => <StatusBadge status={p.status} /> },
            { key: 'm', header: 'Metric', align: 'right', render: (p: any) => num(p.metric) }, { key: 'c', header: 'Txns', align: 'right', render: (p: any) => p.count }, { key: 't', header: 'Tier', align: 'right', render: (p: any) => p.achievedTier }, { key: 'n', header: 'Note', render: (p: any) => <small>{p.note ?? ''}</small> },
          ]} /></Card>
          <Card title="XP ledger produced" pad={false}><DataTable rows={f.ledger} empty="No XP was issued." cols={[
            { key: 'i', header: '#', render: (l: any) => l.ledgerId }, { key: 'r', header: 'Rule', render: (l: any) => l.ruleCode ?? '-' }, { key: 't', header: 'Type', render: (l: any) => <StatusBadge status={l.type} /> },
            { key: 's', header: 'Slot', render: (l: any) => <code>{l.slot}</code> }, { key: 'p', header: 'XP', align: 'right', render: (l: any) => <strong>{pts(l.points)}</strong> }, { key: 'x', header: 'Reason', render: (l: any) => <small>{l.text ?? l.reason}</small> },
          ]} /></Card>
          <Card title="Nudges" pad={false}><DataTable rows={f.nudges} empty="No nudges." cols={[
            { key: 't', header: 'Type', render: (n: any) => pretty(n.type) }, { key: 'c', header: 'Channel', render: (n: any) => n.channel }, { key: 's', header: 'Status', render: (n: any) => <><StatusBadge status={n.status} />{n.suppressReason && <small className="muted"> {n.suppressReason}</small>}</> }, { key: 'm', header: 'Message', render: (n: any) => <small>{n.message}</small> },
          ]} /></Card>
        </div>
      )}
      {tab === 'log' && <Json value={result.log} max={400} />}
    </div>
  );
}

function StepCard({ s }: { s: any }) {
  const [open, setOpen] = useState(false);
  const delta = s.evaluations.reduce((a: number, e: any) => a + (e.pointsDelta ?? 0), 0);
  return (
    <Card pad={false} title={<><Badge tone="violet">{s.index + 1}. {s.kind}</Badge> <span style={{ fontWeight: 500 }}>{s.label ?? s.description}</span></>} actions={<><span className="muted">{dt(s.at)}</span>{delta !== 0 && <Badge tone={delta > 0 ? 'green' : 'red'}>{pts(delta)} XP</Badge>}<Button small onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} details</Button></>}>
      <div className="card-b">
        {s.ingest.map((i: any, k: number) => <div key={k}><StatusBadge status={i.status} /> <small className="muted">{i.sourceEventId} {i.errors?.map((e: any) => `${e.code}: ${e.message}`).join('; ')}</small></div>)}
        {s.evaluations.length === 0 && <div className="muted">No rule evaluated this step.</div>}
        {s.evaluations.map((e: any, i: number) => (
          <div key={i} style={{ marginTop: 8 }}>
            <div className="row gap wrap"><strong>{e.ruleCode}</strong><StatusBadge status={e.outcome} />{e.pointsDelta !== 0 && <strong className={e.pointsDelta < 0 ? 'err' : ''}>{pts(e.pointsDelta)} XP</strong>}<span className="muted">{e.reasonText}</span></div>
            {open && <div style={{ marginLeft: 12, marginTop: 6, borderLeft: '2px solid var(--line)', paddingLeft: 12 }}><TraceView trace={e.trace} /></div>}
          </div>
        ))}
        {(s.progressBefore.length > 0 || s.progressAfter.length > 0) && (
          <div className="grid g2" style={{ marginTop: 10 }}>
            <div><div className="muted" style={{ fontSize: 12 }}>PROGRESS BEFORE</div>{s.progressBefore.length ? s.progressBefore.map((p: any, i: number) => <div key={i}><small>{p.ruleCode} {prog(p)}</small></div>) : <small className="muted">none</small>}</div>
            <div><div className="muted" style={{ fontSize: 12 }}>PROGRESS AFTER</div>{s.progressAfter.map((p: any, i: number) => <div key={i}><small>{p.ruleCode} {prog(p)}</small></div>)}</div>
          </div>
        )}
        {s.nudges.length > 0 && <div style={{ marginTop: 8 }}>{s.nudges.map((n: any, i: number) => <div key={i}><Badge tone="blue">{pretty(n.type)}</Badge> <StatusBadge status={n.status} /> <small>{n.message}</small></div>)}</div>}
        {open && s.ledger.length > 0 && <KeyVal items={s.ledger.map((l: any) => [`#${l.ledgerId} ${l.type}`, `${pts(l.points)} · ${l.slot} · ${l.text ?? l.reason}`] as [string, string])} />}
      </div>
    </Card>
  );
}

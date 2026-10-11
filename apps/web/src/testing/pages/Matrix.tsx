import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, saveJson } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Badge, Button, Card, Field, KeyVal, Loading, Modal, StatusBadge, Stat, useToast } from '../../shared/ui';
import { CATEGORY_TONE, handoff } from '../common';

export function Matrix() {
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const rules = useAsync(() => api<{ rules: any[] }>('/sim/rules'), []);
  const [code, setCode] = useState(sp.get('rule') ?? '');
  const [ver, setVer] = useState<string>(sp.get('v') ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [m, setM] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const [filter, setFilter] = useState<string>('ALL');
  const rule = rules.data?.rules.find((r) => r.ruleCode === code);
  useEffect(() => { setM(null); }, [code, ver]);

  const go = async (save: boolean) => {
    setBusy(save ? 'save' : 'run');
    try { setM(await api('/sim/matrix', { body: { rule: { ruleCode: code, versionNo: ver ? Number(ver) : undefined }, run: true, save } })); if (save) toast.ok('Scenarios saved to the test case library.'); } catch (e) { toast.err(e); } finally { setBusy(null); }
  };
  const cats = m ? [...new Set<string>(m.cases.map((c: any) => c.category))] : [];
  const shown = m ? m.cases.filter((c: any) => filter === 'ALL' || (filter === 'FAILED' ? c.result?.status !== 'PASSED' : c.category === filter)) : [];

  return (
    <>
      <PageHead title="Scenario matrix" sub="One click generates the positive, negative, boundary, duplicate, reversal, refund, status, period, cap, data and eligibility cases for a rule, with expectations worked out from the rule's own definition." />
      <Card>
        <div className="row gap wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Rule"><select className="input" style={{ minWidth: 280 }} value={code} onChange={(e) => { setCode(e.target.value); setVer(''); }}><option value="">Choose a rule...</option>{rules.data?.rules.map((r) => <option key={r.ruleCode} value={r.ruleCode}>{r.ruleCode} - {r.name}</option>)}</select></Field>
          <Field label="Version"><select className="input" value={ver} onChange={(e) => setVer(e.target.value)} disabled={!rule}><option value="">Live{rule?.liveVersionNo ? ` (v${rule.liveVersionNo})` : ' / latest'}</option>{rule?.versions.map((v: any) => <option key={v.versionNo} value={v.versionNo}>v{v.versionNo} · {pretty(v.status)}</option>)}</select></Field>
          <Button variant="primary" disabled={!code} busy={busy === 'run'} onClick={() => go(false)}>▶ Generate and run</Button>
          {can('testcases:write') && <Button disabled={!code} busy={busy === 'save'} onClick={() => go(true)}>Generate, run and save to library</Button>}
        </div>
      </Card>
      {rules.loading && <Loading />}
      {m && (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="grid g4">
            <Stat label="Scenarios" value={m.suite.total} sub={`${m.ruleCode} v${m.versionNo}`} />
            <Stat label="Passed" value={m.suite.passed} tone="green" />
            <Stat label="Failed" value={m.suite.failed} tone={m.suite.failed ? 'red' : undefined} />
            <Stat label="Errors" value={m.suite.errors} tone={m.suite.errors ? 'red' : undefined} />
          </div>
          {m.notes.length > 0 && <Alert tone="info">{m.notes.map((n: string, i: number) => <div key={i}>{n}</div>)}</Alert>}
          <Card title="Matrix" actions={<>
            <select className="input input-sm" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter"><option value="ALL">All categories</option><option value="FAILED">Only failures</option>{cats.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}</select>
            <Button small onClick={() => saveJson(m, `matrix-${m.ruleCode}-v${m.versionNo}.json`)}>Download JSON</Button></>}>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
              {shown.map((c: any) => {
                const st = c.result?.status;
                return (
                  <button key={c.id} onClick={() => setOpen(c)} className="card" style={{ textAlign: 'left', cursor: 'pointer', padding: 12, borderLeft: `4px solid ${st === 'PASSED' ? 'var(--green)' : st ? 'var(--red)' : 'var(--line)'}` }}>
                    <div className="row between"><Badge tone={CATEGORY_TONE[c.category] ?? 'gray'}>{c.category}</Badge><StatusBadge status={st} /></div>
                    <div style={{ marginTop: 6, fontWeight: 600 }}>{c.name}</div>
                    <small className="muted">{c.description}</small>
                  </button>
                );
              })}
            </div>
          </Card>
        </div>
      )}
      {open && (
        <Modal wide title={open.name} onClose={() => setOpen(null)} footer={<Button variant="primary" onClick={() => { handoff.put({ input: { name: open.name, rules: open.rules, scenario: open.scenario, expected: open.expected } }); nav('/playground'); }}>Open in playground</Button>}>
          <p>{open.description}</p>
          <KeyVal items={[['Category', open.category], ['Steps', open.scenario.steps.length], ['Result', <StatusBadge key="r" status={open.result?.status} />], ['Run time', open.result?.durationMs ? `${open.result.durationMs} ms` : '-']]} />
          <h3 style={{ margin: '14px 0 6px' }}>Expected</h3>
          <pre className="json">{JSON.stringify(open.expected, null, 2)}</pre>
          {open.result?.failedChecks?.length > 0 && <><h3 style={{ margin: '14px 0 6px' }}>What did not match</h3>{open.result.failedChecks.map((c: any, i: number) => <Alert key={i} tone="err"><strong>{c.name}</strong>: expected {c.expected}, got {c.actual}</Alert>)}</>}
        </Modal>
      )}
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, saveJson } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { PageHead } from '../../shared/Layout';
import { loadMeta, type Meta } from '../../shared/meta';
import { useAsync } from '../../shared/hooks';
import { Alert, Badge, Button, Card, DataTable, ErrorBox, Field, Loading, Modal, Tabs, useToast } from '../../shared/ui';
import { CATEGORIES, blankInput, handoff, type RuleRef, type SimInput } from '../common';
import { Expectations, fromExpected, toExpected, type ExpRow } from '../Expectations';
import { ResultView } from '../ResultView';
import { StepEditor, describeStep } from '../StepEditor';

export function Playground() {
  const toast = useToast();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const meta = useAsync<Meta>(loadMeta, []);
  const rules = useAsync(() => api<{ rules: any[] }>('/sim/rules'), []);
  const [input, setInput] = useState<SimInput>(blankInput());
  const [rows, setRows] = useState<ExpRow[]>([]);
  const [tab, setTab] = useState<'builder' | 'json'>('builder');
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [caseId, setCaseId] = useState<string | undefined>();
  const [editing, setEditing] = useState<{ index: number | null; step?: any } | null>(null);
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<{ result: any; runId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [defText, setDefText] = useState<Record<number, string>>({});
  const resultRef = useRef<HTMLDivElement>(null);

  // Load from another page, a saved case, or a rule deep link.
  useEffect(() => {
    const h = handoff.take();
    if (h) { setInput(h.input); setRows(fromExpected(h.input.expected)); setCaseId(h.caseId); return; }
    const rule = sp.get('rule');
    if (rule) setInput((i) => ({ ...i, rules: [{ ruleCode: rule, versionNo: sp.get('v') ? Number(sp.get('v')) : undefined }] }));
  }, [sp]);

  const ruleCodes = useMemo(() => [...new Set(input.rules.map((r) => r.ruleCode))], [input.rules]);
  const full = (): SimInput => ({ ...input, expected: toExpected(rows) });
  const patchScenario = (p: any) => setInput((i) => ({ ...i, scenario: { ...i.scenario, ...p } }));
  const patchCustomer = (p: any) => patchScenario({ customer: { ...input.scenario.customer, ...p } });

  if (meta.loading || rules.loading) return <Loading />;
  if (meta.error || !meta.data) return <ErrorBox error={meta.error} retry={meta.reload} />;
  const m = meta.data;
  const sc = input.scenario;
  const selectable = rules.data?.rules ?? [];

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<any>('/sim/run', { body: { input: full() } });
      setResult(r);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    } catch (e) { toast.err(e); } finally { setBusy(false); }
  };

  const whatIf = async (i: number) => {
    const r = input.rules[i];
    const meta0 = selectable.find((x) => x.ruleCode === r.ruleCode);
    const v = r.versionNo ?? meta0?.liveVersionNo ?? meta0?.versions[0]?.versionNo;
    try {
      const full = await api<any>(`/rules/${r.ruleCode}/versions/${v}`);
      setRule(i, { definition: full.def, versionNo: undefined });
      setDefText({ ...defText, [i]: JSON.stringify(full.def, null, 2) });
    } catch (e) { toast.err(e); }
  };
  const setRule = (i: number, p: Partial<RuleRef>) => setInput((x) => ({ ...x, rules: x.rules.map((r, j) => (j === i ? { ...r, ...p } : r)) }));
  const setSteps = (steps: any[]) => patchScenario({ steps });

  const applyJson = () => {
    try { const p = JSON.parse(jsonText); setInput({ ...blankInput(), ...p, scenario: { ...blankInput().scenario, ...p.scenario } }); setRows(fromExpected(p.expected)); setJsonErr(null); setTab('builder'); } catch (e) { setJsonErr((e as Error).message); }
  };

  return (
    <>
      <PageHead title="Playground" sub="Build a customer story (transactions, balances, reversals, duplicates) and see exactly what each rule decides. Runs in an isolated sandbox."
        actions={<>
          <Button onClick={() => { setInput(blankInput()); setRows([]); setResult(null); setCaseId(undefined); }}>New</Button>
          {can('testcases:write') && <Button onClick={() => setSaveOpen(true)}>{caseId ? 'Save case…' : 'Save as test case…'}</Button>}
          <Button variant="primary" busy={busy} disabled={!input.rules.length && !input.includeActive} onClick={run}>▶ Run simulation</Button>
        </>} />
      <Tabs tabs={[{ id: 'builder', label: 'Builder' }, { id: 'json', label: 'Scenario JSON' }]} value={tab} onChange={(t) => { if (t === 'json') setJsonText(JSON.stringify(full(), null, 2)); setTab(t); }} />

      {tab === 'json' ? (
        <Card title="Scenario JSON (same format the API and saved cases use)" actions={<><Button small onClick={() => saveJson(full(), 'scenario.json')}>Download</Button><Button small variant="primary" onClick={applyJson}>Apply to builder</Button></>}>
          {jsonErr && <Alert tone="err">{jsonErr}</Alert>}
          <textarea className="input mono" rows={30} value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} aria-label="Scenario JSON" />
        </Card>
      ) : (
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <div className="stack">
            <Card title="1. Rules to test" actions={<label className="check"><input type="checkbox" checked={!!input.includeActive} onChange={(e) => setInput({ ...input, includeActive: e.target.checked })} /> also run all live rules</label>}>
              {input.rules.length === 0 && <p className="muted" style={{ marginTop: 0 }}>Choose one or more rules. Several rules together test conflicts, caps and overlaps.</p>}
              {input.rules.map((r, i) => {
                const meta0 = selectable.find((x) => x.ruleCode === r.ruleCode);
                return (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div className="row gap wrap">
                      <select className="input" style={{ flex: '2 1 200px' }} value={r.ruleCode} onChange={(e) => setRule(i, { ruleCode: e.target.value, versionNo: undefined, definition: undefined })} aria-label="Rule">
                        <option value="">Choose a rule...</option>{selectable.map((x) => <option key={x.ruleCode} value={x.ruleCode}>{x.ruleCode} - {x.name}</option>)}</select>
                      <select className="input" style={{ flex: '1 1 150px' }} value={r.definition ? 'whatif' : r.versionNo ?? ''} disabled={!!r.definition} onChange={(e) => setRule(i, { versionNo: e.target.value ? Number(e.target.value) : undefined })} aria-label="Version">
                        <option value="">Live version{meta0?.liveVersionNo ? ` (v${meta0.liveVersionNo})` : ''}</option>
                        {meta0?.versions.map((v: any) => <option key={v.versionNo} value={v.versionNo}>v{v.versionNo} · {v.status.toLowerCase().replace(/_/g, ' ')}</option>)}
                        {r.definition && <option value="whatif">What-if (unsaved)</option>}</select>
                      <Button small disabled={!r.ruleCode || !!r.definition} onClick={() => whatIf(i)} title="Copy this version's definition so you can tweak it without saving">What-if…</Button>
                      <Button small variant="ghost" onClick={() => setInput({ ...input, rules: input.rules.filter((_, j) => j !== i) })} aria-label="Remove rule">✕</Button>
                    </div>
                    {r.definition !== undefined && (
                      <div style={{ marginTop: 6 }}>
                        <textarea className="input mono" rows={10} value={defText[i] ?? JSON.stringify(r.definition, null, 2)} onChange={(e) => { setDefText({ ...defText, [i]: e.target.value }); try { setRule(i, { definition: JSON.parse(e.target.value) }); } catch { /* keep typing */ } }} spellCheck={false} aria-label="What-if definition" />
                        <small className="muted">Edit thresholds, points or conditions. Nothing is saved to the rule.</small>{' '}
                        <Button small variant="ghost" onClick={() => setRule(i, { definition: undefined })}>Discard what-if</Button>
                      </div>
                    )}
                  </div>
                );
              })}
              <Button small onClick={() => setInput({ ...input, rules: [...input.rules, { ruleCode: '' }] })}>+ Add rule</Button>
            </Card>

            <Card title="2. Test customer">
              <div className="form-grid">
                <Field label="Customer type"><select className="input" value={sc.customer?.type} onChange={(e) => patchCustomer({ type: e.target.value })}><option>RETAIL</option><option>SME</option><option>CORPORATE</option></select></Field>
                <Field label="KYC"><select className="input" value={sc.customer?.kycStatus} onChange={(e) => patchCustomer({ kycStatus: e.target.value })}><option>FULL</option><option>MINIMAL</option><option>PENDING</option></select></Field>
                <Field label="Status"><select className="input" value={sc.customer?.status} onChange={(e) => patchCustomer({ status: e.target.value })}><option>ACTIVE</option><option>INACTIVE</option><option>BLOCKED</option><option>CLOSED</option></select></Field>
                <Field label="Nudge consent"><label className="check"><input type="checkbox" checked={sc.customer?.nudgeConsent !== false} onChange={(e) => patchCustomer({ nudgeConsent: e.target.checked })} /> Customer agreed to nudges</label></Field>
                <Field label="Segments" wide><div className="row wrap" style={{ gap: '4px 12px' }}>{m.reference.segments.map((s) => (
                  <label key={s.code} className="check"><input type="checkbox" checked={(sc.customer?.segments ?? []).includes(s.code)} onChange={(e) => patchCustomer({ segments: e.target.checked ? [...(sc.customer?.segments ?? []), s.code] : (sc.customer?.segments ?? []).filter((x: string) => x !== s.code) })} />{s.code}</label>))}</div></Field>
                <Field label="Scenario time zone"><input className="input" value={sc.timezone ?? 'Asia/Kolkata'} onChange={(e) => patchScenario({ timezone: e.target.value })} /></Field>
                <Field label="Take results as of" hint="Blank = the last step. Periods are closed on this date."><input className="input" type="date" value={sc.asOf ?? ''} onChange={(e) => patchScenario({ asOf: e.target.value || undefined })} /></Field>
              </div>
            </Card>

            <Card title="3. Accounts">
              <DataTable rows={sc.accounts} empty="No accounts." cols={[
                { key: 'r', header: 'Reference', render: (a: any) => <input className="input input-sm mono" value={a.ref} onChange={(e) => patchScenario({ accounts: sc.accounts.map((x: any) => (x === a ? { ...a, ref: e.target.value } : x)) })} aria-label="Account ref" /> },
                { key: 'p', header: 'Product', render: (a: any) => <select className="input input-sm" value={a.productCode} onChange={(e) => patchScenario({ accounts: sc.accounts.map((x: any) => (x === a ? { ...a, productCode: e.target.value } : x)) })} aria-label="Product">{m.reference.products.map((p) => <option key={p.code} value={p.code}>{p.code} ({p.family})</option>)}</select> },
                { key: 's', header: 'Status', render: (a: any) => <select className="input input-sm" value={a.status ?? 'ACTIVE'} onChange={(e) => patchScenario({ accounts: sc.accounts.map((x: any) => (x === a ? { ...a, status: e.target.value } : x)) })} aria-label="Account status"><option>ACTIVE</option><option>DORMANT</option><option>FROZEN</option><option>CLOSED</option></select> },
                { key: 'o', header: 'Opened', render: (a: any) => <input className="input input-sm" type="date" value={a.openedOn ?? ''} onChange={(e) => patchScenario({ accounts: sc.accounts.map((x: any) => (x === a ? { ...a, openedOn: e.target.value || undefined } : x)) })} aria-label="Opened on" /> },
                { key: 'x', header: '', render: (a: any) => <Button small variant="ghost" onClick={() => patchScenario({ accounts: sc.accounts.filter((x: any) => x !== a) })}>✕</Button> },
              ]} />
              <div style={{ marginTop: 8 }}><Button small onClick={() => patchScenario({ accounts: [...sc.accounts, { ref: `ACC-${sc.accounts.length + 1}`, productCode: m.reference.products[0]?.code ?? 'SAV_REGULAR' }] })}>+ Add account</Button></div>
            </Card>
          </div>

          <div className="stack">
            <Card title={`4. What happens (${sc.steps.length} steps)`} actions={<Button small variant="primary" onClick={() => setAdding(true)}>+ Add step</Button>}>
              <DataTable rows={sc.steps.map((s: any, i: number) => ({ s, i }))} empty="Add transactions, balances, reversals or period closes." cols={[
                { key: 'n', header: '#', render: ({ i }) => i + 1 },
                { key: 'k', header: 'Step', render: ({ s }) => <><Badge tone={s.kind === 'TXN' ? 'blue' : s.kind === 'BALANCE' ? 'green' : s.kind === 'CLOSE' ? 'gray' : 'red'}>{s.kind}</Badge> <small>{s.label ?? describeStep(s)}</small></> },
                { key: 'a', header: '', render: ({ s, i }) => (
                  <div className="row" style={{ gap: 2 }}>
                    <Button small variant="ghost" disabled={i === 0} onClick={() => { const a = [...sc.steps]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; setSteps(a); }} aria-label="Move up">↑</Button>
                    <Button small variant="ghost" disabled={i === sc.steps.length - 1} onClick={() => { const a = [...sc.steps]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; setSteps(a); }} aria-label="Move down">↓</Button>
                    <Button small variant="ghost" onClick={() => setEditing({ index: i, step: s })}>Edit</Button>
                    <Button small variant="ghost" onClick={() => setSteps(sc.steps.filter((_: any, j: number) => j !== i))} aria-label="Delete">✕</Button>
                  </div>) },
              ]} />
              <p className="muted" style={{ marginBottom: 0 }}>Steps run in time order. Use <em>redeliver</em> to test duplicates and <em>arrives late</em> to test late data.</p>
            </Card>
            <Card title="5. Expected results (optional)">
              <Expectations rows={rows} onChange={setRows} ruleCodes={ruleCodes} />
            </Card>
          </div>
        </div>
      )}

      <div ref={resultRef} style={{ marginTop: 20 }}>
        {result && <Card title="Result"><ResultView result={result.result} runId={result.runId} name={input.name} /></Card>}
      </div>

      {(adding || editing) && (
        <StepEditor meta={m} accounts={sc.accounts} steps={sc.steps} initial={editing?.step}
          onSave={(added) => { if (editing && editing.index !== null) setSteps(sc.steps.map((s: any, i: number) => (i === editing.index ? added[0] : s))); else setSteps([...sc.steps, ...added]); }}
          onClose={() => { setAdding(false); setEditing(null); }} />
      )}
      {saveOpen && <SaveCase input={full()} caseId={caseId} onClose={() => setSaveOpen(false)} onSaved={(id) => { setCaseId(id); setSaveOpen(false); toast.ok('Test case saved.'); }} />}
    </>
  );
}

function SaveCase({ input, caseId, onClose, onSaved }: { input: SimInput; caseId?: string; onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(input.name ?? '');
  const [category, setCategory] = useState('CUSTOM');
  const [description, setDescription] = useState('');
  const [asNew, setAsNew] = useState(!caseId);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { name, description: description || undefined, category, input: { ...input, name } };
      const r: any = caseId && !asNew ? await api(`/sim/cases/${caseId}`, { method: 'PUT', body }) : await api('/sim/cases', { body });
      onSaved(r.caseId);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Save as test case" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save} disabled={name.trim().length < 3}>Save</Button></>}>
      {err && <Alert tone="err">{err}</Alert>}
      <div className="stack">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Card spend just below ₹10,000" autoFocus /></Field>
        <Field label="Category"><select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Description"><textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {caseId && <label className="check"><input type="checkbox" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} /> Save as a new case (leave the original unchanged)</label>}
        {!input.expected && <Alert tone="warn">No expected results are defined, so this case can only be run, not pass or fail.</Alert>}
      </div>
    </Modal>
  );
}

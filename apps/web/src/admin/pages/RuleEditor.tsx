import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { CustomerParamBounds, Issue, RuleInput, RuleTemplate } from '@mxp/rules';
import { api } from '../../shared/api';
import { useAsync, useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { BoundsEditor, ConditionEditor, FamilyBadge, IssueList, ParamForm, useMeta } from '../../shared/rules-ui';
import { Alert, Badge, Button, Card, ErrorBox, Field, Loading, Tabs, useToast } from '../../shared/ui';

function fromTemplate(t: RuleTemplate): RuleInput {
  const params: Record<string, unknown> = {};
  const customerParams: Record<string, CustomerParamBounds> = {};
  for (const p of t.params) {
    if (p.setBy === 'BANK') params[p.name] = p.default;
    else customerParams[p.name] = p.default !== undefined ? { default: p.default } : {};
  }
  return {
    kind: 'Rule', code: '', template: t.code, name: t.name, description: '', segments: [], params, customerParams, enrollment: 'AUTO',
    settingsPolicy: { changeEffective: 'NEXT_WINDOW', cooldownDays: 0 }, effective: { from: new Date().toISOString().slice(0, 10), to: null }, priority: 100, featured: false, tags: [],
  };
}

export function RuleEditor() {
  const { code, v } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const meta = useMeta();
  const editing = !!code && !!v;
  const fromCode = sp.get('from');
  const [templateCode, setTemplateCode] = useState(sp.get('template') ?? '');
  const templates = useAsync(() => api<any[]>('/templates'), []);
  const existing = useAsync(async () => {
    const c = code ?? fromCode;
    if (!c) return null;
    const r = await api<any>(`/rules/${c}`);
    const ver = editing ? r.versions.find((x: any) => x.version_no === Number(v)) : r.versions.find((x: any) => ['ACTIVE', 'PAUSED'].includes(x.status)) ?? r.versions[0];
    return { rule: r, def: ver.definition as RuleInput, status: ver.status as string };
  }, [code, v, fromCode]);

  const [doc, setDoc] = useState<RuleInput | null>(null);
  const [note, setNote] = useState('');
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<any>(null);

  const tCode = doc?.template ?? existing.data?.def.template ?? templateCode;
  const template = useAsync(async () => (tCode ? ((await api<any>(`/templates/${tCode}`)).definition as RuleTemplate) : null), [tCode]);

  useEffect(() => {
    if (doc) return;
    if (existing.data) setDoc(structuredClone(existing.data.def));
    else if (!code && !fromCode && template.data) setDoc(fromTemplate(template.data));
  }, [existing.data, template.data, doc, code, fromCode]);

  const debounced = useDebounced(doc, 400);
  const check = useAsync(async () => (debounced ? api<{ ok: boolean; issues: Issue[]; summary: string | null }>('/rules/validate', { body: { rule: debounced } }) : null), [JSON.stringify(debounced)]);

  const t = template.data;
  const refs = meta.data?.references ?? {};
  const merchantLabels = useMemo(() => Object.fromEntries((meta.data?.merchants ?? []).map((m) => [m.merchant_id, m.name])), [meta.data]);
  if (meta.error || templates.error || existing.error || template.error) return <ErrorBox error={meta.error ?? templates.error ?? existing.error ?? template.error} />;

  if (!tCode) {
    return (
      <div className="stack">
        <PageHead title="Create rule" sub="Pick a mission (bank target) or spend control (customer sets the value). Save as draft, then publish." />
        {!templates.data ? <Loading /> : (
          <div className="cat-cols">
            {['MISSION', 'SPEND_CONTROL'].map((f) => (
              <div key={f} className="cat-col">
                <h2>{f === 'MISSION' ? 'Mission' : 'Spend control'}</h2>
                <p className="muted" style={{ marginTop: 0 }}>{f === 'MISSION' ? 'Bank sets the goal and reward.' : 'Customer chooses their limit or merchants.'}</p>
                {templates.data!.filter((x) => x.family === f).map((x) => (
                  <button key={x.code} className="tpl" onClick={() => setTemplateCode(x.code)}>
                    <div className="tpl-icon">{x.icon ?? '◆'}</div><div><h3>{x.name}</h3><p>{x.summary}</p></div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (!doc || !t || !meta.data) return <Loading />;

  const family = t.family;
  const bankDefs = t.params.filter((p) => p.setBy === 'BANK');
  const custDefs = t.params.filter((p) => p.setBy === 'CUSTOMER');
  const issues = check.data?.issues ?? [];
  const set = (patch: Partial<RuleInput>) => setDoc({ ...doc, ...patch });
  const segs = doc.segments ?? [];

  const save = async () => {
    setBusy(true); setSaveErr(null);
    try {
      const r = editing ? await api<any>(`/rules/${code}/versions/${v}`, { method: 'PUT', body: { rule: doc, note: note || undefined } }) : await api<any>('/rules', { body: { rule: doc, note: note || undefined } });
      toast.ok(`Saved ${r.rule_code} as draft. Publish it from the next screen.`);
      nav(`/rules/${r.rule_code}`);
    } catch (e) { setSaveErr(e); setBusy(false); }
  };

  return (
    <div className="stack">
      <PageHead
        title={editing ? `Edit ${code}` : fromCode ? `New version of ${fromCode}` : 'Create rule'}
        sub={<span className="row gap wrap"><FamilyBadge family={family} /><span>{t.icon} {t.name}</span><code>{t.code}</code></span>}
        actions={<><Button onClick={() => nav(-1)}>Cancel</Button><Button variant="primary" busy={busy} onClick={save} disabled={!doc.code}>Save draft</Button></>}
      />
      <div className="alert alert-info">Flow: <strong>Save draft</strong> → open the rule → <strong>Publish</strong> → <strong>Test</strong> in the testing app.</div>
      {saveErr && (saveErr.details ? <IssueList issues={saveErr.details} /> : <ErrorBox error={saveErr} />)}
      <div className="grid g-main" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Tabs value={tab} onChange={(x) => { if (x === 'json') setJsonText(JSON.stringify(doc, null, 2)); setTab(x); }} tabs={[{ id: 'form', label: 'Form' }, { id: 'json', label: 'Rule file (JSON)' }]} />
          {tab === 'json' ? (
            <Card title="Rule file" actions={<Button small onClick={() => { try { setDoc(JSON.parse(jsonText)); setJsonErr(null); toast.ok('Applied.'); } catch (e) { setJsonErr((e as Error).message); } }}>Apply JSON</Button>}>
              {jsonErr && <Alert tone="err">{jsonErr}</Alert>}
              <textarea className="input code" style={{ minHeight: 520 }} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
            </Card>
          ) : <>
            <Card title="1 · Identity">
              <div className="form-grid">
                <Field label="Rule code" hint="UPPER_SNAKE_CASE, unique, never changes."><input className="input" value={doc.code} disabled={editing || !!fromCode} onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} /></Field>
                <Field label="Name"><input className="input" value={doc.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="Description" wide><textarea className="input" rows={2} value={doc.description ?? ''} onChange={(e) => set({ description: e.target.value })} /></Field>
                <Field label="Tags" hint="Comma separated"><input className="input" value={(doc.tags ?? []).join(', ')} onChange={(e) => set({ tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
              </div>
            </Card>
            <Card title={<>2 · Values the bank sets <Badge tone="violet">bank</Badge></>}>
              <ParamForm defs={bankDefs} values={doc.params ?? {}} onChange={(p) => set({ params: p })} refs={refs} labels={merchantLabels} issues={issues} />
            </Card>
            {custDefs.length > 0 && (
              <Card title={<>3 · Limits on what the customer can choose <Badge tone="blue">customer</Badge></>}>
                <p className="muted" style={{ marginTop: 0 }}>The customer sets these values in their app. The bank decides the allowed range or options and a suggested default.</p>
                {custDefs.map((d) => (
                  <BoundsEditor key={d.name} def={d} value={(doc.customerParams ?? {})[d.name] ?? {}} refs={refs} labels={merchantLabels}
                    onChange={(b) => set({ customerParams: { ...(doc.customerParams ?? {}), [d.name]: b } })} />
                ))}
              </Card>
            )}
            <Card title={`${custDefs.length ? 4 : 3} · Who gets it`}>
              <div className="stack">
                <Field label="Segments" hint="None selected = every segment.">
                  <div className="chips">
                    {meta.data.segments.map((s) => (
                      <button key={s.segment_code} type="button" className={`chip ${segs.includes(s.segment_code) ? 'on' : ''}`} onClick={() => set({ segments: segs.includes(s.segment_code) ? segs.filter((x) => x !== s.segment_code) : [...segs, s.segment_code] })}>{s.name}</button>
                    ))}
                  </div>
                </Field>
                <Field label="Additional eligibility" hint="Conditions on the customer and account, e.g. dormancy risk, KYC, tenure.">
                  <ConditionEditor value={doc.eligibility} onChange={(c) => set({ eligibility: c })} facts={meta.data.facts} refs={refs} operatorsByType={meta.data.operatorsByType} fieldFilter={(f) => f.path.startsWith('customer.') || f.path.startsWith('account.')} />
                </Field>
                {family === 'MISSION' && (
                  <Field label="Enrolment">
                    <div className="pill">
                      <button type="button" className={doc.enrollment !== 'OPT_IN' ? 'on' : ''} onClick={() => set({ enrollment: 'AUTO' })}>Automatic</button>
                      <button type="button" className={doc.enrollment === 'OPT_IN' ? 'on' : ''} onClick={() => set({ enrollment: 'OPT_IN' })}>Customer opts in</button>
                    </div>
                  </Field>
                )}
              </div>
            </Card>
            <Card title={`${custDefs.length ? 5 : 4} · Policy and schedule`}>
              <div className="form-grid">
                {family === 'SPEND_CONTROL' && <>
                  <Field label="A changed value takes effect" hint="Next window stops customers raising a limit mid-day to avoid a breach.">
                    <select className="input" value={doc.settingsPolicy?.changeEffective ?? 'NEXT_WINDOW'} onChange={(e) => set({ settingsPolicy: { ...doc.settingsPolicy, changeEffective: e.target.value as 'IMMEDIATE' | 'NEXT_WINDOW' } })}>
                      <option value="NEXT_WINDOW">From the next window</option><option value="IMMEDIATE">Immediately</option>
                    </select>
                  </Field>
                  <Field label="Cooldown between changes (days)"><input className="input" type="number" min={0} max={365} value={doc.settingsPolicy?.cooldownDays ?? 0} onChange={(e) => set({ settingsPolicy: { ...doc.settingsPolicy, cooldownDays: Number(e.target.value) } })} /></Field>
                </>}
                <Field label="Effective from"><input className="input" type="date" value={doc.effective?.from ?? ''} onChange={(e) => set({ effective: { ...doc.effective, from: e.target.value || null } })} /></Field>
                <Field label="Effective to"><input className="input" type="date" value={doc.effective?.to ?? ''} onChange={(e) => set({ effective: { ...doc.effective, to: e.target.value || null } })} /></Field>
                <Field label="Priority" hint="Display order; lower first."><input className="input" type="number" value={doc.priority ?? 100} onChange={(e) => set({ priority: Number(e.target.value) })} /></Field>
                <Field label="Featured"><label className="check"><input type="checkbox" checked={!!doc.featured} onChange={(e) => set({ featured: e.target.checked })} /> Highlight in the customer app</label></Field>
              </div>
            </Card>
          </>}
          <Field label="Change note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change?" /></Field>
        </div>
        <div className="stack" style={{ position: 'sticky', top: 70 }}>
          <Card title="Live check">
            {check.data?.summary && <div className="alert alert-info"><strong>Customers will see:</strong><br />{check.data.summary}</div>}
            {check.loading && !check.data ? <Loading text="Validating…" /> : <IssueList issues={issues} />}
            <small className="muted">Validated on the server with the same engine that runs the rule. Errors block submission; warnings do not.</small>
          </Card>
        </div>
      </div>
    </div>
  );
}

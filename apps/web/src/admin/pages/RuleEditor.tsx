import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../shared/api';
import { GroupEditor, emptyGroup, type Group } from '../../shared/conditions';
import { describeRule } from '../../shared/describe';
import { useAsync, useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { loadMeta, type Meta } from '../../shared/meta';
import { pretty } from '../../shared/format';
import { Alert, Button, Card, ErrorBox, Field, Json, Loading, Tabs, useToast } from '../../shared/ui';

const RULE_CODE = /^[A-Z][A-Z0-9_]{2,39}$/;

export const blankDefinition = (): any => ({
  name: '', description: '', businessObjective: '', category: 'SPEND', campaignCode: null, kind: 'GOAL',
  scope: { channels: [], productCodes: [] },
  eligibility: { ...emptyGroup(), children: [{ type: 'condition', field: 'customer.status', operator: 'EQ', value: 'ACTIVE' }] },
  qualifying: emptyGroup(),
  metric: { type: 'SUM', operator: 'GTE' },
  period: { type: 'MONTHLY', timezone: 'Asia/Kolkata', dateBasis: 'TXN_DATE', lateGraceDays: 0 },
  tiers: [{ label: '', threshold: 0, points: 0 }], tierMode: 'CUMULATIVE', perEvent: null, combined: null,
  balancePolicy: { gapFill: 'NONE' },
  limits: { frequency: 'RECURRING', maxOccurrences: null, capPointsPerPeriod: null, capPointsLifetime: null },
  handling: { reversal: 'CLAWBACK', countStatuses: ['POSTED'] },
  priority: 100, conflict: { group: null, policy: 'CUMULATIVE' }, effective: { from: null, to: null }, nudges: { enabled: true, nearTargetPct: 80 }, backfill: false,
});

/** Make the payload consistent with the chosen kind and drop blank rows the user never filled in. */
function clean(d: any): any {
  const o = JSON.parse(JSON.stringify(d));
  if (o.kind === 'GOAL') { o.perEvent = null; o.combined = null; }
  if (o.kind === 'PER_EVENT') { o.metric = null; o.tiers = []; o.combined = null; }
  if (o.kind === 'COMBINED') { o.metric = null; o.perEvent = null; o.qualifying = emptyGroup(); }
  o.tiers = (o.tiers ?? []).filter((t: any) => t.threshold !== '' && t.points !== '').map((t: any) => ({ ...t, label: t.label || undefined, threshold: Number(t.threshold), points: Number(t.points) }));
  if (!['AVG_BALANCE', 'MIN_BALANCE', 'BALANCE_GROWTH'].includes(o.metric?.type)) o.balancePolicy = { gapFill: 'NONE' };
  return o;
}

const numOrNull = (v: string) => (v === '' ? null : Number(v));

export function RuleEditor() {
  const { code: codeParam, v } = useParams();
  const editing = !!codeParam;
  const nav = useNavigate();
  const toast = useToast();
  const meta = useAsync<Meta>(loadMeta, []);
  const campaigns = useAsync(() => api<{ campaigns: any[] }>('/campaigns'), []);
  const rules = useAsync(() => api<{ rules: any[] }>('/rules'), []);
  const existing = useAsync(() => (editing ? api<any>(`/rules/${codeParam}/versions/${v}`) : Promise.resolve(null)), [codeParam, v]);

  const [code, setCode] = useState('');
  const [def, setDef] = useState<any>(blankDefinition());
  const [note, setNote] = useState('');
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [saveErr, setSaveErr] = useState<Error | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (existing.data && !loaded.current) {
      loaded.current = true;
      setDef({ ...blankDefinition(), ...existing.data.def });
      setCode(existing.data.ruleCode);
      setNote(existing.data.changeNote ?? '');
    }
  }, [existing.data]);

  const payload = useMemo(() => clean(def), [def]);
  const debounced = useDebounced(payload, 600);
  useEffect(() => {
    let live = true;
    api<any>('/rules/validate', { body: { ruleCode: editing ? codeParam : code || undefined, definition: debounced } }).then((r) => live && setReport(r)).catch(() => {});
    return () => { live = false; };
  }, [debounced, code, codeParam, editing]);

  if (meta.loading || existing.loading) return <Loading />;
  if (meta.error || !meta.data) return <ErrorBox error={meta.error} retry={meta.reload} />;
  if (existing.error) return <ErrorBox error={existing.error} />;
  if (editing && existing.data && existing.data.status !== 'DRAFT') return <Alert tone="warn">Only draft versions can be edited. Create a new version from the rule page.</Alert>;
  const m = meta.data;

  const set = (patch: any) => setDef((d: any) => ({ ...d, ...patch }));
  const nested = (key: string, patch: any) => setDef((d: any) => ({ ...d, [key]: { ...(d[key] ?? {}), ...patch } }));
  const setKind = (kind: string) => setDef((d: any) => ({
    ...d, kind,
    metric: kind === 'GOAL' ? d.metric ?? { type: 'SUM', operator: 'GTE' } : null,
    perEvent: kind === 'PER_EVENT' ? d.perEvent ?? { mode: 'FIXED', points: 10 } : null,
    combined: kind === 'COMBINED' ? d.combined ?? { components: [{ ruleCode: '', minTier: 1 }] } : null,
    tiers: kind === 'PER_EVENT' ? [] : d.tiers.length ? d.tiers : [{ label: '', threshold: 0, points: 0 }],
  }));

  const isBalance = ['AVG_BALANCE', 'MIN_BALANCE', 'BALANCE_GROWTH'].includes(def.metric?.type);
  const isMoney = ['SUM', ...(isBalance ? [def.metric?.type] : [])].includes(def.metric?.type);
  const thresholdLabel = def.kind === 'COMBINED' ? 'Components met' : def.metric?.type === 'COUNT' ? 'Count' : 'Amount (₹)';

  const save = async (): Promise<any | null> => {
    setBusy(true); setSaveErr(null);
    try {
      const body = { definition: payload, changeNote: note || undefined };
      const saved = editing ? await api<any>(`/rules/${codeParam}/versions/${v}`, { method: 'PUT', body }) : await api<any>('/rules', { body: { code, ...body } });
      toast.ok(`Saved ${saved.ruleCode} v${saved.versionNo} as draft.`);
      return saved;
    } catch (e) { setSaveErr(e as Error); return null; } finally { setBusy(false); }
  };
  const saveAndClose = async () => { const s = await save(); if (s) nav(`/rules/${s.ruleCode}`); };

  const applyJson = () => {
    try { setDef({ ...blankDefinition(), ...JSON.parse(jsonText) }); setJsonErr(null); setTab('form'); } catch (e) { setJsonErr((e as Error).message); }
  };

  const codeOk = editing || RULE_CODE.test(code);
  const errs = report?.errors ?? [];
  const warns = report?.warnings ?? [];
  const otherRules = (rules.data?.rules ?? []).filter((r) => r.ruleCode !== codeParam && r.kind === 'GOAL');

  return (
    <>
      <PageHead title={editing ? `Edit ${codeParam} v${v}` : 'New rule'} sub="Saved as a draft. Validate, simulate, then submit for approval from the rule page."
        actions={<><Button onClick={() => nav(editing ? `/rules/${codeParam}` : '/rules')}>Cancel</Button><Button variant="primary" busy={busy} disabled={!codeOk || !def.name.trim()} onClick={saveAndClose}>Save draft</Button></>} />
      <Tabs tabs={[{ id: 'form', label: 'Builder' }, { id: 'json', label: 'JSON (advanced)' }]} value={tab} onChange={(t) => { if (t === 'json') setJsonText(JSON.stringify(payload, null, 2)); setTab(t); }} />
      {saveErr && <ErrorBox error={saveErr as any} />}

      {tab === 'json' ? (
        <Card title="Rule definition JSON" actions={<Button variant="primary" onClick={applyJson}>Apply to builder</Button>}>
          {jsonErr && <Alert tone="err">{jsonErr}</Alert>}
          <textarea className="input mono" rows={28} value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} aria-label="Rule JSON" />
          <p className="muted">Thresholds are in rupees for money metrics. The same validation applies as in the builder.</p>
        </Card>
      ) : (
        <div className="grid g-main" style={{ alignItems: 'start' }}>
          <div className="stack">
            <Card title="1. Basics">
              <div className="form-grid">
                {!editing && <Field label="Rule code" hint="Capital letters, digits and underscore. Cannot change later." error={code && !RULE_CODE.test(code) ? 'Use 3-40 characters: A-Z, 0-9, _ starting with a letter.' : null}>
                  <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CARD_SPEND_10K" /></Field>}
                <Field label="Rule name" wide><input className="input" value={def.name} onChange={(e) => set({ name: e.target.value })} placeholder="Card spend of ₹10,000 in a month" /></Field>
                <Field label="Customer-facing description" wide><textarea className="input" rows={2} value={def.description} onChange={(e) => set({ description: e.target.value })} /></Field>
                <Field label="Business objective"><input className="input" value={def.businessObjective} onChange={(e) => set({ businessObjective: e.target.value })} /></Field>
                <Field label="Category"><select className="input" value={def.category} onChange={(e) => set({ category: e.target.value })}>{m.ruleCategories.map((c) => <option key={c} value={c}>{pretty(c)}</option>)}</select></Field>
                <Field label="Campaign" hint="Campaign-period rules and budgets use this.">
                  <select className="input" value={def.campaignCode ?? ''} onChange={(e) => set({ campaignCode: e.target.value || null })}>
                    <option value="">None</option>{(campaigns.data?.campaigns ?? []).filter((c) => c.status !== 'CLOSED').map((c) => <option key={c.campaign_code} value={c.campaign_code}>{c.name} ({c.campaign_code})</option>)}
                  </select></Field>
                <Field label="Rule type" hint="Goal: reach a target. Per event: points on every qualifying transaction. Combined: meet several goals.">
                  <select className="input" value={def.kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="GOAL">Goal (thresholds and tiers)</option><option value="PER_EVENT">Per event (every transaction)</option><option value="COMBINED">Combined (several goals together)</option>
                  </select></Field>
              </div>
            </Card>

            <Card title="2. Who is eligible" actions={<span className="muted">Customer, account and segment checks</span>}>
              <GroupEditor meta={m} value={def.eligibility as Group} onChange={(g) => set({ eligibility: g })} />
              <div className="form-grid" style={{ marginTop: 14 }}>
                <Field label="Only these channels" hint="Leave empty for all channels. Used as a fast pre-filter.">
                  <div className="row wrap" style={{ gap: '4px 12px' }}>{m.reference.channels.map((c) => (
                    <label key={c.code} className="check"><input type="checkbox" checked={def.scope.channels.includes(c.code)} onChange={(e) => nested('scope', { channels: e.target.checked ? [...def.scope.channels, c.code] : def.scope.channels.filter((x: string) => x !== c.code) })} />{c.code}</label>))}</div></Field>
                <Field label="Only these products" hint="Leave empty for all products.">
                  <div className="row wrap" style={{ gap: '4px 12px' }}>{m.reference.products.map((c) => (
                    <label key={c.code} className="check"><input type="checkbox" checked={def.scope.productCodes.includes(c.code)} onChange={(e) => nested('scope', { productCodes: e.target.checked ? [...def.scope.productCodes, c.code] : def.scope.productCodes.filter((x: string) => x !== c.code) })} />{c.code}</label>))}</div></Field>
              </div>
            </Card>

            {def.kind !== 'COMBINED' && (
              <Card title={isBalance ? '3. Which accounts count' : '3. Which transactions count'} actions={<span className="muted">{isBalance ? 'Balance goals look at accounts, not transactions' : 'Inclusions and exclusions'}</span>}>
                <GroupEditor meta={m} value={def.qualifying as Group} onChange={(g) => set({ qualifying: g })} />
                <p className="muted" style={{ marginBottom: 0 }}>Use <em>negate</em> on a group to express exclusions, e.g. NOT category is RENT.</p>
              </Card>
            )}

            <Card title={def.kind === 'GOAL' ? '4. Goal and period' : def.kind === 'COMBINED' ? '4. Component goals and period' : '4. Period'}>
              <div className="form-grid">
                {def.kind === 'GOAL' && <>
                  <Field label="Measure"><select className="input" value={def.metric?.type} onChange={(e) => nested('metric', { type: e.target.value })}>
                    <option value="COUNT">Number of transactions</option><option value="SUM">Total amount</option><option value="AVG_BALANCE">Average daily balance</option><option value="MIN_BALANCE">Minimum balance</option><option value="BALANCE_GROWTH">Balance growth in the period</option></select></Field>
                  <Field label="Target is reached when"><select className="input" value={def.metric?.operator} onChange={(e) => nested('metric', { operator: e.target.value })}><option value="GTE">value ≥ threshold</option><option value="GT">value &gt; threshold</option></select></Field>
                </>}
                <Field label="Period"><select className="input" value={def.period.type} onChange={(e) => nested('period', { type: e.target.value })}>{m.periodTypes.map((p) => <option key={p} value={p}>{pretty(p)}{p === 'CAMPAIGN' ? ' (whole campaign)' : ''}</option>)}</select></Field>
                <Field label="Time zone"><input className="input" value={def.period.timezone} onChange={(e) => nested('period', { timezone: e.target.value })} /></Field>
                <Field label="Date used for the period"><select className="input" value={def.period.dateBasis} onChange={(e) => nested('period', { dateBasis: e.target.value })}><option value="TXN_DATE">Transaction date</option><option value="POSTING_DATE">Posting date</option></select></Field>
                <Field label="Late-arriving data grace (days)" hint="After the period ends, late transactions can still earn rewards for this many days."><input className="input" type="number" min={0} max={31} value={def.period.lateGraceDays} onChange={(e) => nested('period', { lateGraceDays: Number(e.target.value) })} /></Field>
                {isBalance && <Field label="Missing balance days" hint="By default a missing snapshot means the result is 'data unavailable' rather than a guess."><select className="input" value={def.balancePolicy.gapFill} onChange={(e) => nested('balancePolicy', { gapFill: e.target.value })}><option value="NONE">Do not guess (recommended)</option><option value="CARRY_FORWARD">Carry the last balance forward</option></select></Field>}
              </div>
              {def.kind === 'COMBINED' && (
                <div style={{ marginTop: 14 }}>
                  <strong>Component goals</strong>
                  {def.combined?.components.map((c: any, i: number) => (
                    <div key={i} className="row gap" style={{ marginTop: 8 }}>
                      <select className="input" value={c.ruleCode} onChange={(e) => nested('combined', { components: def.combined.components.map((x: any, j: number) => (j === i ? { ...x, ruleCode: e.target.value } : x)) })} aria-label="Component rule">
                        <option value="">Choose a goal rule...</option>{otherRules.map((r) => <option key={r.ruleCode} value={r.ruleCode}>{r.ruleCode} - {r.name}</option>)}</select>
                      <span className="muted">tier ≥</span>
                      <input className="input" style={{ width: 70 }} type="number" min={1} value={c.minTier} onChange={(e) => nested('combined', { components: def.combined.components.map((x: any, j: number) => (j === i ? { ...x, minTier: Number(e.target.value) } : x)) })} aria-label="Minimum tier" />
                      <Button small variant="ghost" onClick={() => nested('combined', { components: def.combined.components.filter((_: any, j: number) => j !== i) })}>✕</Button>
                    </div>))}
                  <div style={{ marginTop: 8 }}><Button small onClick={() => nested('combined', { components: [...(def.combined?.components ?? []), { ruleCode: '', minTier: 1 }] })}>+ Add component</Button></div>
                </div>
              )}
            </Card>

            <Card title="5. Reward">
              {def.kind === 'PER_EVENT' ? (
                <div className="form-grid">
                  <Field label="How points are earned"><select className="input" value={def.perEvent?.mode} onChange={(e) => nested('perEvent', { mode: e.target.value })}><option value="FIXED">Fixed points per transaction</option><option value="PER_AMOUNT">Points per ₹ spent</option></select></Field>
                  <Field label="XP points"><input className="input" type="number" min={1} value={def.perEvent?.points ?? ''} onChange={(e) => nested('perEvent', { points: Number(e.target.value) })} /></Field>
                  {def.perEvent?.mode === 'PER_AMOUNT' && <Field label="For every (₹)" hint="Whole blocks only: ₹250 earns one block when this is 100."><input className="input" type="number" min={1} value={def.perEvent?.perAmount ?? ''} onChange={(e) => nested('perEvent', { perAmount: Number(e.target.value) })} /></Field>}
                </div>
              ) : (
                <>
                  <div className="table-wrap"><table className="table"><thead><tr><th style={{ width: 50 }}>Tier</th><th>Label</th><th>{thresholdLabel}</th><th>XP points</th><th /></tr></thead><tbody>
                    {def.tiers.map((t: any, i: number) => (
                      <tr key={i}><td>{i + 1}</td>
                        <td><input className="input input-sm" value={t.label ?? ''} onChange={(e) => set({ tiers: def.tiers.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} aria-label="Tier label" /></td>
                        <td><input className="input input-sm" type="number" min={0} value={t.threshold} onChange={(e) => set({ tiers: def.tiers.map((x: any, j: number) => (j === i ? { ...x, threshold: e.target.value === '' ? '' : Number(e.target.value) } : x)) })} aria-label="Threshold" /></td>
                        <td><input className="input input-sm" type="number" min={0} value={t.points} onChange={(e) => set({ tiers: def.tiers.map((x: any, j: number) => (j === i ? { ...x, points: e.target.value === '' ? '' : Number(e.target.value) } : x)) })} aria-label="Points" /></td>
                        <td><Button small variant="ghost" onClick={() => set({ tiers: def.tiers.filter((_: any, j: number) => j !== i) })}>✕</Button></td></tr>))}
                  </tbody></table></div>
                  <div className="row gap" style={{ marginTop: 10 }}>
                    <Button small onClick={() => set({ tiers: [...def.tiers, { label: '', threshold: '', points: '' }] })}>+ Add tier</Button>
                    <Field label="When several tiers are reached"><select className="input input-sm" value={def.tierMode} onChange={(e) => set({ tierMode: e.target.value })}><option value="CUMULATIVE">Pay every tier reached</option><option value="HIGHEST_ONLY">Pay only the highest tier</option></select></Field>
                  </div>
                  {isMoney && <p className="muted">Thresholds are in rupees. Tiers must increase.</p>}
                </>
              )}
            </Card>

            <Card title="6. Limits and reversals">
              <div className="form-grid">
                <Field label="Frequency"><select className="input" value={def.limits.frequency} onChange={(e) => nested('limits', { frequency: e.target.value })}><option value="RECURRING">Every period</option><option value="ONCE">Once per customer</option></select></Field>
                <Field label="Max occurrences" hint="Blank = unlimited"><input className="input" type="number" min={1} value={def.limits.maxOccurrences ?? ''} onChange={(e) => nested('limits', { maxOccurrences: numOrNull(e.target.value) })} /></Field>
                <Field label="Cap: XP per period" hint="Blank = no cap"><input className="input" type="number" min={1} value={def.limits.capPointsPerPeriod ?? ''} onChange={(e) => nested('limits', { capPointsPerPeriod: numOrNull(e.target.value) })} /></Field>
                <Field label="Cap: XP lifetime" hint="Blank = no cap"><input className="input" type="number" min={1} value={def.limits.capPointsLifetime ?? ''} onChange={(e) => nested('limits', { capPointsLifetime: numOrNull(e.target.value) })} /></Field>
                <Field label="If a transaction is reversed or refunded"><select className="input" value={def.handling.reversal} onChange={(e) => nested('handling', { reversal: e.target.value })}><option value="CLAWBACK">Claw back the points</option><option value="GRANDFATHER">Keep points already earned</option></select></Field>
                <Field label="Transactions that count">
                  <div className="row gap">{['POSTED', 'PENDING'].map((s) => (
                    <label key={s} className="check"><input type="checkbox" checked={def.handling.countStatuses.includes(s)} onChange={(e) => nested('handling', { countStatuses: e.target.checked ? [...def.handling.countStatuses, s] : def.handling.countStatuses.filter((x: string) => x !== s) })} />{pretty(s)}</label>))}</div></Field>
              </div>
            </Card>

            <Card title="7. Priority, conflicts, dates and nudges">
              <div className="form-grid">
                <Field label="Priority" hint="Lower number runs first when rules conflict."><input className="input" type="number" min={0} max={1000} value={def.priority} onChange={(e) => set({ priority: Number(e.target.value) })} /></Field>
                <Field label="Conflict group" hint="Rules in the same group can be made mutually exclusive."><input className="input" value={def.conflict.group ?? ''} onChange={(e) => nested('conflict', { group: e.target.value.toUpperCase() || null })} /></Field>
                <Field label="Conflict policy"><select className="input" value={def.conflict.policy} onChange={(e) => nested('conflict', { policy: e.target.value })}>{m.conflictPolicies.map((p) => <option key={p} value={p}>{pretty(p)}</option>)}</select></Field>
                <Field label="Effective from"><input className="input" type="date" value={def.effective.from ?? ''} onChange={(e) => nested('effective', { from: e.target.value || null })} /></Field>
                <Field label="Effective to"><input className="input" type="date" value={def.effective.to ?? ''} onChange={(e) => nested('effective', { to: e.target.value || null })} /></Field>
                <Field label="Nudges"><label className="check"><input type="checkbox" checked={def.nudges.enabled} onChange={(e) => nested('nudges', { enabled: e.target.checked })} /> Send progress and achievement nudges</label></Field>
                <Field label="'Almost there' nudge at (% of target)"><input className="input" type="number" min={1} max={99} value={def.nudges.nearTargetPct} onChange={(e) => nested('nudges', { nearTargetPct: Number(e.target.value) })} /></Field>
                <Field label="On activation"><label className="check"><input type="checkbox" checked={def.backfill} onChange={(e) => set({ backfill: e.target.checked })} /> Replay the current period's existing transactions</label></Field>
                <Field label="Change note (for reviewers)" wide><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" /></Field>
              </div>
            </Card>
          </div>

          <div className="stack" style={{ position: 'sticky', top: 70 }}>
            <Card title="Live validation">
              {!report ? <span className="muted">Checking...</span> : report.valid && warns.length === 0 ? <Alert tone="ok">No problems found.</Alert> : null}
              {errs.map((i: any, k: number) => <Alert key={k} tone="err"><strong>{i.path || 'Rule'}</strong>: {i.message}</Alert>)}
              {warns.map((i: any, k: number) => <Alert key={k} tone="warn"><strong>{i.path || 'Rule'}</strong>: {i.message}</Alert>)}
              {!codeOk && <Alert tone="err"><strong>Rule code</strong>: required (A-Z, 0-9, _).</Alert>}
            </Card>
            <Card title="What this rule does">
              {describeRule(payload).map((l, i) => <p key={i} style={{ margin: '0 0 6px' }}>{l}</p>)}
              {!def.name && <span className="muted">Fill in the form to see a summary.</span>}
            </Card>
          </div>
        </div>
      )}
      {tab === 'json' && report && <Card title="Validation">{report.valid ? <Alert tone="ok">Valid.</Alert> : <Json value={errs} />}</Card>}
    </>
  );
}

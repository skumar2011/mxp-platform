import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  addDays, caseBuilder, defaultCustomerValues, localParts, MemoryStateStore,
  type CustomerSettingInput, type EvalContext, type MxpEvent, type ProcessResult, type Scenario, type ScenarioStep,
} from '@mxp/rules';
import { dt, num, pretty, pts } from '../../shared/format';
import { expectOf, saveScenario, SKIPPED as HIDDEN } from '../scenario-utils';
import { PageHead } from '../../shared/Layout';
import { EventBuilder, EVENT_DEFAULTS, type BuiltEvent } from '../../shared/EventBuilder';
import { EvaluationList, FamilyBadge, IssueList, ParamForm, Progress, useMeta } from '../../shared/rules-ui';
import { Alert, Badge, Button, Card, DataTable, Field, Loading, Modal, StatusBadge, useToast } from '../../shared/ui';
import { PackPicker, usePack } from '../pack';

type Customer = EvalContext['customer'];
export const PERSONAS: { id: string; label: string; customer: Customer }[] = [
  { id: 'mass', label: 'Mass · Mumbai', customer: { id: 'SIM_MASS', segment: 'MASS', timezone: 'Asia/Kolkata', status: 'ACTIVE', kyc_status: 'FULL', dormancy_risk: false, tenure_days: 420, days_since_last_txn: 1, products: ['SAVINGS', 'DEBIT_CARD'] } },
  { id: 'affluent', label: 'Affluent · Delhi', customer: { id: 'SIM_AFF', segment: 'AFFLUENT', timezone: 'Asia/Kolkata', status: 'ACTIVE', kyc_status: 'FULL', dormancy_risk: false, tenure_days: 2200, days_since_last_txn: 0, products: ['SAVINGS', 'CREDIT_CARD', 'FIXED_DEPOSIT', 'RECURRING_DEPOSIT'] } },
  { id: 'youth', label: 'Youth · Bengaluru', customer: { id: 'SIM_YOUTH', segment: 'YOUTH', timezone: 'Asia/Kolkata', status: 'ACTIVE', kyc_status: 'MINIMAL', dormancy_risk: false, tenure_days: 90, days_since_last_txn: 0, products: ['SAVINGS'] } },
  { id: 'ny', label: 'Affluent · New York', customer: { id: 'SIM_NY', segment: 'AFFLUENT', timezone: 'America/New_York', status: 'ACTIVE', kyc_status: 'FULL', dormancy_risk: false, tenure_days: 900, days_since_last_txn: 2, products: ['SAVINGS', 'CREDIT_CARD'] } },
  { id: 'dormant', label: 'Mass · dormancy risk', customer: { id: 'SIM_DORMANT', segment: 'MASS', timezone: 'Asia/Kolkata', status: 'ACTIVE', kyc_status: 'FULL', dormancy_risk: true, tenure_days: 1500, days_since_last_txn: 75, products: ['SAVINGS'] } },
  { id: 'senior', label: 'Senior · Chennai', customer: { id: 'SIM_SENIOR', segment: 'SENIOR', timezone: 'Asia/Kolkata', status: 'ACTIVE', kyc_status: 'FULL', dormancy_risk: false, tenure_days: 6000, days_since_last_txn: 3, products: ['SAVINGS', 'RECURRING_DEPOSIT'] } },
];

interface SimStep { kind: ScenarioStep['kind']; label?: string; event?: MxpEvent; asOf?: string; setting?: CustomerSettingInput; ruleCode?: string; result?: ProcessResult }

export function Simulator() {
  const { engine, pack } = usePack();
  const meta = useMeta();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [customer, setCustomer] = useState<Customer>(PERSONAS[0].customer);
  const accountId = `${customer.id}-SA`;
  const [initialSettings, setInitialSettings] = useState<CustomerSettingInput[]>([]);
  const [initialEnroll, setInitialEnroll] = useState<string[]>([]);
  const [steps, setSteps] = useState<SimStep[]>([]);
  const [focus, setFocus] = useState<string>(sp.get('rule') ?? '');
  const [showAll, setShowAll] = useState(false);
  const store = useRef(new MemoryStateStore());
  const tz = String(customer.timezone ?? 'Asia/Kolkata');
  const [ev, setEv] = useState<BuiltEvent>({ type: 'TRANSACTION', timestamp: new Date().toISOString(), accountId, ...EVENT_DEFAULTS.TRANSACTION });
  const [closeDate, setCloseDate] = useState(() => addDays(localParts(new Date().toISOString(), 'Asia/Kolkata').date, 1));
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const settings = useMemo(() => [...initialSettings, ...steps.filter((s) => s.kind === 'setting').map((s) => s.setting!)], [initialSettings, steps]);
  const enrollments = useMemo(() => [...initialEnroll, ...steps.filter((s) => s.kind === 'enroll').map((s) => s.ruleCode!)], [initialEnroll, steps]);
  const ctx = (): EvalContext => ({ customer, account: { id: accountId, type: 'SAVINGS', status: 'ACTIVE' }, settings, enrollments });
  const eventDate = localParts(ev.timestamp, tz).date;
  const available = useMemo(() => (engine ? engine.availableFor({ customer, settings, enrollments }, eventDate) : []), [engine, customer, settings, enrollments, eventDate]);

  const reset = () => { store.current = new MemoryStateStore(); setSteps([]); seq.current = 0; };
  useEffect(reset, [engine]);

  // Deep link from the admin console: ?rule=CODE prepares a persona and settings for that rule.
  const prepared = useRef(false);
  useEffect(() => {
    if (prepared.current || !engine || !focus) return;
    const r = engine.getRule(focus);
    if (!r) return;
    prepared.current = true;
    const persona = PERSONAS.find((p) => !r.rule.segments.length || r.rule.segments.includes(String(p.customer.segment))) ?? PERSONAS[0];
    const c = { ...persona.customer, ...(r.rule.eligibility ? caseBuilder(engine, focus).customer : {}), id: persona.customer.id };
    setCustomer(c);
    if (r.family === 'SPEND_CONTROL') setInitialSettings([{ settingId: `S_${focus}`, customerId: c.id, ruleCode: focus, values: defaultCustomerValues(engine, focus), effectiveFrom: '2026-01-01' }]);
    if (r.rule.enrollment === 'OPT_IN') setInitialEnroll([focus]);
    const q = caseBuilder(engine, focus, defaultCustomerValues(engine, focus), c.id).qualifying(localParts(new Date().toISOString(), tz).date);
    setEv({ ...(q as BuiltEvent), accountId: `${c.id}-SA` });
  }, [engine, focus, tz]);

  if (!engine || !meta.data) return <div className="stack"><PageHead title="Simulator" /><PackPicker />{!engine ? null : <Loading />}</div>;
  const refs = meta.data.references;
  const merchantLabels = Object.fromEntries(meta.data.merchants.map((m) => [m.merchant_id, m.name]));

  const push = (s: SimStep) => setSteps((x) => [...x, s]);
  const runEvent = (kind: 'event' | 'check', e: BuiltEvent = ev, label?: string) => {
    try {
      const id = kind === 'event' ? `sim-${++seq.current}` : `chk-${seq.current + 1}`;
      const event = { ...e, id, customerId: customer.id } as MxpEvent;
      if (!event.reversalOf) delete event.reversalOf;
      const result = kind === 'check' ? engine.check(event, ctx(), store.current) : engine.process(event, ctx(), store.current);
      push({ kind, label, event, result });
    } catch (x) { toast.err(x); }
  };
  const runClose = () => {
    try { push({ kind: 'close', asOf: closeDate, result: engine.close(closeDate, store.current, () => ctx()) }); } catch (x) { toast.err(x); }
  };
  const quick = (k: 'qualifying' | 'nonMatching' | 'outOfScope') => {
    const r = engine.getRule(focus)!;
    const vals = r.family === 'SPEND_CONTROL' ? settings.filter((s) => s.ruleCode === focus).at(-1)?.values ?? defaultCustomerValues(engine, focus) : {};
    const b = caseBuilder(engine, focus, vals, customer.id);
    const e = k === 'qualifying' ? b.qualifying(eventDate) : k === 'nonMatching' ? b.nonMatching(eventDate) : b.outOfScope(eventDate);
    if (!e) return toast.err(`${focus} has no ${k === 'nonMatching' ? 'filter' : 'scope'} to fail.`);
    const time = localParts(ev.timestamp, tz).time;
    const evt = { ...(e as BuiltEvent), accountId, timestamp: ev.timestamp };
    setEv(evt);
    runEvent('event', evt, `${pretty(k.replace(/([A-Z])/g, '_$1'))} (${time})`);
  };
  const shift = (days: number) => setEv({ ...ev, timestamp: new Date(new Date(ev.timestamp).getTime() + days * 86400000).toISOString() });

  const windows = store.current.windows();
  const total = steps.filter((s) => s.kind !== 'check').reduce((a, s) => a + (s.result?.points ?? 0), 0);
  const controls = available.filter((a) => a.family === 'SPEND_CONTROL');
  const missions = available.filter((a) => a.family === 'MISSION');

  return (
    <div className="stack">
      <PageHead title="Test a rule" sub="Pick a customer persona, set spend controls if needed, send sample transactions, and see awards, breaches and decisions."
        actions={<><Button onClick={reset}>Reset</Button><Button variant="primary" disabled={!steps.length} onClick={() => setSaving(true)}>Save as scenario</Button></>} />
      <PackPicker />
      <div className="grid g-main" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Card title="Customer">
            <div className="chips" style={{ marginBottom: 12 }}>
              {PERSONAS.map((p) => <button key={p.id} className={`chip ${customer.id === p.customer.id ? 'on' : ''}`} onClick={() => { setCustomer(p.customer); setInitialSettings([]); setInitialEnroll([]); reset(); }}>{p.label}</button>)}
            </div>
            <div className="form-grid">
              <Field label="Segment"><select className="input" value={String(customer.segment)} onChange={(e) => setCustomer({ ...customer, segment: e.target.value })}>{refs.segments.map((s) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Timezone"><input className="input" value={tz} onChange={(e) => setCustomer({ ...customer, timezone: e.target.value })} /></Field>
              <Field label="Dormancy risk"><select className="input" value={String(customer.dormancy_risk)} onChange={(e) => setCustomer({ ...customer, dormancy_risk: e.target.value === 'true' })}><option value="false">No</option><option value="true">Yes</option></select></Field>
              <Field label="Focus rule" hint="Quick events and expectations target this rule.">
                <select className="input" value={focus} onChange={(e) => setFocus(e.target.value)}>
                  <option value="">All rules</option>
                  {engine.listRules().map((r) => <option key={r.code} value={r.code}>{r.code}</option>)}
                </select>
              </Field>
            </div>
          </Card>

          <Card title={<>💳 Spend controls <span className="muted" style={{ fontWeight: 400 }}>set by the customer</span></>}>
            {!controls.length && <span className="muted">No spend controls offered to this segment.</span>}
            {controls.map((a) => (
              <ControlEditor key={a.code} code={a.code} name={a.name} icon={a.icon} engine={engine} refs={refs} labels={merchantLabels} customerId={customer.id}
                current={settings.filter((s) => s.ruleCode === a.code).at(-1)} started={steps.length > 0} defaultFrom={steps.length ? eventDate : '2026-01-01'}
                onApply={(s) => {
                  if (!steps.length) setInitialSettings((x) => [...x.filter((y) => y.ruleCode !== a.code), s]);
                  else push({ kind: 'setting', setting: s, label: `${a.code} set to ${JSON.stringify(s.values)} from ${s.effectiveFrom}` });
                }}
                onRemove={() => setInitialSettings((x) => x.filter((y) => y.ruleCode !== a.code))} />
            ))}
          </Card>

          <Card title={<>🎯 Missions <span className="muted" style={{ fontWeight: 400 }}>targets set by the bank</span></>}>
            {missions.map((m) => (
              <div key={m.code} className={`offer ${m.featured ? 'featured' : ''}`}>
                <div className="row gap"><span>{m.icon}</span><strong>{m.name}</strong>{m.featured && <Badge tone="amber">featured</Badge>}<span className="grow" />
                  {m.enrollment === 'OPT_IN' && (enrollments.includes(m.code) ? <Badge tone="green">enrolled</Badge> : <Button small onClick={() => (steps.length ? push({ kind: 'enroll', ruleCode: m.code, label: `Enrolled in ${m.code}` }) : setInitialEnroll((x) => [...x, m.code]))}>Opt in</Button>)}
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>{m.summary}</div>
              </div>
            ))}
          </Card>

          <Card title="Send an event" actions={<><Button onClick={() => runEvent('check')}>Pre-auth check</Button><Button variant="primary" onClick={() => runEvent('event')}>Process</Button></>}>
            <EventBuilder facts={meta.data.facts} refs={refs} tz={tz} value={ev} onChange={setEv} merchants={meta.data.merchants} />
            <div className="row gap wrap" style={{ marginTop: 10 }}>
              <Button small onClick={() => shift(1 / 24)}>+1 hour</Button><Button small onClick={() => shift(1)}>+1 day</Button><Button small onClick={() => shift(7)}>+1 week</Button><Button small onClick={() => shift(30)}>+30 days</Button>
              {focus && <><span className="grow" /><span className="muted">{focus}:</span><Button small onClick={() => quick('qualifying')}>Qualifying</Button><Button small onClick={() => quick('nonMatching')}>Not matching</Button><Button small onClick={() => quick('outOfScope')}>Out of scope</Button></>}
            </div>
          </Card>

          <Card title="Close windows" actions={<Button onClick={runClose}>Close windows ended before</Button>}>
            <div className="row gap"><input className="input" type="date" style={{ maxWidth: 200 }} value={closeDate} onChange={(e) => setCloseDate(e.target.value)} /><span className="muted">Pays compliance rewards for spend controls and end-of-window mission rewards. In production a worker does this daily.</span></div>
          </Card>
        </div>

        <div className="stack" style={{ position: 'sticky', top: 70 }}>
          <Card title={<>Journey · <span style={{ color: total < 0 ? 'var(--red)' : undefined }}>{pts(total)} points</span></>} actions={<label className="check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show skipped rules</label>}>
            {!steps.length && <span className="muted">No steps yet. Settings and opt-ins made now become the scenario's starting state.</span>}
            <div className="timeline" style={{ maxHeight: '62vh', overflow: 'auto' }}>
              {[...steps].reverse().map((s, i) => {
                const res = s.result;
                const tone = res ? (res.decision === 'BLOCK' || res.decision === 'ALERT' ? 'bad' : res.decision === 'WARN' ? 'warn' : res.points > 0 ? 'ok' : '') : '';
                const evals = (res?.evaluations ?? []).filter((e) => showAll || !HIDDEN.has(e.outcome)).filter((e) => !focus || showAll || e.ruleCode === focus || e.points);
                return (
                  <div key={steps.length - i} className={`tl-item ${tone}`}>
                    <div className="row gap wrap">
                      <strong>#{steps.length - i} {s.kind === 'event' ? 'Event' : s.kind === 'check' ? 'Pre-auth check' : s.kind === 'close' ? `Close before ${s.asOf}` : s.kind === 'setting' ? 'Setting' : 'Enrol'}</strong>
                      {s.event && <><code>{s.event.id}</code><span className="muted">{dt(s.event.timestamp)}</span></>}
                      <span className="grow" />
                      {res && <StatusBadge status={res.decision} />}
                      {res && res.points !== 0 && <Badge tone={res.points > 0 ? 'green' : 'red'}>{pts(res.points)}</Badge>}
                    </div>
                    {s.label && <div className="muted">{s.label}</div>}
                    {s.event && <div className="muted" style={{ fontSize: 12 }}>{s.event.type} {s.event.amount !== undefined ? `₹${num(Number(s.event.amount))}` : ''} {[s.event.channel, s.event.txn_type, s.event.category, s.event.merchant_id].filter(Boolean).join(' · ')}{s.event.reversalOf ? ` · reverses ${s.event.reversalOf}` : ''}</div>}
                    {res && <div style={{ marginTop: 6 }}><EvaluationList items={evals} /></div>}
                  </div>
                );
              })}
            </div>
          </Card>
          <Card title="Window state" pad={false}>
            <DataTable rows={windows} empty="No windows yet." cols={[
              { key: 'r', header: 'Rule', render: (w) => <><strong>{w.ruleCode}</strong><br /><FamilyBadge family={w.family} /></> },
              { key: 'w', header: 'Window', render: (w) => w.windowKey },
              { key: 's', header: 'Outcome', render: (w) => <><StatusBadge status={w.status} /> <StatusBadge status={w.outcome} /></> },
              { key: 'v', header: 'Value', render: (w) => <div style={{ minWidth: 90 }}>{num(w.value)} / {num(w.target)}<Progress value={w.value} target={w.target} op={w.family === 'SPEND_CONTROL' ? 'lte' : 'gte'} /></div> },
              { key: 'p', header: 'Pts', align: 'right', render: (w) => w.points || '-' },
            ]} />
          </Card>
        </div>
      </div>
      {saving && <SaveScenario onClose={() => setSaving(false)} focus={focus} build={(name, description, focusRule, record) => buildScenario({ name, description, focusRule, record, customer, account: { id: accountId, type: 'SAVINGS' }, settings: initialSettings, enrollments: initialEnroll, steps })} packName={pack?.version ?? ''} />}
    </div>
  );
}

function ControlEditor({ code, name, icon, engine, refs, labels, customerId, current, started, defaultFrom, onApply, onRemove }: {
  code: string; name: string; icon?: string; engine: NonNullable<ReturnType<typeof usePack>['engine']>; refs: Record<string, string[]>; labels: Record<string, string>; customerId: string;
  current?: CustomerSettingInput; started: boolean; defaultFrom: string; onApply: (s: CustomerSettingInput) => void; onRemove: () => void;
}) {
  const defs = engine.customerParams(code);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>(current?.values ?? defaultCustomerValues(engine, code));
  const [from, setFrom] = useState(defaultFrom);
  useEffect(() => setFrom(defaultFrom), [defaultFrom]);
  const issues = engine.validateSetting(code, values);
  return (
    <div className="offer">
      <div className="row gap"><span>{icon}</span><strong>{name}</strong><span className="grow" />
        {current ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}
        <Button small onClick={() => setOpen(!open)}>{open ? 'Close' : current ? 'Change' : 'Set'}</Button>
        {current && !started && <Button small variant="ghost" onClick={onRemove}>Remove</Button>}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>{engine.describe(code, current?.values ?? values)}</div>
      {open && (
        <div className="stack" style={{ marginTop: 10 }}>
          <ParamForm defs={defs} values={values} onChange={setValues} refs={refs} labels={labels} issues={issues} prefix="" />
          <Field label="Effective from" hint={started ? 'Mid-journey changes are recorded as a step; the engine picks the version effective on each event date.' : undefined}><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ maxWidth: 200 }} /></Field>
          {issues.length > 0 && <IssueList issues={issues} />}
          <div className="row gap"><Button variant="primary" disabled={issues.some((i) => i.severity === 'error')} onClick={() => { onApply({ settingId: `S_${code}`, customerId, ruleCode: code, values, effectiveFrom: from, version: (current?.version ?? 0) + 1 }); setOpen(false); }}>Apply</Button></div>
        </div>
      )}
    </div>
  );
}

function buildScenario(o: { name: string; description: string; focusRule?: string; record: boolean; customer: Customer; account: EvalContext['account']; settings: CustomerSettingInput[]; enrollments: string[]; steps: SimStep[] }): Scenario {
  let total = 0;
  const steps: ScenarioStep[] = o.steps.map((s): ScenarioStep => {
    const expect = o.record ? expectOf(s.result, o.focusRule) : undefined;
    if (s.kind !== 'check' && expect?.points) total += expect.points;
    if (s.kind === 'event' || s.kind === 'check') return { kind: s.kind, label: s.label, event: s.event!, expect };
    if (s.kind === 'close') return { kind: 'close', label: s.label, asOf: s.asOf!, expect };
    if (s.kind === 'setting') return { kind: 'setting', label: s.label, setting: s.setting! };
    return { kind: 'enroll', label: s.label, ruleCode: s.ruleCode! };
  });
  return { name: o.name, description: o.description || undefined, focusRule: o.focusRule || undefined, customer: o.customer, account: o.account, settings: o.settings, enrollments: o.enrollments, steps, expect: o.record ? { totalPoints: total } : undefined, tags: ['manual'] };
}

function SaveScenario({ onClose, build, focus, packName }: { onClose: () => void; build: (name: string, description: string, focusRule: string, record: boolean) => Scenario; focus: string; packName: string }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [focusRule, setFocusRule] = useState(focus);
  const [record, setRecord] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await saveScenario(build(name, description, focusRule, record)); toast.ok('Scenario saved. Run it from Scenarios.'); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Save journey as a regression scenario" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={name.trim().length < 3} onClick={go}>Save</Button></>}>
      <div className="stack">
        {err && <Alert tone="err">{err}</Alert>}
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Description"><textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Focus rule" hint="Expectations and point totals only consider this rule."><input className="input" value={focusRule} onChange={(e) => setFocusRule(e.target.value.toUpperCase())} placeholder="All rules" /></Field>
        <label className="check"><input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} /> Record today's results as the expected results</label>
        <small className="muted">Recorded against pack {packName}. Re-running later against a changed pack shows exactly which steps behave differently.</small>
      </div>
    </Modal>
  );
}

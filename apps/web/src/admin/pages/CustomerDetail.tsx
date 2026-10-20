import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, inr, num, pretty, pts } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { EventBuilder, EVENT_DEFAULTS, type BuiltEvent } from '../../shared/EventBuilder';
import { EvaluationList, FamilyBadge, ParamForm, Progress, useMeta } from '../../shared/rules-ui';
import { Alert, Badge, Button, Card, DataTable, ErrorBox, Json, KeyVal, Loading, Modal, Stat, StatusBadge, Tabs, useToast } from '../../shared/ui';

export function CustomerDetail() {
  const { id } = useParams();
  const meta = useMeta();
  const { can } = useAuth();
  const [tab, setTab] = useState<'offers' | 'simulate' | 'ledger' | 'evaluations' | 'windows' | 'events' | 'settings'>('offers');
  const { data: c, error, reload } = useAsync(() => api<any>(`/customers/${id}`), [id]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!c || !meta.data) return <Loading />;
  const cu = c.customer;
  const controls = c.offers.filter((o: any) => o.family === 'SPEND_CONTROL');
  const missions = c.offers.filter((o: any) => o.family === 'MISSION');
  return (
    <div className="stack">
      <PageHead title={cu.display_name} sub={<span className="row gap wrap"><code>{cu.customer_id}</code><span>{cu.customer_ref}</span><Badge tone="blue">{cu.segment_code}</Badge><span>{cu.timezone}</span>{cu.dormancy_risk ? <Badge tone="amber">dormancy risk</Badge> : null}</span>} />
      <div className="grid g4">
        <Stat label="Points balance" value={num(c.points.balance)} tone="green" sub={`${num(c.points.lifetime_earned)} earned · ${num(c.points.lifetime_clawed)} clawed back`} />
        <Stat label="Controls set" value={controls.filter((o: any) => o.current).length} sub={`of ${controls.length} offered`} />
        <Stat label="Missions available" value={missions.length} sub={`${missions.filter((m: any) => m.featured).length} featured`} />
        <Stat label="Breaches" value={c.breaches.length} tone={c.breaches.length ? 'amber' : undefined} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'offers', label: 'Controls & missions' }, { id: 'simulate', label: 'Post event / check' }, { id: 'ledger', label: `Points ledger (${c.ledger.length})` },
        { id: 'evaluations', label: 'Evaluations' }, { id: 'windows', label: 'Windows' }, { id: 'events', label: `Events (${c.events.length})` }, { id: 'settings', label: 'Setting history' },
      ]} />

      {tab === 'offers' && (
        <div className="split" style={{ alignItems: 'start' }}>
          <div className="stack">
            <h2>💳 Spend controls <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>the customer sets the value</span></h2>
            {controls.map((o: any) => <ControlCard key={o.code} o={o} customerId={cu.customer_id} refs={meta.data!.references} merchants={meta.data!.merchants} canEdit={can('customers:write')} onDone={reload} />)}
          </div>
          <div className="stack">
            <h2>🎯 Missions <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>the bank sets the target</span></h2>
            {missions.map((o: any) => <MissionCard key={o.code} o={o} customerId={cu.customer_id} canEdit={can('customers:write')} onDone={reload} />)}
          </div>
        </div>
      )}
      {tab === 'simulate' && <Simulate c={c} onDone={reload} />}
      {tab === 'ledger' && (
        <Card pad={false}>
          <DataTable rows={c.ledger} cols={[
            { key: 'a', header: 'Earned on', render: (l: any) => <>{l.earned_on}<div className="muted" style={{ fontSize: 12 }}>posted {dt(l.created_at)}</div></> },
            { key: 't', header: 'Type', render: (l: any) => <StatusBadge status={l.entry_type} /> },
            { key: 'r', header: 'Rule', render: (l: any) => (l.rule_code ? <Link to={`/rules/${l.rule_code}`}>{l.rule_code}</Link> : '-') },
            { key: 'w', header: 'Window', render: (l: any) => l.window_key ?? '-' },
            { key: 'why', header: 'Reason', render: (l: any) => l.reason },
            { key: 'p', header: 'Points', align: 'right', render: (l: any) => <strong className={l.points < 0 ? 'err' : ''}>{pts(l.points)}</strong> },
          ]} />
        </Card>
      )}
      {tab === 'evaluations' && <Card><EvaluationList items={c.evaluations.map((e: any) => ({ ...e, ruleCode: e.rule_code, windowKey: e.window_key, decision: e.decision ?? undefined }))} /></Card>}
      {tab === 'windows' && (
        <Card pad={false}>
          <DataTable rows={c.windows} cols={[
            { key: 'r', header: 'Rule', render: (w: any) => <><strong>{w.rule_code}</strong><br /><FamilyBadge family={w.family} /></> },
            { key: 'w', header: 'Window', render: (w: any) => <>{w.window_key}<br /><small className="muted">{w.window_start} → {w.window_end}</small></> },
            { key: 's', header: 'Status', render: (w: any) => <><StatusBadge status={w.status} /> <StatusBadge status={w.outcome} /></> },
            { key: 'v', header: 'Value / target', render: (w: any) => <div style={{ minWidth: 150 }}>{num(w.measure_value)} / {num(w.target_value)}<Progress value={w.measure_value} target={w.target_value} op={w.family === 'SPEND_CONTROL' ? 'lte' : 'gte'} /></div> },
            { key: 'a', header: 'Activity', align: 'right', render: (w: any) => w.activity_count },
            { key: 'b', header: 'Breaches', align: 'right', render: (w: any) => w.breach_count || '-' },
            { key: 'p', header: 'Points', align: 'right', render: (w: any) => w.points_awarded || '-' },
          ]} />
        </Card>
      )}
      {tab === 'events' && (
        <Card pad={false}>
          <DataTable rows={c.events} cols={[
            { key: 'a', header: 'Occurred', render: (e: any) => dt(e.occurred_at) },
            { key: 't', header: 'Type', render: (e: any) => pretty(e.event_type) },
            { key: 'd', header: 'Details', render: (e: any) => <EventSummary e={e.payload} /> },
            { key: 'id', header: 'Event id', render: (e: any) => <code>{e.event_id}</code> },
            { key: 'n', header: 'Rules', align: 'right', render: (e: any) => e.evaluations },
            { key: 'p', header: 'Points', align: 'right', render: (e: any) => (e.points ? pts(e.points) : '-') },
            { key: 's', header: 'Status', render: (e: any) => <StatusBadge status={e.status} /> },
          ]} />
        </Card>
      )}
      {tab === 'settings' && (
        <Card pad={false}>
          <DataTable rows={c.settings} cols={[
            { key: 'r', header: 'Control', render: (s: any) => <><strong>{s.rule_code}</strong> v{s.version_no}</> },
            { key: 'v', header: 'Values', render: (s: any) => <code>{JSON.stringify(s.values)}</code> },
            { key: 'e', header: 'Effective', render: (s: any) => `${s.effective_from} → ${s.effective_to ?? 'open'}` },
            { key: 's', header: 'Status', render: (s: any) => <StatusBadge status={s.status} /> },
            { key: 'b', header: 'Changed by', render: (s: any) => <>{s.changed_by} <small className="muted">({s.created_via})</small><br /><small className="muted">{dt(s.version_at)}</small></> },
            { key: 'why', header: 'Reason', render: (s: any) => s.change_reason ?? '-' },
          ]} />
        </Card>
      )}
    </div>
  );
}

export function EventSummary({ e }: { e: any }) {
  if (e.type === 'TRANSACTION') return <span>{e.dr_cr === 'C' ? 'Credit' : 'Debit'} {inr(e.amount)} · {pretty(e.channel ?? '')} · {pretty(e.txn_type ?? '')} · {pretty(e.category ?? '')}{e.merchant_name ? ` · ${e.merchant_name}` : ''}{e.reversalOf ? ` · reverses ${e.reversalOf}` : ''}</span>;
  if (e.type === 'BALANCE_SNAPSHOT') return <span>{pretty(e.account_type ?? '')} balance {inr(e.balance)} on {e.as_of_date}</span>;
  return <code style={{ fontSize: 11.5 }}>{JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['id', 'type', 'customerId', 'timestamp', 'accountId'].includes(k))))}</code>;
}

function ControlCard({ o, customerId, refs, merchants, canEdit, onDone }: { o: any; customerId: string; refs: Record<string, string[]>; merchants: any[]; canEdit: boolean; onDone: () => void }) {
  const toast = useToast();
  const defaults = useMemo(() => Object.fromEntries(o.params.map((p: any) => [p.name, o.current?.values[p.name] ?? p.default])), [o]);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>(defaults);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const labels = Object.fromEntries(merchants.map((m: any) => [m.merchant_id, m.name]));
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>(`/customers/${customerId}/controls/${o.code}`, { method: 'PUT', body: { values, via: 'ADMIN', reason: 'Set from admin console' } });
      toast.ok(`Saved. Takes effect ${r.effectiveFrom}.`); setEditing(false); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const cancel = async () => {
    try { await api(`/customers/${customerId}/controls/${o.code}`, { method: 'DELETE' }); toast.ok('Control removed.'); onDone(); } catch (e) { toast.err(e); }
  };
  const w = o.windows[0];
  return (
    <Card title={<span>{o.icon} {o.name}</span>} actions={canEdit && !editing && <><Button small onClick={() => setEditing(true)}>{o.current ? 'Change' : 'Set'}</Button>{o.current && <Button small variant="ghost" onClick={cancel}>Remove</Button>}</>}>
      {o.current ? <div>{o.current.description}</div> : <div className="muted">Not set. {o.summary}</div>}
      {o.scheduled && <Alert tone="info">Change scheduled from {o.scheduled.effectiveFrom}: {Object.entries(o.scheduled.values).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? inr(v) : v}`).join(', ')}</Alert>}
      {w && (
        <div style={{ marginTop: 8 }}>
          <div className="row gap"><small className="muted">{w.window_key}</small><StatusBadge status={w.outcome} /><span className="grow" /><small>{num(w.measure_value)} / {num(w.target_value)}</small></div>
          <Progress value={w.measure_value} target={w.target_value} op="lte" />
        </div>
      )}
      {editing && (
        <div className="stack" style={{ marginTop: 12 }}>
          <ParamForm defs={o.params} values={values} onChange={setValues} refs={refs} labels={labels} issues={err?.details} prefix="" />
          <small className="muted">{o.policy.changeEffective === 'NEXT_WINDOW' && o.current ? 'Changes take effect from the next window.' : 'Takes effect immediately.'}{o.policy.cooldownDays ? ` Can be changed once every ${o.policy.cooldownDays} days.` : ''}</small>
          {err && !err.details && <ErrorBox error={err} />}
          {err?.details && <Alert tone="err">{err.message}</Alert>}
          <div className="row gap"><Button variant="primary" busy={busy} onClick={save}>Save</Button><Button onClick={() => { setEditing(false); setValues(defaults); }}>Cancel</Button></div>
        </div>
      )}
    </Card>
  );
}

function MissionCard({ o, customerId, canEdit, onDone }: { o: any; customerId: string; canEdit: boolean; onDone: () => void }) {
  const toast = useToast();
  const w = o.windows[0];
  const join = async (action: 'enroll' | 'opt-out') => {
    try { await api(`/customers/${customerId}/missions/${o.code}/${action}`, { body: {} }); toast.ok(action === 'enroll' ? 'Enrolled.' : 'Opted out.'); onDone(); } catch (e) { toast.err(e); }
  };
  return (
    <Card title={<span>{o.icon} {o.name} {o.featured && <Badge tone="amber">featured</Badge>}</span>}
      actions={o.enrollment === 'OPT_IN' && canEdit && (o.enrolled ? <Button small variant="ghost" onClick={() => join('opt-out')}>Opt out</Button> : <Button small onClick={() => join('enroll')}>Enrol</Button>)}>
      <div className="muted">{o.summary}</div>
      {o.enrollment === 'OPT_IN' && !o.enrolled && <Alert tone="warn">Opt-in mission: not joined.</Alert>}
      {w && (
        <div style={{ marginTop: 8 }}>
          <div className="row gap"><small className="muted">{w.window_key}</small><StatusBadge status={w.outcome} /><span className="grow" /><small>{num(w.measure_value)} / {num(w.target_value)}</small>{w.points_awarded ? <Badge tone="green">+{w.points_awarded}</Badge> : null}</div>
          <Progress value={w.measure_value} target={w.target_value} />
        </div>
      )}
    </Card>
  );
}

function Simulate({ c, onDone }: { c: any; onDone: () => void }) {
  const meta = useMeta();
  const toast = useToast();
  const tz = c.customer.timezone;
  const accounts = c.accounts.map((a: any) => ({ id: a.account_id, label: `${a.account_type} ${a.account_ref}` }));
  const [ev, setEv] = useState<BuiltEvent>({ type: 'TRANSACTION', timestamp: new Date().toISOString(), accountId: accounts[0]?.id ?? null, ...EVENT_DEFAULTS.TRANSACTION });
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (kind: 'check' | 'post') => {
    setBusy(kind);
    try {
      const body = { ...ev, customerId: c.customer.customer_id, sourceSystem: 'CONSOLE' };
      const r = kind === 'check' ? await api<any>('/controls/check', { body }) : await api<any>('/events', { body });
      setResult({ kind, ...r });
      if (kind === 'post') { toast.ok(`Processed: ${r.points ? pts(r.points) + ' points' : 'no points'}`); onDone(); }
    } catch (e) { toast.err(e); } finally { setBusy(null); }
  };
  if (!meta.data) return <Loading />;
  return (
    <div className="split" style={{ alignItems: 'start' }}>
      <Card title="Event" actions={<><Button busy={busy === 'check'} onClick={() => run('check')}>Pre-auth check</Button><Button variant="primary" busy={busy === 'post'} onClick={() => run('post')}>Post event</Button></>}>
        <EventBuilder facts={meta.data.facts} refs={meta.data.references} tz={tz} value={ev} onChange={setEv} accounts={accounts} merchants={meta.data.merchants} />
        <small className="muted">Pre-auth check returns the spend-control decision without posting anything. Posting runs every live rule and writes evaluations, points, breaches and nudges.</small>
      </Card>
      <Card title="Result">
        {!result ? <span className="muted">Run a check or post an event.</span> : (
          <div className="stack">
            <KeyVal items={[['Decision', <StatusBadge key="d" status={result.decision} />], ['Points', pts(result.points ?? 0)], ...(result.eventId ? [['Event id', <code key="e">{result.eventId}</code>] as [string, React.ReactNode]] : []), ...(result.latencyMs !== undefined ? [['Latency', `${result.latencyMs.toFixed(2)} ms`] as [string, string]] : [])]} />
            {result.duplicate && <Alert tone="warn">Duplicate: already processed.</Alert>}
            <EvaluationList items={(result.evaluations ?? []).filter((e: any) => !['OUT_OF_SCOPE', 'NOT_EFFECTIVE'].includes(e.outcome))} />
            {result.effects?.length > 0 && <><h3>Effects</h3><Json value={result.effects} max={240} /></>}
          </div>
        )}
      </Card>
      <small className="muted">Times are entered in the customer's timezone ({tz}).</small>
    </div>
  );
}

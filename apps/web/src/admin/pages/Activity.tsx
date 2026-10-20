import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, inr, num, pretty, pts } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge } from '../../shared/rules-ui';
import { Button, Card, DataTable, ErrorBox, Field, Filters, Loading, StatusBadge, Tabs, useToast } from '../../shared/ui';
import { EventSummary } from './CustomerDetail';

type TabId = 'evaluations' | 'ledger' | 'breaches' | 'decisions' | 'nudges' | 'events';
const LIMIT = 100;

export function Activity() {
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const tab = (sp.get('tab') as TabId) ?? 'evaluations';
  const ruleCode = sp.get('ruleCode') ?? '';
  const customerId = sp.get('customerId') ?? '';
  const [offset, setOffset] = useState(0);
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); setOffset(0); };
  const query = { ruleCode, customerId, limit: LIMIT + 1, offset };
  const { data, error, reload } = useAsync(() => api<any[]>(`/${tab}`, { query }), [tab, ruleCode, customerId, offset]);
  const [closing, setClosing] = useState(false);
  const closeNow = async () => {
    setClosing(true);
    try { const r = await api<any>('/ops/close-windows', { body: {} }); toast.ok(`Closed ${r.closed} window(s) up to ${r.asOf}; ${r.points} points.`); reload(); } catch (e) { toast.err(e); } finally { setClosing(false); }
  };
  const rows = (data ?? []).slice(0, LIMIT);
  const cust = (r: any) => <Link to={`/customers/${r.customer_id}`}>{r.display_name ?? r.customer_id}</Link>;
  const cols: Record<TabId, any[]> = {
    evaluations: [
      { key: 'a', header: 'When', render: (r: any) => dt(r.occurred_at ?? r.evaluated_at) },
      { key: 'c', header: 'Customer', render: cust },
      { key: 'r', header: 'Rule', render: (r: any) => <><Link to={`/rules/${r.rule_code}`}>{r.rule_code}</Link> <small className="muted">v{r.rule_version_no}</small><br /><FamilyBadge family={r.family} /></> },
      { key: 'k', header: 'Trigger', render: (r: any) => (r.trigger_kind === 'CLOSE' ? 'window close' : pretty(r.event_type ?? 'event')) },
      { key: 'o', header: 'Outcome', render: (r: any) => <><StatusBadge status={r.outcome} /> {r.decision && r.decision !== 'ALLOW' ? <StatusBadge status={r.decision} /> : null}</> },
      { key: 'm', header: 'Message', render: (r: any) => <span className="muted">{r.message}</span> },
      { key: 'p', header: 'Points', align: 'right', render: (r: any) => (r.points ? pts(r.points) : '-') },
    ],
    ledger: [
      { key: 'a', header: 'Earned on', render: (r: any) => <>{r.earned_on}<div className="muted" style={{ fontSize: 12 }}>posted {dt(r.created_at)}</div></> },
      { key: 'c', header: 'Customer', render: cust },
      { key: 't', header: 'Type', render: (r: any) => <StatusBadge status={r.entry_type} /> },
      { key: 'r', header: 'Rule', render: (r: any) => (r.rule_code ? <Link to={`/rules/${r.rule_code}`}>{r.rule_code}</Link> : '-') },
      { key: 'w', header: 'Window', render: (r: any) => r.window_key ?? '-' },
      { key: 'why', header: 'Reason', render: (r: any) => r.reason },
      { key: 'p', header: 'Points', align: 'right', render: (r: any) => <strong className={r.points < 0 ? 'err' : ''}>{pts(r.points)}</strong> },
    ],
    breaches: [
      { key: 'a', header: 'When', render: (r: any) => dt(r.event_at ?? r.occurred_at) },
      { key: 'c', header: 'Customer', render: cust },
      { key: 'r', header: 'Control', render: (r: any) => <Link to={`/rules/${r.rule_code}`}>{r.rule_code}</Link> },
      { key: 'w', header: 'Window', render: (r: any) => r.window_key },
      { key: 'v', header: 'Measured / limit', align: 'right', render: (r: any) => `${r.limit_value <= 1 ? num(r.measured_value) : inr(r.measured_value)} / ${r.limit_value <= 1 ? num(r.limit_value) : inr(r.limit_value)}` },
      { key: 'x', header: 'Action', render: (r: any) => <StatusBadge status={r.action} /> },
    ],
    decisions: [
      { key: 'a', header: 'When', render: (r: any) => dt(r.decided_at) },
      { key: 'c', header: 'Customer', render: cust },
      { key: 'q', header: 'Request', render: (r: any) => <code>{r.request_id ?? '-'}</code> },
      { key: 'e', header: 'Proposed', render: (r: any) => <EventSummary e={r.payload} /> },
      { key: 'd', header: 'Decision', render: (r: any) => <StatusBadge status={r.decision} /> },
      { key: 'why', header: 'Reasons', render: (r: any) => r.reasons.map((x: any) => `${x.rule}: ${x.message}`).join(' · ') || '-' },
      { key: 'l', header: 'Latency', align: 'right', render: (r: any) => `${r.latency_ms} ms` },
    ],
    nudges: [
      { key: 'a', header: 'When', render: (r: any) => dt(r.created_at) },
      { key: 'c', header: 'Customer', render: cust },
      { key: 'k', header: 'Kind', render: (r: any) => pretty(r.kind) },
      { key: 'r', header: 'Rule', render: (r: any) => r.rule_code },
      { key: 'm', header: 'Message', render: (r: any) => r.message },
      { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
    ],
    events: [
      { key: 'a', header: 'Occurred', render: (r: any) => dt(r.occurred_at) },
      { key: 'c', header: 'Customer', render: cust },
      { key: 't', header: 'Type', render: (r: any) => pretty(r.event_type) },
      { key: 'd', header: 'Details', render: (r: any) => <EventSummary e={r.payload} /> },
      { key: 'n', header: 'Rules hit', align: 'right', render: (r: any) => r.evaluations },
      { key: 'p', header: 'Points', align: 'right', render: (r: any) => (r.points ? pts(r.points) : '-') },
      { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
    ],
  };
  const csv = ['evaluations', 'ledger', 'breaches'].includes(tab);
  return (
    <div>
      <PageHead title="Activity" sub="Everything the rules engine did: evaluations with reasons, the points ledger, limit breaches, pre-auth decisions and nudges."
        actions={<>
          {csv && <Button onClick={() => download(`/${tab}`, { ruleCode, customerId, format: 'csv' }, `${tab}.csv`)}>Export CSV</Button>}
          {can('ops:run') && <Button busy={closing} onClick={closeNow}>Close due windows</Button>}
        </>} />
      <Tabs value={tab} onChange={(t) => set('tab', t)} tabs={(['evaluations', 'ledger', 'breaches', 'decisions', 'nudges', 'events'] as TabId[]).map((id) => ({ id, label: pretty(id) }))} />
      <Filters>
        <Field label="Rule code"><input className="input" value={ruleCode} onChange={(e) => set('ruleCode', e.target.value.toUpperCase())} placeholder="e.g. DSL_MASS" /></Field>
        <Field label="Customer id"><input className="input" value={customerId} onChange={(e) => set('customerId', e.target.value)} placeholder="e.g. C1001" /></Field>
      </Filters>
      {error && <ErrorBox error={error} retry={reload} />}
      {!data ? <Loading /> : (
        <Card pad={false}>
          <DataTable rows={rows} cols={cols[tab]} />
          <div className="pager">
            <span className="muted">{rows.length ? `${offset + 1}–${offset + rows.length}` : '0'}</span>
            <Button small disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</Button>
            <Button small disabled={data.length <= LIMIT} onClick={() => setOffset(offset + LIMIT)}>Next</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

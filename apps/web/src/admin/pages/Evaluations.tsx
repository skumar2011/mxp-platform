import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, num, pts } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { TraceView } from '../../shared/trace';
import { Button, Card, DataTable, ErrorBox, Field, Filters, KeyVal, Loading, Modal, Pager, StatusBadge, useToast } from '../../shared/ui';

const OUTCOMES = ['AWARDED', 'REVERSED', 'ACHIEVED', 'IN_PROGRESS', 'NOT_QUALIFYING', 'INELIGIBLE', 'NO_CHANGE', 'CAPPED', 'SUPPRESSED', 'DATA_UNAVAILABLE', 'PERIOD_CLOSED', 'ERROR'];

export function Evaluations() {
  const { can } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ customerRef: '', ruleCode: '', outcome: '', from: '', to: '', q: '' });
  const [applied, setApplied] = useState(f);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const limit = 50;
  const rules = useAsync(() => api<{ rules: any[] }>('/rules'), []);
  const q = useAsync(() => api<any>('/evaluations', { query: { ...applied, limit, offset } }), [applied, offset]);
  const set = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <PageHead title="Evaluations" sub="Every decision the engine made, with the reason. Search by customer, rule, outcome or date."
        actions={can('export') && <Button onClick={() => download('/evaluations/export.csv', applied, 'evaluations.csv').catch(toast.err)}>Export CSV</Button>} />
      <Card>
        <Filters onApply={() => { setOffset(0); setApplied(f); }}>
          <Field label="Customer"><input className="input" value={f.customerRef} onChange={set('customerRef')} placeholder="CUST-1001" /></Field>
          <Field label="Rule"><select className="input" value={f.ruleCode} onChange={set('ruleCode')}><option value="">All</option>{rules.data?.rules.map((r) => <option key={r.ruleCode} value={r.ruleCode}>{r.ruleCode}</option>)}</select></Field>
          <Field label="Outcome"><select className="input" value={f.outcome} onChange={set('outcome')}><option value="">All</option>{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select></Field>
          <Field label="From"><input className="input" type="date" value={f.from} onChange={set('from')} /></Field>
          <Field label="To"><input className="input" type="date" value={f.to} onChange={set('to')} /></Field>
          <Field label="Reason contains"><input className="input" value={f.q} onChange={set('q')} /></Field>
          <Button variant="primary" type="submit">Search</Button>
          <Button onClick={() => { const e = { customerRef: '', ruleCode: '', outcome: '', from: '', to: '', q: '' }; setF(e); setApplied(e); setOffset(0); }}>Clear</Button>
        </Filters>
        {q.loading && !q.data ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={q.reload} /> : (
          <>
            <DataTable rows={q.data.rows} onRow={(r: any) => setOpen(r.evaluationId)} empty="No evaluations match these filters." cols={[
              { key: 't', header: 'When', render: (r: any) => dt(r.evaluatedAt) },
              { key: 'c', header: 'Customer', render: (r: any) => r.customerRef },
              { key: 'r', header: 'Rule', render: (r: any) => <>{r.ruleCode} <small className="muted">v{r.versionNo}</small></> },
              { key: 'o', header: 'Outcome', render: (r: any) => <StatusBadge status={r.outcome} /> },
              { key: 'm', header: 'Metric', align: 'right', render: (r: any) => num(r.metric) },
              { key: 'x', header: 'XP', align: 'right', render: (r: any) => <strong>{r.pointsDelta ? pts(r.pointsDelta) : '-'}</strong> },
              { key: 'w', header: 'Reason', className: 'hide-sm', render: (r: any) => <small>{r.reason}</small> },
            ]} />
            <Pager total={q.data.total} limit={limit} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>
      {open && <EvalModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function EvalModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAsync(() => api<any>(`/evaluations/${id}`), [id]);
  const e = q.data;
  return (
    <Modal wide title="Evaluation detail" onClose={onClose}>
      {q.loading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : e && (
        <>
          <KeyVal items={[['Customer', <Link key="c" to={`/customers/${e.customer_ref}`}>{e.customer_ref}</Link>], ['Rule', `${e.rule_code} v${e.version_no}`], ['Outcome', <StatusBadge key="o" status={e.outcome} />], ['Trigger', e.trigger_kind],
            ['Period', e.period_key ?? '-'], ['Source transaction', e.source_txn_id ?? '-'], ['XP change', pts(e.points_delta)], ['Evaluated', dt(e.evaluated_at)]]} />
          <p><strong>Why:</strong> {e.reason_text}</p>
          {e.ledger?.length > 0 && <p>Ledger entries: {e.ledger.map((l: any) => `#${l.ledger_id} ${l.entry_type} ${pts(l.points)} (${l.slot})`).join('; ')}</p>}
          <h3 style={{ margin: '14px 0 8px' }}>How it was decided</h3>
          <TraceView trace={e.trace} />
        </>
      )}
    </Modal>
  );
}

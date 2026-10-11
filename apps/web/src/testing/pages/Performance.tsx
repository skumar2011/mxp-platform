import { useState } from 'react';
import { api, saveJson } from '../../shared/api';
import { num } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Button, Card, Field, KeyVal, Stat, useToast } from '../../shared/ui';

export function Performance() {
  const toast = useToast();
  const rules = useAsync(() => api<{ rules: any[] }>('/sim/rules'), []);
  const [code, setCode] = useState('');
  const [customers, setCustomers] = useState(200);
  const [txns, setTxns] = useState(10);
  const [dup, setDup] = useState(0.1);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); setRes(null); try { setRes(await api('/sim/perf', { body: { rule: { ruleCode: code }, customers, txnsPerCustomer: txns, duplicateRatio: dup } })); } catch (e) { toast.err(e); } finally { setBusy(false); } };
  const ok = res && res.duplicateAwards === 0 && res.ledgerStableAfterDuplicates && res.reconciliation === 'PASSED';
  return (
    <>
      <PageHead title="Performance" sub="Synthetic load against an isolated sandbox: throughput, latency per event, and proof that re-delivered events never create duplicate rewards." />
      <Card>
        <div className="form-grid">
          <Field label="Rule"><select className="input" value={code} onChange={(e) => setCode(e.target.value)}><option value="">Choose a rule...</option>{rules.data?.rules.map((r) => <option key={r.ruleCode} value={r.ruleCode}>{r.ruleCode}</option>)}</select></Field>
          <Field label="Customers" hint="1 to 5,000"><input className="input" type="number" min={1} max={5000} value={customers} onChange={(e) => setCustomers(Number(e.target.value))} /></Field>
          <Field label="Transactions per customer" hint="1 to 200"><input className="input" type="number" min={1} max={200} value={txns} onChange={(e) => setTxns(Number(e.target.value))} /></Field>
          <Field label="Duplicate deliveries" hint="Fraction re-sent, 0 to 0.5"><input className="input" type="number" step="0.05" min={0} max={0.5} value={dup} onChange={(e) => setDup(Number(e.target.value))} /></Field>
        </div>
        <p className="muted">{num(customers * txns)} events in this run (limit 20,000 per run here; run larger volumes on a dedicated test instance).</p>
        <Button variant="primary" busy={busy} disabled={!code || customers * txns > 20000} onClick={run}>▶ Run performance test</Button>
      </Card>
      {res && (
        <div className="stack" style={{ marginTop: 16 }}>
          <Alert tone={ok ? 'ok' : 'err'}>{ok ? 'Idempotency held: no duplicate awards, the ledger did not change when events were re-delivered, and reconciliation passed.' : 'Integrity problem detected. Do not release this rule version.'}</Alert>
          <div className="grid g4">
            <Stat label="Throughput" value={`${num(Math.round(res.eventsPerSecond))}/s`} sub={`${num(res.events)} events in ${(res.durationMs / 1000).toFixed(1)}s`} />
            <Stat label="Latency p50 / p95" value={`${res.latencyMs.p50} / ${res.latencyMs.p95} ms`} sub={`p99 ${res.latencyMs.p99} ms · max ${res.latencyMs.max} ms`} />
            <Stat label="Duplicate awards" value={res.duplicateAwards} tone={res.duplicateAwards ? 'red' : 'green'} sub={`${num(res.duplicatesDelivered)} duplicate deliveries`} />
            <Stat label="Customers rewarded" value={num(res.customersRewarded)} sub={`${num(res.totalPoints)} XP · ${num(res.ledgerEntries)} ledger entries`} />
          </div>
          <Card title="Details" actions={<Button small onClick={() => saveJson(res, 'performance.json')}>Download JSON</Button>}>
            <KeyVal items={[['Reconciliation', res.reconciliation], ['Ledger stable after duplicates', res.ledgerStableAfterDuplicates ? 'Yes' : 'No'], ['Rejected events', res.rejected]]} />
            {res.limits.map((l: string, i: number) => <p key={i} className="muted" style={{ marginBottom: 0 }}>{l}</p>)}
          </Card>
        </div>
      )}
    </>
  );
}

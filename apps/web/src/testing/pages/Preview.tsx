import { useState } from 'react';
import { api } from '../../shared/api';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { num } from '../../shared/format';
import { Alert, Button, Card, DataTable, Field, StatusBadge, useToast } from '../../shared/ui';
import { ResultView } from '../ResultView';

export function Preview() {
  const toast = useToast();
  const rules = useAsync(() => api<{ rules: any[] }>('/sim/rules'), []);
  const [code, setCode] = useState('');
  const [ver, setVer] = useState('');
  const [cust, setCust] = useState('');
  const [one, setOne] = useState<any>(null);
  const [many, setMany] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rule = rules.data?.rules.find((r) => r.ruleCode === code);
  const ref = () => ({ ruleCode: code, versionNo: ver ? Number(ver) : undefined });
  const single = async () => { setBusy('one'); setOne(null); try { setOne(await api('/sim/preview', { body: { rule: ref(), customerRef: cust.trim() } })); } catch (e) { toast.err(e); } finally { setBusy(null); } };
  const sample = async () => { setBusy('many'); setMany(null); try { setMany(await api('/sim/preview-sample', { body: { rule: ref(), limit: 25 } })); } catch (e) { toast.err(e); } finally { setBusy(null); } };
  return (
    <>
      <PageHead title="Real customers" sub="Replay actual customer history through any rule version, including drafts awaiting approval, to see who would earn what. Production data is only read; the replay runs in a sandbox." />
      <Card>
        <div className="row gap wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Rule"><select className="input" style={{ minWidth: 260 }} value={code} onChange={(e) => { setCode(e.target.value); setVer(''); }}><option value="">Choose a rule...</option>{rules.data?.rules.map((r) => <option key={r.ruleCode} value={r.ruleCode}>{r.ruleCode} - {r.name}</option>)}</select></Field>
          <Field label="Version"><select className="input" value={ver} onChange={(e) => setVer(e.target.value)} disabled={!rule}><option value="">Live / latest</option>{rule?.versions.map((v: any) => <option key={v.versionNo} value={v.versionNo}>v{v.versionNo} · {v.status.toLowerCase().replace(/_/g, ' ')}</option>)}</select></Field>
          <Field label="Customer reference"><input className="input" value={cust} onChange={(e) => setCust(e.target.value)} placeholder="CUST-1001" /></Field>
          <Button variant="primary" disabled={!code || !cust.trim()} busy={busy === 'one'} onClick={single}>Preview this customer</Button>
          <Button disabled={!code} busy={busy === 'many'} onClick={sample}>Preview top 25 customers</Button>
        </div>
      </Card>
      {many && (
        <div style={{ marginTop: 16 }}><Card title={`${many.customersEarning} of ${many.customersEvaluated} customers would earn ${num(many.totalPoints)} XP`} pad={false}>
          <DataTable rows={many.rows} cols={[
            { key: 'c', header: 'Customer', render: (r: any) => r.customerRef }, { key: 's', header: 'Status', render: (r: any) => (r.ok ? <StatusBadge status={r.status} /> : <span className="err">{r.error}</span>) },
            { key: 'm', header: 'Metric', align: 'right', render: (r: any) => (r.metric === null || r.metric === undefined ? '-' : num(r.metric)) }, { key: 't', header: 'Tier', align: 'right', render: (r: any) => r.tier }, { key: 'p', header: 'XP', align: 'right', render: (r: any) => <strong>{num(r.points)}</strong> },
          ]} />
        </Card></div>
      )}
      {one && <div style={{ marginTop: 16 }}><Card title={`${cust} under ${code}`}>{one.ok === false ? <Alert tone="err">{one.error?.message}</Alert> : <ResultView result={one} />}</Card></div>}
      <p className="muted" style={{ marginTop: 12 }}>Looking for the customer's actual rewards instead? Open the <a href="/customers">Admin console customer view</a>.</p>
    </>
  );
}

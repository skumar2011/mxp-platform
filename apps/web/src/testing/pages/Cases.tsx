import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, pretty } from '../../shared/format';
import { useAsync, useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Badge, Button, Card, DataTable, ErrorBox, Field, Filters, Loading, Modal, StatusBadge, useToast } from '../../shared/ui';
import { CATEGORIES, CATEGORY_TONE, handoff } from '../common';
import { ResultView } from '../ResultView';

export function Cases() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [f, setF] = useState({ ruleCode: '', category: '', q: '' });
  const q = useDebounced(f.q);
  const list = useAsync(() => api<{ cases: any[] }>('/sim/cases', { query: { ruleCode: f.ruleCode, category: f.category, q } }), [f.ruleCode, f.category, q]);
  const rules = useAsync(() => api<{ rules: any[] }>('/sim/rules'), []);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'PINNED' | 'LIVE'>('PINNED');
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<{ name: string; result: any; runId: string; status: string } | null>(null);
  const [suiteMsg, setSuiteMsg] = useState<any>(null);

  const rows = list.data?.cases ?? [];
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.caseId));

  const runOne = async (c: any) => {
    setBusy(c.caseId);
    try { const r: any = await api(`/sim/cases/${c.caseId}/run`, { body: { mode } }); setOpen({ name: c.name, ...r }); list.reload(); } catch (e) { toast.err(e); } finally { setBusy(null); }
  };
  const runSuite = async (body: any) => {
    setBusy('suite');
    try { setSuiteMsg(await api('/sim/suites/run', { body: { ...body, mode } })); list.reload(); } catch (e) { toast.err(e); } finally { setBusy(null); }
  };
  const openPlayground = async (c: any) => {
    try { const r: any = await api(`/sim/cases/${c.caseId}`); handoff.put({ input: r.case.input, caseId: c.caseId }); nav('/playground'); } catch (e) { toast.err(e); }
  };

  return (
    <>
      <PageHead title="Test cases" sub="Saved scenarios with expected results. Run one, a selection or all of them, against pinned versions or whatever is live now."
        actions={<><select className="input input-sm" value={mode} onChange={(e) => setMode(e.target.value as any)} aria-label="Rule version mode"><option value="PINNED">Use the rule version saved in each case</option><option value="LIVE">Use each rule's live version</option></select>
          <Button variant="primary" busy={busy === 'suite'} disabled={!can('simulate') || (!sel.size && !rows.length)} onClick={() => runSuite(sel.size ? { caseIds: [...sel], label: 'Selected cases' } : { ruleCode: f.ruleCode || undefined, category: f.category || undefined, label: 'Filtered cases' })}>{sel.size ? `Run ${sel.size} selected` : `Run all ${rows.length} shown`}</Button></>} />
      {suiteMsg && <Alert tone={suiteMsg.failed + suiteMsg.errors ? 'err' : 'ok'}><strong>{suiteMsg.passed} of {suiteMsg.total} passed</strong>{suiteMsg.failed ? `, ${suiteMsg.failed} failed` : ''}{suiteMsg.errors ? `, ${suiteMsg.errors} errored` : ''}. See <a href="#/suites">Regression runs</a> for details.</Alert>}
      <Card>
        <Filters>
          <Field label="Search"><input className="input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Name or description" /></Field>
          <Field label="Rule"><select className="input" value={f.ruleCode} onChange={(e) => setF({ ...f, ruleCode: e.target.value })}><option value="">All</option>{rules.data?.rules.map((r) => <option key={r.ruleCode}>{r.ruleCode}</option>)}</select></Field>
          <Field label="Category"><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">All</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        </Filters>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (
          <DataTable rows={rows} empty="No test cases yet. Build one in the Playground, or generate a full set from the Scenario matrix." cols={[
            { key: 'c', header: <input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((r) => r.caseId)))} aria-label="Select all" />, render: (r: any) => <input type="checkbox" checked={sel.has(r.caseId)} onChange={() => toggle(r.caseId)} aria-label={`Select ${r.name}`} /> },
            { key: 'n', header: 'Case', render: (r: any) => <><strong>{r.name}</strong><br /><small className="muted">{r.description}</small></> },
            { key: 'k', header: 'Category', render: (r: any) => <Badge tone={CATEGORY_TONE[r.category] ?? 'gray'}>{pretty(r.category)}</Badge> },
            { key: 'r', header: 'Rule', className: 'hide-sm', render: (r: any) => r.ruleCode ?? '-' },
            { key: 's', header: 'Steps', align: 'right', className: 'hide-sm', render: (r: any) => r.steps },
            { key: 'l', header: 'Last run', render: (r: any) => (r.lastRun ? <><StatusBadge status={r.lastRun.status} /><br /><small className="muted">{dt(r.lastRun.at)}</small></> : <span className="muted">never</span>) },
            { key: 'a', header: '', render: (r: any) => (
              <div className="row gap wrap">
                <Button small variant="primary" busy={busy === r.caseId} onClick={() => runOne(r)}>Run</Button>
                <Button small onClick={() => openPlayground(r)}>Open</Button>
                {can('testcases:write') && <Button small onClick={async () => { try { await api(`/sim/cases/${r.caseId}/clone`, { body: {} }); toast.ok('Cloned.'); list.reload(); } catch (e) { toast.err(e); } }}>Clone</Button>}
                {can('testcases:write') && <Button small variant="ghost" onClick={async () => { try { await api(`/sim/cases/${r.caseId}`, { method: 'DELETE' }); toast.ok('Archived.'); list.reload(); } catch (e) { toast.err(e); } }}>Archive</Button>}
              </div>) },
          ]} />
        )}
      </Card>
      {open && <Modal wide title={`${open.name}: ${pretty(open.status)}`} onClose={() => setOpen(null)}><ResultView result={open.result} runId={open.runId} name={open.name} /></Modal>}
    </>
  );
}

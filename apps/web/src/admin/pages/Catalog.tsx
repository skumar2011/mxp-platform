import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { IssueList } from '../../shared/rules-ui';
import { Badge, Button, ErrorBox, Field, Loading, Modal, useToast } from '../../shared/ui';

export function Catalog() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [importing, setImporting] = useState(false);
  const { data, error, reload } = useAsync(() => api<any[]>('/templates'), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const col = (family: string, core: boolean) => data.filter((t) => t.family === family && !!t.isExtension === !core);
  const card = (t: any) => (
    <button key={t.code} className="tpl" onClick={() => nav(`/catalog/${t.code}`)}>
      <div className="tpl-icon" aria-hidden>{t.icon ?? '◆'}</div>
      <div className="grow">
        <div className="row gap wrap"><h3>{t.name}</h3>{t.isExtension ? <Badge tone="amber">extension</Badge> : null}<span className="grow" /><Badge tone={t.liveRules ? 'green' : 'gray'}>{t.liveRules} live</Badge></div>
        <p>{t.summary}</p>
        <div className="row gap wrap" style={{ marginTop: 6 }}>
          <code>{t.code}</code>
          <span className="muted">v{t.version}</span>
          {t.customerParams?.length ? <Badge tone="blue">customer sets: {t.customerParams.join(', ')}</Badge> : <Badge tone="violet">bank sets every value</Badge>}
        </div>
      </div>
    </button>
  );
  return (
    <div>
      <PageHead title="Templates" sub="Reusable rule templates. Create a bank rule from one, then publish and test it."
        actions={can('templates:write') && <Button onClick={() => setImporting(true)}>Import template file</Button>} />
      <div className="cat-cols">
        <div className="cat-col">
          <h2>Spend controls</h2>
          <p className="muted">Customer chooses the value; bank sets the bounds and reward.</p>
          {col('SPEND_CONTROL', true).map(card)}
          {col('SPEND_CONTROL', false).map(card)}
        </div>
        <div className="cat-col">
          <h2>Missions</h2>
          <p className="muted">Bank sets the goal and reward.</p>
          {col('MISSION', true).map(card)}
          {col('MISSION', false).length > 0 && <h3 style={{ margin: '18px 0 10px' }}>Extensions</h3>}
          {col('MISSION', false).map(card)}
        </div>
      </div>
      {importing && <ImportTemplate onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />}
    </div>
  );
}

export function ImportTemplate({ onClose, onDone, initial = '' }: { onClose: () => void; onDone: () => void; initial?: string }) {
  const toast = useToast();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<any[] | null>(null);
  const go = async () => {
    setBusy(true); setIssues(null);
    try {
      const template = JSON.parse(text);
      const r = await api<any>('/templates', { body: { template } });
      toast.ok(r.unchanged ? `${r.code} is unchanged (v${r.version}).` : `${r.code} v${r.version} imported.`);
      onDone();
    } catch (e: any) {
      if (e.details) setIssues(e.details); else toast.err(e);
      setBusy(false);
    }
  };
  return (
    <Modal title="Import template file" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={go} disabled={!text.trim()}>Import</Button></>}>
      <Field label="Template JSON"><textarea className="input code" style={{ minHeight: 280 }} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "kind": "RuleTemplate", ... }' /></Field>
      {issues && <IssueList issues={issues} />}
    </Modal>
  );
}

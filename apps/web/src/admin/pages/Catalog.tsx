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
  const col = (family: string, core: boolean) => data.filter((t) => t.family === family && !t.is_extension === core);
  const card = (t: any) => (
    <button key={t.template_code} className="tpl" onClick={() => nav(`/catalog/${t.template_code}`)}>
      <div className="tpl-icon" aria-hidden>{t.icon ?? '◆'}</div>
      <div className="grow">
        <div className="row gap wrap"><h3>{t.name}</h3>{t.is_extension ? <Badge tone="amber">extension</Badge> : null}<span className="grow" /><Badge tone={t.live_rules ? 'green' : 'gray'}>{t.live_rules} live</Badge></div>
        <p>{t.description}</p>
        <div className="row gap wrap" style={{ marginTop: 6 }}>
          <code>{t.template_code}</code>
          <span className="muted">v{t.current_version}</span>
          {t.customerParams.length ? <Badge tone="blue">customer sets: {t.customerParams.join(', ')}</Badge> : <Badge tone="violet">bank sets every value</Badge>}
        </div>
      </div>
    </button>
  );
  return (
    <div>
      <PageHead title="Rule catalogue" sub="Rule templates: the logic, written once as a rule file. Bank rules configure them for segments without code changes."
        actions={can('templates:write') && <Button onClick={() => setImporting(true)}>Import template file</Button>} />
      <div className="cat-cols">
        <div className="cat-col">
          <h2>💳 Spend controls</h2>
          <p>The bank defines the rule and the limits a customer may choose; the customer sets the value and earns points for staying within it.</p>
          {col('SPEND_CONTROL', true).map(card)}
          {col('SPEND_CONTROL', false).map(card)}
        </div>
        <div className="cat-col">
          <h2>🎯 Bank-defined missions</h2>
          <p>The bank defines the rule and the target; customers achieve it and collect reward points.</p>
          {col('MISSION', true).map(card)}
          {col('MISSION', false).length > 0 && <h3 style={{ margin: '18px 0 10px' }}>Extensions</h3>}
          {col('MISSION', false).map(card)}
        </div>
      </div>
      {importing && <ImportTemplate onClose={() => setImporting(false)} onDone={reload} />}
    </div>
  );
}

export function ImportTemplate({ onClose, onDone, initial }: { onClose: () => void; onDone: () => void; initial?: string }) {
  const toast = useToast();
  const [text, setText] = useState(initial ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>('/templates', { body: { template: JSON.parse(text), note } });
      toast.ok(r.unchanged ? `${r.code} is unchanged (v${r.version}).` : `${r.code} v${r.version} imported.`);
      onDone(); onClose();
    } catch (e: any) { setErr(e); setBusy(false); }
  };
  return (
    <Modal wide title="Import a rule template" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!text.trim()} onClick={go}>Import</Button></>}>
      <div className="stack">
        <p className="muted">A template is a JSON rule file with <code>kind: "RuleTemplate"</code>. Importing an existing code creates a new version; it is rejected if any live or pending bank rule would become invalid.</p>
        <input type="file" accept=".json,application/json" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <textarea className="input code" value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "kind": "RuleTemplate", ... }' />
        <Field label="Change note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && (err.details ? <IssueList issues={err.details} /> : <ErrorBox error={err} />)}
      </div>
    </Modal>
  );
}

import { useState } from 'react';
import { api, download } from '../../shared/api';
import { dt } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Badge, Button, Card, DataTable, ErrorBox, Json, Loading, Modal } from '../../shared/ui';

export function Packs() {
  const { data, error, reload } = useAsync(() => api<any[]>('/packs'), []);
  const [view, setView] = useState<any>(null);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="stack">
      <PageHead title="Rule packs" sub="The live pack is built from ACTIVE and PAUSED rules. Templates live in @mxp/rules; download the pack to embed elsewhere."
        actions={<Button variant="primary" onClick={() => download('/packs/current', { download: 1 }, 'mxp-retail.pack.json')}>Download current pack</Button>} />
      <div className="alert alert-info">
        <strong>Use the rules in any app.</strong> A rule pack is one JSON file with templates, bank rules and reference lists. Load it with <code>RulesEngine.fromPack(file)</code> from <code>@mxp/rules</code> (no database, no server) and call <code>check()</code>, <code>process()</code> and <code>close()</code> with your own state store.
      </div>
      <Card pad={false}>
        <DataTable rows={data} rowKey={(r) => r.release_id} cols={[
          { key: 'l', header: 'Release', render: (r) => <><strong>{r.version_label}</strong> {r.is_current ? <Badge tone="green">current</Badge> : null}</> },
          { key: 'r', header: 'Reason', render: (r) => r.reason },
          { key: 'c', header: 'Contents', render: (r) => `${r.rule_count} rules · ${r.template_count} templates` },
          { key: 'b', header: 'Published', render: (r) => <>{r.published_by}<br /><small className="muted">{dt(r.published_at)}</small></> },
          { key: 'h', header: 'sha256', render: (r) => <code>{r.content_hash.slice(0, 16)}</code> },
          { key: 'a', header: '', render: (r) => <div className="row gap"><Button small onClick={async () => setView(await api(`/packs/${r.release_id}`))}>View</Button><Button small onClick={() => download(`/packs/${r.release_id}`, { download: 1 }, `mxp-retail-${r.version_label}.pack.json`)}>Download</Button></div> },
        ]} />
      </Card>
      {view && <Modal wide title={`Release ${view.version_label}`} onClose={() => setView(null)}><Json value={view.content} max={600} /></Modal>}
    </div>
  );
}

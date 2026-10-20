import { useState } from 'react';
import { api, download } from '../../shared/api';
import { dt } from '../../shared/format';
import { useAsync, useDebounced } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Alert, Button, Card, DataTable, ErrorBox, Field, Filters, Loading } from '../../shared/ui';

export function Audit() {
  const [entityId, setEntityId] = useState('');
  const [actor, setActor] = useState('');
  const e = useDebounced(entityId);
  const a = useDebounced(actor);
  const { data, error, reload } = useAsync(() => api<any[]>('/audit', { query: { entityId: e, actor: a, limit: 300 } }), [e, a]);
  const verify = useAsync(() => api<any>('/audit/verify'), []);
  return (
    <div>
      <PageHead title="Audit trail" sub="Append-only and hash-chained: every rule change, approval, release, customer setting and sign-in." actions={<Button onClick={() => download('/audit', { format: 'csv', limit: 5000 }, 'audit.csv')}>Export CSV</Button>} />
      {verify.data && (verify.data.ok ? <Alert tone="ok">Hash chain verified: {verify.data.checked} entries intact.</Alert> : <Alert tone="err">Hash chain broken at entry {verify.data.brokenAt}.</Alert>)}
      <Filters>
        <Field label="Entity"><input className="input" value={entityId} onChange={(x) => setEntityId(x.target.value)} placeholder="e.g. DSL_MASS" /></Field>
        <Field label="Actor"><input className="input" value={actor} onChange={(x) => setActor(x.target.value)} placeholder="e.g. checker" /></Field>
      </Filters>
      {error && <ErrorBox error={error} retry={reload} />}
      {!data ? <Loading /> : (
        <Card pad={false}>
          <DataTable rows={data} rowKey={(r) => String(r.audit_id)} cols={[
            { key: 'i', header: '#', render: (r) => r.audit_id },
            { key: 'a', header: 'When', render: (r) => dt(r.occurred_at) },
            { key: 'u', header: 'Actor', render: (r) => r.actor },
            { key: 'x', header: 'Action', render: (r) => <code>{r.action}</code> },
            { key: 'e', header: 'Entity', render: (r) => <>{r.entity_type}<br /><code>{r.entity_id}</code></> },
            { key: 'd', header: 'Detail', render: (r) => (r.detail ? <code style={{ fontSize: 11.5 }}>{JSON.stringify(r.detail).slice(0, 160)}</code> : '-') },
            { key: 'h', header: 'Hash', render: (r) => <code>{r.hash.slice(0, 10)}</code> },
          ]} />
        </Card>
      )}
    </div>
  );
}

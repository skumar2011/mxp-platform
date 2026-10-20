import { Link } from 'react-router-dom';
import { api } from '../../shared/api';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { Badge, Card, ErrorBox, Loading } from '../../shared/ui';
import { inr, pretty } from '../../shared/format';

/** "Personalised by segment": the same templates, different values per segment. */
export function Segments() {
  const { data, error, reload } = useAsync(() => api<any[]>('/segments/overview'), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const bounds = (o: any) => Object.entries(o.customerParams ?? {}).map(([k, b]: [string, any]) => {
    if (b.min !== undefined || b.max !== undefined) return `${k}: ${inr(b.min)} – ${inr(b.max)}${b.default !== undefined ? `, default ${inr(b.default)}` : ''}`;
    if (b.options) return `${k}: ${b.options.map(pretty).join(', ')}${b.default ? ` (default ${[].concat(b.default).map(pretty).join(', ')})` : ''}`;
    return null;
  }).filter(Boolean);
  return (
    <div>
      <PageHead title="Personalised by segment" sub="What each segment is offered from the live rule pack: the same rule templates configured with different values, defaults and featured missions." />
      <div className="seg-cols">
        {data.map((s) => (
          <Card key={s.segment_code} title={<>{s.name} <span className="muted">· {s.customers} customers</span></>}>
            <p className="muted" style={{ marginTop: 0 }}>{s.description}</p>
            <h3 style={{ margin: '8px 0' }}>💳 Spend controls ({s.controls.length})</h3>
            {s.controls.map((o: any) => (
              <div key={o.code} className="offer">
                <div className="row gap"><span>{o.icon}</span><Link to={`/rules/${o.code}`}><strong>{o.name}</strong></Link></div>
                {bounds(o).map((b: any) => <div key={b} className="muted" style={{ fontSize: 12.5 }}>{b}</div>)}
              </div>
            ))}
            <h3 style={{ margin: '14px 0 8px' }}>🎯 Missions ({s.missions.length})</h3>
            {[...s.missions].sort((a: any, b: any) => Number(b.featured) - Number(a.featured)).map((o: any) => (
              <div key={o.code} className={`offer ${o.featured ? 'featured' : ''}`}>
                <div className="row gap"><span>{o.icon}</span><Link to={`/rules/${o.code}`}><strong>{o.name}</strong></Link>{o.featured && <Badge tone="amber">featured</Badge>}{o.enrollment === 'OPT_IN' && <Badge>opt-in</Badge>}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{o.summary}</div>
              </div>
            ))}
          </Card>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 16 }}>Values come from the published rule pack. Amounts are in INR.</p>
    </div>
  );
}

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Condition, RuleTemplate } from '@mxp/rules';
import { api, download } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { dt, pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge, formatValue } from '../../shared/rules-ui';
import { Badge, Button, Card, DataTable, ErrorBox, Json, KeyVal, Loading, StatusBadge, Tabs } from '../../shared/ui';
import { ImportTemplate } from './Catalog';

const show = (v: unknown): string => {
  if (v && typeof v === 'object' && '$param' in (v as object)) return `{${(v as { $param: string }).$param}}`;
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  return JSON.stringify(v);
};
export function condText(c?: Condition): string {
  if (!c) return 'everything';
  if ('all' in c) return c.all.length ? c.all.map(condText).join(' AND ') : 'everything';
  if ('any' in c) return `(${c.any.map(condText).join(' OR ')})`;
  if ('not' in c) return `NOT (${condText(c.not)})`;
  return `${c.field} ${c.op.replace(/_/g, ' ')}${c.value === undefined ? '' : ` ${show(c.value)}`}`;
}

export function explainLogic(t: RuleTemplate): [string, string][] {
  const l = t.logic;
  const m = l.measure;
  const w = l.window;
  const out: [string, string][] = [
    ['Listens to', l.events.join(', ')],
    ['Tracked per', l.subject === 'ACCOUNT' ? 'customer and account' : 'customer'],
    ['Activity (scope)', condText(l.scope)],
    ['Measured (filter)', condText(l.filter)],
    ['Measure', `${m.type}${m.field ? ` of ${m.field}` : ''}${m.perDayCap ? `, at most ${show(m.perDayCap)} per day` : ''}${m.dedupeBy ? `, one per ${m.dedupeBy}` : ''}${m.streakPeriod ? `, per ${m.streakPeriod.toLowerCase()}` : ''}${m.breakWhen ? `, broken when ${condText(m.breakWhen)}` : ''}`],
    ['Window', `${show(w.type)}${w.days ? ` (${show(w.days)} days)` : ''}${w.period ? `, settled per ${w.period.toLowerCase()}` : ''}${w.timezone ? `, timezone ${w.timezone === 'CUSTOMER' ? "customer's" : w.timezone}` : ''}${w.graceDays ? `, ${w.graceDays} grace day(s)` : ''}`],
  ];
  if (l.goal) out.push(['Goal', l.goal.tiers ? l.goal.tiers.map((x) => `${l.goal!.op} ${show(x.target)} → ${show(x.points)} pts`).join('; ') : `${l.goal.op} ${show(l.goal.target)}`]);
  if (l.control) out.push(['When exceeded', `${show(l.control.action)}${l.control.warnAtPct ? `, warn at ${show(l.control.warnAtPct)}%` : ''}`]);
  const r = l.reward;
  out.push(['Reward', `${r.mode}${r.points !== undefined ? `, ${show(r.points)} pts` : ''}${r.perAmount ? ` per ${show(r.perAmount)}` : ''}${r.minActivity ? `, needs ${show(r.minActivity)} transactions` : ''}${r.capPointsPerWindow ? `, cap ${show(r.capPointsPerWindow)}/window` : ''}${r.maxAwardsPerWindow ? `, max ${show(r.maxAwardsPerWindow)} awards/window` : ''}${r.maxAwards ? `, max ${show(r.maxAwards)} awards ever` : ''}${r.awardAt === 'WINDOW_CLOSE' ? ', paid at window close' : ''}${r.onReversal === 'CLAWBACK' ? ', clawed back on reversal' : ''}`]);
  return out;
}

export function TemplateDetail() {
  const { code } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [tab, setTab] = useState<'overview' | 'json' | 'versions'>('overview');
  const [newVersion, setNewVersion] = useState(false);
  const { data: t, error, reload } = useAsync(() => api<any>(`/templates/${code}`), [code]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!t) return <Loading />;
  const def: RuleTemplate = t.definition;
  return (
    <div className="stack">
      <PageHead
        title={<span>{def.icon} {def.name}</span>}
        sub={<span className="row gap wrap"><FamilyBadge family={def.family} /><code>{def.code}</code><span>v{def.version}</span>{t.is_extension ? <Badge tone="amber">extension</Badge> : null}</span>}
        actions={<>
          <Button onClick={() => download(`/templates/${code}/file`, {}, `${code}.template.json`)}>Download rule file</Button>
          {can('templates:write') && <Button onClick={() => setNewVersion(true)}>New version</Button>}
          {can('rules:write') && <Button variant="primary" onClick={() => nav(`/rules/new?template=${code}`)}>Create bank rule</Button>}
        </>}
      />
      <p>{def.description}</p>
      {def.summary && <div className="alert alert-info"><strong>Customer-facing summary:</strong> {def.summary}</div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'json', label: 'Rule file (JSON)' }, { id: 'versions', label: `Versions (${t.versions.length})` }]} />
      {tab === 'overview' && <>
        <Card title="Parameters" pad={false}>
          <DataTable rows={def.params} cols={[
            { key: 'n', header: 'Parameter', render: (p) => <><strong>{p.label}</strong><br /><code>{p.name}</code></> },
            { key: 's', header: 'Set by', render: (p) => <Badge tone={p.setBy === 'CUSTOMER' ? 'blue' : 'violet'}>{p.setBy === 'CUSTOMER' ? 'Customer' : 'Bank'}</Badge> },
            { key: 't', header: 'Type', render: (p) => <code>{p.type}</code> },
            { key: 'd', header: 'Default', render: (p) => formatValue(p, p.default) },
            { key: 'r', header: 'Allowed', render: (p) => p.options ? p.options.map(pretty).join(', ') : p.optionsFrom ? <span className="muted">list “{p.optionsFrom}”</span> : p.min !== undefined || p.max !== undefined ? `${formatValue(p, p.min)} – ${formatValue(p, p.max)}` : '-' },
            { key: 'x', header: 'Description', render: (p) => <span className="muted">{p.description}</span> },
          ]} />
        </Card>
        <Card title="How it works"><KeyVal items={explainLogic(def)} /></Card>
        <Card title={`Bank rules built on this template (${t.rules.length})`} pad={false}>
          <DataTable rows={t.rules} onRow={(r: any) => nav(`/rules/${r.code}`)} empty="No rules yet." cols={[
            { key: 'c', header: 'Rule', render: (r: any) => <><strong>{r.name}</strong><br /><code>{r.code}</code></> },
            { key: 'seg', header: 'Segments', render: (r: any) => r.segments.length ? r.segments.join(', ') : 'All' },
            { key: 's', header: 'Status', render: (r: any) => <><StatusBadge status={r.liveStatus ?? r.latestStatus} /> {r.liveVersion ? `v${r.liveVersion}` : ''}</> },
            { key: 'sum', header: 'Summary', render: (r: any) => <span className="muted">{r.summary}</span> },
          ]} />
        </Card>
      </>}
      {tab === 'json' && <Json value={def} max={700} />}
      {tab === 'versions' && (
        <Card pad={false}>
          <DataTable rows={t.versions} cols={[
            { key: 'v', header: 'Version', render: (v: any) => `v${v.version_no}` },
            { key: 'n', header: 'Note', render: (v: any) => v.change_note ?? '-' },
            { key: 'b', header: 'By', render: (v: any) => v.created_by },
            { key: 'a', header: 'At', render: (v: any) => dt(v.created_at) },
            { key: 'h', header: 'Hash', render: (v: any) => <code>{v.definition_hash.slice(0, 12)}</code> },
            { key: 'd', header: '', render: (v: any) => <Button small onClick={() => download(`/templates/${code}/file`, { version: v.version_no }, `${code}.v${v.version_no}.template.json`)}>Download</Button> },
          ]} />
        </Card>
      )}
      <Link to="/catalog">← Back to catalogue</Link>
      {newVersion && <ImportTemplate initial={JSON.stringify({ ...def, version: undefined }, null, 2)} onClose={() => setNewVersion(false)} onDone={reload} />}
    </div>
  );
}

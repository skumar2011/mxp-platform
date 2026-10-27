import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { describeRule, ruleSchema, type RuleTemplate } from '@mxp/rules';
import { api } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { inr, num } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge, formatValue, useMeta } from '../../shared/rules-ui';
import { Badge, Button, Card, DataTable, ErrorBox, Json, KeyVal, Loading, ReasonDialog, Stat, StatusBadge, Tabs, useToast } from '../../shared/ui';
import { condText } from './TemplateDetail';

export function RuleDetail() {
  const { code } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const meta = useMeta();
  const [tab, setTab] = useState<'overview' | 'json'>('overview');
  const [dialog, setDialog] = useState<null | { action: string }>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { data: r, error, reload } = useAsync(() => api<any>(`/rules/${code}`), [code]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!r) return <Loading />;

  const t: RuleTemplate = r.template;
  const latest = r.versions[0];
  const live = r.versions.find((x: any) => ['ACTIVE', 'PAUSED'].includes(x.status));
  const shown = live ?? latest;
  const def = ruleSchema.parse(shown.definition);
  let summary = '';
  try { summary = describeRule(def, t); } catch { /* invalid */ }
  const merchantName = (id: string) => meta.data?.merchants.find((m) => m.merchant_id === id)?.name ?? id;

  const act = async (label: string, path: string, body: unknown = {}) => {
    setBusy(label);
    try { await api(path, { body }); toast.ok(`${label}: done.`); reload(); } catch (e) { toast.err(e); } finally { setBusy(null); }
  };
  const publishPath = `/rules/${code}/versions/${latest.version_no}/activate`;

  return (
    <div className="stack">
      <PageHead
        title={<span>{t.icon} {shown.name}</span>}
        sub={<span className="row gap wrap"><FamilyBadge family={r.family} /><code>{r.rule_code}</code><StatusBadge status={live?.status ?? latest.status} /></span>}
        actions={<>
          <a className="btn" href={`/testing/?rule=${code}`}>Test rule ↗</a>
          {latest.status === 'DRAFT' && can('rules:write') && <Button onClick={() => nav(`/rules/${code}/versions/${latest.version_no}/edit`)}>Edit</Button>}
          {latest.status === 'DRAFT' && can('rules:activate') && <Button variant="primary" busy={busy === 'Publish'} onClick={() => act('Publish', publishPath)}>Publish</Button>}
          {live?.status === 'ACTIVE' && can('rules:write') && <Button onClick={() => nav(`/rules/${code}/versions/${latest.version_no}/edit`)}>Edit</Button>}
          {live?.status === 'ACTIVE' && can('rules:activate') && <Button onClick={() => setDialog({ action: 'pause' })}>Pause</Button>}
          {live?.status === 'PAUSED' && can('rules:activate') && <Button variant="primary" busy={busy === 'Resume'} onClick={() => act('Resume', `/rules/${code}/resume`)}>Resume</Button>}
          {live && can('rules:activate') && <Button variant="danger" onClick={() => setDialog({ action: 'retire' })}>Retire</Button>}
        </>}
      />

      {latest.status === 'DRAFT' && (
        <div className="alert alert-warn">
          This rule is a <strong>draft</strong>. Publish it to make it live for customers, then use <strong>Test rule</strong> to verify behaviour.
        </div>
      )}
      {live?.status === 'ACTIVE' && (
        <div className="alert alert-ok">This rule is <strong>live</strong>. It evaluates transactions within its effective dates.</div>
      )}
      {summary && <div className="alert alert-info"><strong>As customers see it:</strong> {summary}</div>}

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'json', label: 'JSON' }]} />

      {tab === 'overview' && <>
        <div className="grid g4">
          <Stat label="Customers with activity" value={num(r.stats.participants)} />
          {r.family === 'SPEND_CONTROL'
            ? <Stat label="Active customer settings" value={num(r.stats.activeSettings)} />
            : <Stat label="Windows achieved" value={num(r.stats.windowsMet)} tone="green" />}
          <Stat label="Points awarded (net)" value={num(r.stats.pointsAwarded)} tone="green" />
          {r.family === 'SPEND_CONTROL'
            ? <Stat label="Breaches" value={num(r.stats.breaches)} tone={r.stats.breaches ? 'amber' : undefined} />
            : <Stat label="Schedule" value={`${def.effective.from ?? 'now'} → ${def.effective.to ?? 'open'}`} />}
        </div>
        <div className="grid g2">
          <Card title={<>Bank values <Badge tone="violet">bank</Badge></>}>
            <KeyVal items={t.params.filter((p) => p.setBy === 'BANK').map((p) => [p.label, formatValue(p, def.params[p.name] ?? p.default)])} />
          </Card>
          <Card title={r.family === 'SPEND_CONTROL' ? <>Customer choices <Badge tone="blue">customer</Badge></> : 'Targeting'}>
            <KeyVal items={[
              ...t.params.filter((p) => p.setBy === 'CUSTOMER').map((p): [string, string] => {
                const b = def.customerParams[p.name] ?? {};
                const range = b.min !== undefined || b.max !== undefined ? `${formatValue(p, b.min ?? p.min)} – ${formatValue(p, b.max ?? p.max)}${b.step ? `, step ${formatValue(p, b.step)}` : ''}` : b.options ? `one or more of ${b.options.map(merchantName).join(', ')}` : 'any';
                return [p.label, `${range}${b.default !== undefined ? ` · default ${Array.isArray(b.default) ? b.default.map(merchantName).join(', ') : formatValue(p, b.default)}` : ''}${b.maxItems ? ` · max ${b.maxItems}` : ''}`];
              }),
              ['Segments', def.segments.length ? def.segments.join(', ') : 'All'],
              ['Eligibility', def.eligibility ? condText(def.eligibility) : 'Everyone in the segments'],
              ...(r.family === 'MISSION' ? [['Enrolment', def.enrollment === 'OPT_IN' ? 'Customer opts in' : 'Automatic'] as [string, string]] : [
                ['Value changes', def.settingsPolicy.changeEffective === 'IMMEDIATE' ? 'Take effect immediately' : 'Take effect from the next window'] as [string, string],
                ['Cooldown', `${def.settingsPolicy.cooldownDays} day(s)`] as [string, string],
              ]),
              ['Effective', `${def.effective.from ?? 'now'} → ${def.effective.to ?? 'open-ended'}`],
              ['Featured', def.featured ? 'Yes' : 'No'],
            ]} />
          </Card>
        </div>
        {r.valueDistribution?.length > 0 && (
          <Card title="What customers chose" pad={false}>
            <DataTable rows={r.valueDistribution} cols={[
              { key: 'p', header: 'Parameter', render: (x: any) => x.param_name },
              { key: 'n', header: 'Customers', align: 'right', render: (x: any) => x.n },
              { key: 'min', header: 'Lowest', align: 'right', render: (x: any) => inr(x.min) },
              { key: 'avg', header: 'Average', align: 'right', render: (x: any) => inr(x.avg) },
              { key: 'max', header: 'Highest', align: 'right', render: (x: any) => inr(x.max) },
            ]} />
          </Card>
        )}
        <div className="row gap wrap">
          <Link to={`/activity?ruleCode=${code}`}>Activity for this rule →</Link>
          <span className="grow" />
          <a className="btn btn-primary" href={`/testing/?rule=${code}`}>Test this rule ↗</a>
        </div>
      </>}

      {tab === 'json' && <Json value={shown.definition} max={700} />}

      {dialog?.action === 'pause' && <ReasonDialog title={`Pause ${code}`} intro="Paused rules stop evaluating immediately." confirm="Pause" onClose={() => setDialog(null)} onSubmit={async (reason) => { await api(`/rules/${code}/pause`, { body: { reason } }); toast.ok('Paused.'); reload(); }} />}
      {dialog?.action === 'retire' && <ReasonDialog title={`Retire ${code}`} intro="Retired rules leave the live pack. Earned points are kept." confirm="Retire" danger onClose={() => setDialog(null)} onSubmit={async (reason) => { await api(`/rules/${code}/retire`, { body: { reason } }); toast.ok('Retired.'); reload(); }} />}
    </div>
  );
}

import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../shared/api';
import { day, dt, num, pretty } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge } from '../../shared/rules-ui';
import { Bars, Card, DataTable, ErrorBox, Loading, Stat, StatusBadge } from '../../shared/ui';

export function Dashboard() {
  const nav = useNavigate();
  const { data: d, error, reload } = useAsync(() => api<any>('/dashboard'), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!d) return <Loading />;
  const count = (family: string, status: string) => d.rules.filter((r: any) => r.family === family && r.status === status).reduce((s: number, r: any) => s + r.n, 0);
  const dec = (k: string) => d.decisions.find((x: any) => x.decision === k)?.n ?? 0;
  return (
    <div className="stack">
      <PageHead title="Dashboard" sub="Spend controls the customer sets, missions the bank sets, one rules engine." />
      <div className="banner row gap wrap">
        <div className="grow">
          <strong>Live rule pack {d.release?.label ?? '-'}</strong>
          <div className="muted">Published {dt(d.release?.publishedAt)} · sha256 <code>{d.release?.hash?.slice(0, 12)}</code> · the same file runs in this server, the testing app and any app embedding <code>@mxp/rules</code>.</div>
        </div>
        <Link className="btn" to="/packs">Rule packs</Link>
        {d.pendingApprovals > 0 && <Link className="btn btn-primary" to="/rules?status=DRAFT">{d.pendingApprovals} draft{d.pendingApprovals === 1 ? '' : 's'}</Link>}
      </div>
      <div className="grid g4">
        <Stat label="Live spend controls" value={count('SPEND_CONTROL', 'ACTIVE')} sub="bank sets the rule, customer sets the value" />
        <Stat label="Live missions" value={count('MISSION', 'ACTIVE')} sub="bank sets the rule and the target" />
        <Stat label="Customer controls set" value={num(d.activeSettings)} sub={`${num(d.customers)} customers`} />
        <Stat label="Points awarded" value={num(d.points.awarded)} sub={`${num(d.points.missions)} missions · ${num(d.points.controls)} controls · ${num(d.points.clawed)} clawed back`} tone="green" />
      </div>
      <div className="grid g4">
        <Stat label="Events (30 days)" value={num(d.events30d)} sub={d.failedEvents ? `${d.failedEvents} failed` : 'none failed'} tone={d.failedEvents ? 'red' : undefined} />
        <Stat label="Limit breaches (30 days)" value={num(d.breaches30d)} tone={d.breaches30d ? 'amber' : undefined} />
        <Stat label="Pre-auth decisions" value={num(d.decisions.reduce((s: number, x: any) => s + x.n, 0))} sub={`${dec('BLOCK')} blocked · ${dec('ALERT')} alerted · ${dec('WARN')} warned`} />
        <Stat label="Drafts" value={d.pendingApprovals} tone={d.pendingApprovals ? 'amber' : undefined} sub="ready to activate" />
      </div>
      <div className="grid g-main">
        <Card title="Points per day (30 days)">
          <Bars data={d.pointsByDay.map((x: any) => ({ label: day(x.day), a: Math.max(0, x.missions) + Math.max(0, x.controls) }))} />
          <small className="muted">Missions and spend-control rewards by the date they were earned: the event date, or the last day of the window for rewards paid at window close.</small>
        </Card>
        <Card title="Closed windows by outcome" pad={false}>
          <DataTable rows={d.outcomes} cols={[
            { key: 'f', header: 'Family', render: (r: any) => <FamilyBadge family={r.family} /> },
            { key: 'o', header: 'Outcome', render: (r: any) => <StatusBadge status={r.outcome} /> },
            { key: 'n', header: 'Windows', align: 'right', render: (r: any) => num(r.n) },
          ]} />
        </Card>
      </div>
      <Card title="Top rules by points" pad={false}>
        <DataTable rows={d.topRules} onRow={(r: any) => nav(`/rules/${r.rule_code}`)} cols={[
          { key: 'c', header: 'Rule', render: (r: any) => <strong>{r.rule_code}</strong> },
          { key: 'f', header: 'Family', render: (r: any) => <FamilyBadge family={r.family} /> },
          { key: 'e', header: 'Ledger entries', align: 'right', render: (r: any) => num(r.entries) },
          { key: 'p', header: 'Net points', align: 'right', render: (r: any) => num(r.points) },
        ]} />
      </Card>
      <small className="muted">{pretty('Rule status counts')}: {d.rules.map((r: any) => `${r.family === 'MISSION' ? 'missions' : 'controls'} ${pretty(r.status).toLowerCase()} ${r.n}`).join(' · ')}</small>
    </div>
  );
}

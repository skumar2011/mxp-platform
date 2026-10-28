import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../shared/api';
import { day, num } from '../../shared/format';
import { useAsync } from '../../shared/hooks';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge } from '../../shared/rules-ui';
import { Bars, Button, Card, DataTable, ErrorBox, Loading, Stat, StatusBadge } from '../../shared/ui';

export function Dashboard() {
  const nav = useNavigate();
  const { data, error, reload } = useAsync(async () => {
    const [d, rules] = await Promise.all([api<any>('/dashboard'), api<any[]>('/rules')]);
    return { d, rules };
  }, []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const { d, rules } = data;
  const sched = d.ruleSchedule ?? {};
  const missions = rules.filter((r) => r.family === 'MISSION');
  const controls = rules.filter((r) => r.family === 'SPEND_CONTROL');
  const drafts = rules.filter((r) => r.latestStatus === 'DRAFT');
  const dec = (k: string) => d.decisions.find((x: any) => x.decision === k)?.n ?? 0;

  return (
    <div className="stack">
      <PageHead
        title="Dashboard"
        sub="Missions the bank sets. Spend controls the customer sets. Create, publish, and test from here."
        actions={<>
          <Button variant="primary" onClick={() => nav('/rules/new')}>Create rule</Button>
          <a className="btn" href="/testing/">Test rules ↗</a>
          {drafts.length > 0 && <Button onClick={() => nav('/rules?status=DRAFT')}>Publish drafts ({drafts.length})</Button>}
        </>}
      />

      <div className="grid g4">
        <Stat label="Running missions" value={missions.filter((r) => r.scheduleStatus === 'RUNNING').length} sub={`${missions.length} total`} tone="green" />
        <Stat label="Running spend controls" value={controls.filter((r) => r.scheduleStatus === 'RUNNING').length} sub={`${controls.length} total`} tone="green" />
        <Stat label="Paused / expired" value={num((sched.PAUSED ?? 0) + (sched.EXPIRED ?? 0))} sub={`${num(sched.PAUSED)} paused · ${num(sched.EXPIRED)} expired`} tone={(sched.PAUSED || sched.EXPIRED) ? 'amber' : undefined} />
        <Stat label="Achieved windows" value={num(d.achieved?.windows)} sub={`${num(d.achieved?.customers)} customers hit a goal`} tone="green" />
      </div>

      <div className="grid g4">
        <Stat label="Points awarded" value={num(d.points.awarded)} sub={`${num(d.points.missions)} missions · ${num(d.points.controls)} controls · ${num(d.points.clawed)} clawed`} tone="green" />
        <Stat label="Events (30 days)" value={num(d.events30d)} sub={d.failedEvents ? `${d.failedEvents} failed` : 'none failed'} tone={d.failedEvents ? 'red' : undefined} />
        <Stat label="Limit breaches (30 days)" value={num(d.breaches30d)} tone={d.breaches30d ? 'amber' : undefined} />
        <Stat label="Customers" value={num(d.customers)} sub={`${num(d.activeSettings)} active spend settings · ${dec('BLOCK')} blocked`} />
      </div>

      <div className="grid g2">
        <Card
          title="Missions"
          actions={<Link className="btn btn-sm" to="/rules?family=MISSION">View all</Link>}
          pad={false}
        >
          <DataTable
            rows={missions.slice(0, 8)}
            empty="No missions yet. Create one from a template."
            onRow={(r) => nav(`/rules/${r.code}`)}
            rowKey={(r) => r.code}
            cols={[
              { key: 'n', header: 'Rule', render: (r) => <><strong>{r.name}</strong><br /><code>{r.code}</code></> },
              { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.scheduleStatus} /> },
              { key: 'd', header: 'Ends', render: (r) => <span className="muted">{r.effectiveTo ?? 'open'}</span> },
            ]}
          />
        </Card>
        <Card
          title="Spend controls"
          actions={<Link className="btn btn-sm" to="/rules?family=SPEND_CONTROL">View all</Link>}
          pad={false}
        >
          <DataTable
            rows={controls.slice(0, 8)}
            empty="No spend controls yet. Create one from a template."
            onRow={(r) => nav(`/rules/${r.code}`)}
            rowKey={(r) => r.code}
            cols={[
              { key: 'n', header: 'Rule', render: (r) => <><strong>{r.name}</strong><br /><code>{r.code}</code></> },
              { key: 's', header: 'Status', render: (r) => <StatusBadge status={r.scheduleStatus} /> },
              { key: 'd', header: 'Ends', render: (r) => <span className="muted">{r.effectiveTo ?? 'open'}</span> },
            ]}
          />
        </Card>
      </div>

      <div className="grid g-main">
        <Card title="Points per day (30 days)">
          <Bars data={d.pointsByDay.map((x: any) => ({ label: day(x.day), a: Math.max(0, x.missions) + Math.max(0, x.controls) }))} />
        </Card>
        <Card title="Closed windows by outcome" pad={false}>
          <DataTable rows={d.outcomes} empty="No closed windows yet." cols={[
            { key: 'f', header: 'Family', render: (r: any) => <FamilyBadge family={r.family} /> },
            { key: 'o', header: 'Outcome', render: (r: any) => <StatusBadge status={r.outcome} /> },
            { key: 'n', header: 'Windows', align: 'right', render: (r: any) => num(r.n) },
          ]} />
        </Card>
      </div>
    </div>
  );
}

import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { generateBoundaryCases, runScenario, type Scenario, type ScenarioResult } from '@mxp/rules';
import { useAuth } from '../../shared/auth';
import { pts } from '../../shared/format';
import { PageHead } from '../../shared/Layout';
import { FamilyBadge } from '../../shared/rules-ui';
import { Alert, Badge, Button, Card, Loading, StatusBadge, useToast } from '../../shared/ui';
import { PackPicker, usePack } from '../pack';
import { recordRun, saveScenario } from '../scenario-utils';

interface RuleRow { code: string; name: string; family: string; template: string; cases: { sc: Scenario; res: ScenarioResult }[]; error?: string }

/**
 * Boundary matrix: for every rule in the pack, derive below / at / above-target, scope,
 * eligibility, opt-in, reversal and cap cases from the rule's own values and run them.
 */
export function Matrix() {
  const { engine, source, hash } = usePack();
  const { can } = useAuth();
  const toast = useToast();
  const [family, setFamily] = useState<'ALL' | 'SPEND_CONTROL' | 'MISSION'>('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo<RuleRow[]>(() => {
    if (!engine) return [];
    return engine.listRules().map((r) => {
      try {
        const cases = generateBoundaryCases(engine, r.code).map((sc) => ({ sc, res: runScenario(engine, sc) }));
        return { ...r, cases };
      } catch (e) {
        return { ...r, cases: [], error: (e as Error).message };
      }
    });
  }, [engine]);
  if (!engine) return <div className="stack"><PageHead title="Boundary matrix" /><PackPicker /><Loading /></div>;

  const shown = rows.filter((r) => family === 'ALL' || r.family === family);
  const all = shown.flatMap((r) => r.cases);
  const failed = all.filter((c) => !c.res.passed).length;
  const errored = shown.filter((r) => r.error).length;

  const record = async () => {
    setBusy(true);
    try {
      await recordRun('MATRIX', source, hash, all.map((c) => ({ name: c.sc.name ? `${c.sc.focusRule}: ${c.sc.name}` : String(c.sc.id), passed: c.res.passed, failures: c.res.failures })));
      toast.ok('Matrix run recorded.');
    } catch (e) { toast.err(e); }
    setBusy(false);
  };
  const keep = async (sc: Scenario) => {
    try { await saveScenario({ ...sc, name: `${sc.focusRule}: ${sc.name}` }); toast.ok('Saved to regression scenarios.'); } catch (e) { toast.err(e); }
  };

  return (
    <div className="stack">
      <PageHead title="Boundary matrix" sub="Cases derived from each rule's own definition: exactly at the target, one below and one above, out of scope, wrong segment, not opted in, refunds and caps. A failure means the rule does not behave the way its values say it should."
        actions={can('tests:write') && <Button variant="primary" busy={busy} disabled={!all.length} onClick={record}>Record this run</Button>} />
      <PackPicker />
      <div className="row gap wrap">
        <div className="pill">
          {(['ALL', 'SPEND_CONTROL', 'MISSION'] as const).map((f) => <button key={f} className={family === f ? 'on' : ''} onClick={() => setFamily(f)}>{f === 'ALL' ? 'All rules' : f === 'MISSION' ? 'Missions' : 'Spend controls'}</button>)}
        </div>
        <span className="muted">{shown.length} rules · {all.length} cases</span>
      </div>
      <Alert tone={failed || errored ? 'err' : 'ok'}>
        <strong>{all.length - failed} / {all.length} cases pass.</strong>
        {errored > 0 && ` ${errored} rule(s) could not generate cases.`}
        {' '}Spend controls use the bank default (or mid-range) customer value; missions use the bank target.
      </Alert>
      <Card pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Rule</th><th>Family</th><th>Template</th><th style={{ textAlign: 'right' }}>Cases</th><th>Result</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => {
                const f = r.cases.filter((c) => !c.res.passed).length;
                return (
                  <Fragment key={r.code}>
                    <tr className="clickable" onClick={() => setExpanded(expanded === r.code ? null : r.code)}>
                      <td><strong>{r.code}</strong><div className="muted" style={{ fontSize: 12 }}>{r.name}</div></td>
                      <td><FamilyBadge family={r.family} /></td>
                      <td><code>{r.template}</code></td>
                      <td style={{ textAlign: 'right' }}>{r.cases.length}</td>
                      <td>{r.error ? <Badge tone="red">error</Badge> : f ? <Badge tone="red">{f} failed</Badge> : <Badge tone="green">all pass</Badge>}</td>
                      <td style={{ textAlign: 'right' }}><Link to={`/?rule=${r.code}`} onClick={(e) => e.stopPropagation()}>Simulate →</Link></td>
                    </tr>
                    {expanded === r.code && (
                      <tr><td colSpan={6} style={{ background: 'var(--bg)' }}>
                        {r.error && <Alert tone="err">{r.error}</Alert>}
                        <div className="evals">
                          {r.cases.map((c, i) => (
                            <div key={i} className="eval">
                              <div className="row gap wrap">
                                <StatusBadge status={c.res.passed ? 'PASSED' : 'FAILED'} />
                                <strong>{c.sc.name}</strong>
                                {(c.sc.tags ?? []).filter((t) => t !== 'generated').map((t) => <Badge key={t}>{t}</Badge>)}
                                <span className="muted">{c.sc.steps.length} steps · {pts(c.res.totalPoints)} pts</span>
                                <span className="grow" />
                                {can('tests:write') && <Button small onClick={() => keep(c.sc)}>Save as scenario</Button>}
                              </div>
                              {c.res.failures.map((x, k) => <div key={k} style={{ color: 'var(--red)', fontSize: 12.5 }}>✗ {x}</div>)}
                            </div>
                          ))}
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

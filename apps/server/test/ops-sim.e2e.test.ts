import { describe, expect, it } from 'vitest';
import { cardEvent, makeApp } from './helpers';

describe('testing app API: cases, suites, runs and downloads', () => {
  it('saves, clones, runs and reruns a case; stores every run with expected vs actual', async () => {
    const t = await makeApp();
    const input = {
      name: 'Spend 12k', rules: [{ ruleCode: 'CARD_SPEND_10K' }],
      scenario: {
        timezone: 'Asia/Kolkata', customer: { status: 'ACTIVE', kycStatus: 'FULL' }, accounts: [{ ref: 'CC-1', productCode: 'CC_GOLD' }],
        steps: [{ kind: 'TXN', id: 't1', at: '2026-10-02', type: 'PURCHASE', channel: 'CARD_ONLINE', amount: 12000, accountRef: 'CC-1' }], asOf: '2026-10-10',
      },
      expected: { totalPoints: 300, noDuplicateAwards: true },
    };
    const saved = await t.call('POST', '/api/sim/cases', 'qa', { name: 'Spend 12k earns 300', category: 'POSITIVE', input });
    expect(saved.status).toBe(201);
    const id = saved.json.caseId;
    const clone = await t.call('POST', `/api/sim/cases/${id}/clone`, 'qa', {});
    expect(clone.status).toBe(201);
    expect(clone.json.clonedFrom).toBe(id);
    const run = await t.call('POST', `/api/sim/cases/${id}/run`, 'qa', {});
    expect(run.json.status).toBe('PASSED');
    const rerun = await t.call('POST', `/api/sim/cases/${id}/run`, 'qa', {});
    expect(rerun.json.runId).not.toBe(run.json.runId);
    const detail = await t.call('GET', `/api/sim/cases/${id}`, 'qa');
    expect(detail.json.runs).toHaveLength(2);
    const result = await t.call('GET', `/api/sim/runs/${run.json.runId}`, 'qa');
    expect(result.json.result.final.totalPoints).toBe(300);
    expect(result.json.checks.every((c: any) => c.pass)).toBe(true);
    const dl = await t.call('GET', `/api/sim/runs/${run.json.runId}/download`, 'qa');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['content-type']).toContain('text/csv');
    expect(dl.text.split('\n')[0]).toBe('section,name,expected,actual,result');
    expect(dl.text).toContain('300');
    // nothing reached production
    expect(t.db.value("SELECT COUNT(*) FROM customer WHERE customer_ref = 'SIM-CUST-001'")).toBe(0);
  });

  it('a failing expectation is reported with expected and actual values', async () => {
    const t = await makeApp();
    const r = await t.call('POST', '/api/sim/run', 'qa', {
      input: {
        rules: [{ ruleCode: 'CARD_SPEND_10K' }],
        scenario: { timezone: 'Asia/Kolkata', accounts: [{ ref: 'CC-1', productCode: 'CC_GOLD' }], steps: [{ kind: 'TXN', id: 't1', at: '2026-10-02', type: 'PURCHASE', channel: 'CARD_ONLINE', amount: 12000, accountRef: 'CC-1' }], asOf: '2026-10-10' },
        expected: { totalPoints: 999 },
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('FAILED');
    expect(r.json.result.checks.find((c: any) => !c.pass)).toMatchObject({ expected: '999', actual: '300' });
  });

  it('runs a regression suite over saved matrix cases and offers a download', async () => {
    const t = await makeApp();
    const m = await t.call('POST', '/api/sim/matrix', 'qa', { rule: { ruleCode: 'UPI_10_TXNS' }, save: true, run: true });
    expect(m.json.suite.failed + m.json.suite.errors).toBe(0);
    const suite = await t.call('POST', '/api/sim/suites/run', 'qa', { ruleCode: 'UPI_10_TXNS', mode: 'LIVE', label: 'nightly' });
    expect(suite.json.passed).toBe(suite.json.total);
    const list = await t.call('GET', '/api/sim/suites', 'qa');
    expect(list.json.rows?.length ?? list.json.suites?.length).toBeGreaterThanOrEqual(2);
    const dl = await t.call('GET', `/api/sim/suites/${suite.json.suiteRunId}/download`, 'qa');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('text/csv');
    expect(dl.text.split('\n').filter(Boolean).length).toBe(suite.json.total + 1);
  });

  it('previews a rule against a real customer without writing anything', async () => {
    const t = await makeApp();
    const before = t.db.value<number>('SELECT COUNT(*) FROM xp_ledger');
    const r = await t.call('POST', '/api/sim/preview', 'qa', { rule: { ruleCode: 'CARD_SPEND_10K' }, customerRef: 'CUST-1004', fromDate: '2026-08-15', toDate: '2026-10-10' });
    expect(r.status).toBe(200);
    expect(r.json.final.totalPoints).toBe(300);
    expect(t.db.value('SELECT COUNT(*) FROM xp_ledger')).toBe(before);
  });

  it('caps the size of performance runs', async () => {
    const t = await makeApp();
    const r = await t.call('POST', '/api/sim/perf', 'qa', { rule: { ruleCode: 'UPI_10_TXNS' }, customers: 20, txnsPerCustomer: 12 });
    expect(r.status).toBe(200);
    expect(r.json.duplicateAwards).toBe(0);
    expect((await t.call('POST', '/api/sim/perf', 'qa', { rule: { ruleCode: 'UPI_10_TXNS' }, customers: 5000, txnsPerCustomer: 200 })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('operations: batches, events, replay, backfill, reconciliation', () => {
  it('a batch with wrong control totals is flagged and reconciliation reports it', async () => {
    const t = await makeApp();
    const b = await t.call('POST', '/api/ingest/batches', 'ops', { sourceSystem: 'CARDS', fileName: 'cards-2026-10-09.csv', controlCount: 3, controlAmount: 5000 });
    const batchId = b.json.batchId;
    await t.call('POST', '/api/ingest', 'ops', { batchId, events: [cardEvent('B-1', 1000, '2026-10-05T10:00:00+05:30'), cardEvent('B-2', 1000, '2026-10-05T11:00:00+05:30')] });
    const closed = await t.call('POST', `/api/ingest/batches/${batchId}/close`, 'ops');
    expect(closed.json.status).toBe('MISMATCH');
    const recon = await t.call('POST', '/api/ops/reconcile', 'ops', {});
    expect(recon.json.status).toBe('FAILED');
    expect(recon.json.breaks.map((x: any) => x.type)).toContain('BATCH_CONTROL');
  });

  it('a rejected event can be inspected, fixed and replayed; the history shows every stage', async () => {
    const t = await makeApp();
    const bad = cardEvent('R-1', 1500, '2026-10-05T10:00:00+05:30', { categoryCode: 'NOT_A_CATEGORY' });
    const r = await t.call('POST', '/api/ingest', 'ops', { events: [bad] });
    expect(r.json.results[0].errors[0].code).toBe('UNKNOWN_REFERENCE');
    const list = await t.call('GET', '/api/events?status=REJECTED', 'ops');
    expect(list.json.total).toBe(1);
    const ev = await t.call('GET', `/api/events/${list.json.rows[0].eventId}`, 'ops');
    expect(ev.json.payload.transaction.categoryCode).toBe('NOT_A_CATEGORY');
    expect(ev.json.history.map((h: any) => h.stage)).toContain('NORMALIZE');
    // a corrected resubmission under the same event id is accepted
    const fixed = await t.call('POST', '/api/ingest', 'ops', { events: [cardEvent('R-1', 1500, '2026-10-05T10:00:00+05:30')] });
    expect(fixed.json.results[0].status).toBe('ACCEPTED');
    // replay of a processed event is refused
    const done = await t.call('GET', '/api/events?q=R-1', 'ops');
    expect((await t.call('POST', `/api/events/${done.json.rows[0].eventId}/replay`, 'ops')).status).toBe(409);
  });

  it('backfill and period close are idempotent over the API', async () => {
    const t = await makeApp();
    const before = t.db.value<number>('SELECT SUM(points) FROM xp_ledger');
    for (let i = 0; i < 2; i++) {
      expect((await t.call('POST', '/api/ops/rules/CARD_SPEND_10K/backfill', 'ops', {})).status).toBe(200);
      expect((await t.call('POST', '/api/ops/close-periods', 'ops', {})).status).toBe(200);
    }
    expect(t.db.value('SELECT SUM(points) FROM xp_ledger')).toBe(before);
    expect((await t.call('POST', '/api/ops/reconcile', 'ops', {})).json.status).toBe('PASSED');
  });

  it('the dashboard and health endpoints summarise the system', async () => {
    const t = await makeApp();
    const d = await t.call('GET', '/api/dashboard', 'maker');
    expect(d.status).toBe(200);
    expect(JSON.stringify(d.json)).toContain('3700');
    const h = await t.call('GET', '/api/ops/health', 'ops');
    expect(h.status).toBe(200);
  });
});

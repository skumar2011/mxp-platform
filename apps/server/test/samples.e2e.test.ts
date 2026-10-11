import { describe, expect, it } from 'vitest';
import { seedReference, seedUsers } from '@mxp/engine';
import { loadSamples } from '../src/loadSamples';
import { makeApp, NOW } from './helpers';

/**
 * The shipped samples/ folder, loaded through the public API on an empty system, reproduces the documented outcomes.
 * (docs/08-sample-data.md)
 */
describe('sample dataset loaded through the API', () => {
  it('produces the documented rewards with no duplicates and a clean reconciliation', async () => {
    const t = await makeApp({ seed: false });
    seedReference(t.db);
    t.clock.set(new Date('2026-09-01T00:30:00+05:30'));
    seedUsers(t.db, t.clock);
    const dir = new URL('../../../samples', import.meta.url).pathname;
    const res = await loadSamples((m, u, as, b) => t.call(m, u, as, b), { dir, beforeDelivery: (at) => { t.clock.set(new Date(at)); } });
    t.clock.set(NOW);
    await t.call('POST', '/api/ops/close-periods', 'ops', {});

    expect(res.customers.created).toBe(5);
    expect(res.events).toEqual({ accepted: 244, rejected: 0 });

    const net = (c: string, r?: string) =>
      t.db.value<number>(`SELECT COALESCE(SUM(points),0) FROM xp_ledger l JOIN customer c USING(customer_id) JOIN rule ru USING(rule_id) WHERE c.customer_ref = ? ${r ? 'AND ru.rule_code = ?' : ''}`, ...(r ? [c, r] : [c]));
    expect(net('CUST-1001', 'CARD_SPEND_10K')).toBe(300);
    expect(net('CUST-1001', 'UPI_10_TXNS')).toBe(100);
    expect(net('CUST-1001', 'UTILITY_3_BILLS')).toBe(150);
    expect(net('CUST-1002')).toBe(0); // 9,999 spend, 9 UPI payments, balance just under 50k: all near misses
    expect(net('CUST-1003', 'SAV_GROWTH_25K')).toBe(400);
    expect(net('CUST-1004', 'BALANCE_PLUS_CARD')).toBe(1000);
    expect(t.db.value<number>("SELECT SUM(points) FROM xp_ledger WHERE points > 0")).toBe(3700);
    expect(t.db.value<number>('SELECT SUM(points) FROM xp_ledger')).toBe(3400);
    expect(t.db.value("SELECT COUNT(*) FROM (SELECT idempotency_key FROM xp_ledger GROUP BY 1 HAVING COUNT(*) > 1)")).toBe(0);
    expect((await t.call('GET', '/api/rules/UPI_MERCHANT_PER_TXN', 'checker')).json.versions[0].status).toBe('PENDING_APPROVAL');
    expect((await t.call('POST', '/api/ops/reconcile', 'ops', {})).json.status).toBe('PASSED');
    expect((await t.call('GET', '/api/audit/verify', 'auditor')).json.ok).toBe(true);

    // loading again is harmless: customers are skipped and every event is a duplicate
    const again = await t.call('POST', '/api/admin/customers/import', 'admin', JSON.parse(await (await import('node:fs/promises')).readFile(`${dir}/customers.json`, 'utf8')));
    expect(again.json).toMatchObject({ created: 0, skipped: 5 });
  });

  it('rejects a customer import with an unknown product instead of corrupting data', async () => {
    const t = await makeApp({ seed: false });
    seedReference(t.db);
    const r = await t.call('POST', '/api/admin/customers/import', 'admin', { customers: [{ ref: 'C-X', name: 'X', accounts: [{ ref: 'A-X', product: 'NOPE', type: 'SAVINGS', openedOn: '2024-01-01' }] }] });
    expect(r.status).toBe(422);
    expect(t.db.value('SELECT COUNT(*) FROM customer')).toBe(0);
  });
});

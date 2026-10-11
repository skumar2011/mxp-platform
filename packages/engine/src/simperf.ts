import { runReconciliation } from './recon';
import { createSandbox } from './sim';
import { buildAccountTemplate, buildTemplate } from './simgen';
import type { RuleSource, SimRuleRef } from './simtypes';
import { isBalanceMetric } from './ruleDef';
import { addDays, daysBetween, periodOf, zonedToIso } from './time';
import { MxpError, uid } from './util';

export interface PerfOptions {
  rule: SimRuleRef;
  customers?: number;
  txnsPerCustomer?: number;
  /** Fraction of events re-delivered to prove idempotency under load. */
  duplicateRatio?: number;
}

export interface PerfResult {
  ruleCode: string;
  customers: number;
  events: number;
  duplicatesDelivered: number;
  durationMs: number;
  eventsPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  ledgerEntries: number;
  totalPoints: number;
  customersRewarded: number;
  duplicateAwards: number;
  ledgerStableAfterDuplicates: boolean;
  reconciliation: string;
  rejected: number;
  limits: string[];
}

const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

/** Synthetic load against an isolated sandbox: throughput, latency and idempotency at volume. */
export function runPerformance(source: RuleSource, o: PerfOptions): PerfResult {
  const customers = Math.min(Math.max(1, Math.floor(o.customers ?? 200)), 5000);
  const per = Math.min(Math.max(1, Math.floor(o.txnsPerCustomer ?? 20)), 200);
  const dupRatio = Math.min(Math.max(0, o.duplicateRatio ?? 0.1), 1);
  const limits: string[] = [];
  if ((o.customers ?? 0) > 5000) limits.push('Customers capped at 5,000.');
  if ((o.txnsPerCustomer ?? 0) > 200) limits.push('Transactions per customer capped at 200.');

  const sb = createSandbox(source, [o.rule]);
  try {
    if (sb.problems.length) throw new MxpError('RULE_INVALID', `The rule has ${sb.problems.length} validation problem(s).`, 422, sb.problems);
    const sr = sb.rules.find((r) => r.ruleCode === o.rule.ruleCode)!;
    const def = sr.def;
    const ref = source.referenceData();
    const refData = {
      channels: (ref.channel_ref ?? []).map((x) => x.channel_code), types: (ref.txn_type_ref ?? []).filter((x) => !x.is_reversal).map((x) => x.txn_type_code),
      categories: (ref.txn_category_ref ?? []).map((x) => x.category_code), products: (ref.product_ref ?? []).map((x) => ({ code: x.product_code, family: x.product_family })),
      segments: (ref.segment ?? []).map((x) => x.segment_code),
    };
    const balance = isBalanceMetric(def.metric?.type);
    if (def.kind === 'COMBINED') throw new MxpError('NOT_SUPPORTED', 'Choose a component goal for the performance test.', 422);
    const tpl = balance ? buildAccountTemplate(def, refData) : buildTemplate(def, refData);
    if (!tpl.ok) throw new MxpError('NO_TEMPLATE', tpl.notes.join(' ') || 'Could not derive transactions for this rule.', 422);
    const campaign = def.campaignCode ? source.campaign(def.campaignCode) : undefined;
    const window = campaign ? { code: campaign.campaign_code, start: campaign.start_date, end: campaign.end_date } : null;
    const from = [def.effective.from, campaign?.start_date].filter(Boolean).sort().at(-1) ?? '2026-06-01';
    const anchor = from > '2026-06-01' ? from : '2026-06-01';
    let period = periodOf(anchor, def.period.type, window);
    if (def.period.type !== 'CAMPAIGN' && period.start < from) period = periodOf(addDays(period.end, 1), def.period.type, window);
    const tz = def.period.timezone;
    const top = def.tiers.length ? def.tiers[def.tiers.length - 1].threshold : 0;

    sb.clock.set(zonedToIso(period.end, '23:00', tz));
    const now = sb.clock.now().toISOString();
    const db = sb.db;
    const custIds: { id: string; ref: string; acc: string }[] = [];
    db.tx(() => {
      for (let i = 0; i < customers; i++) {
        const cid = uid();
        const ref = `PERF-${i}`;
        const accRef = `PACC-${i}`;
        db.run('INSERT INTO customer(customer_id, customer_ref, masked_name, status, customer_type, kyc_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', cid, ref, 'Perf', 'ACTIVE', tpl.customer.type ?? 'RETAIL', tpl.customer.kycStatus ?? 'FULL', now, now);
        for (const s of tpl.customer.segments ?? []) {
          db.run('INSERT OR IGNORE INTO segment(segment_code, name) VALUES (?,?)', s, s);
          db.run('INSERT INTO customer_segment(customer_id, segment_code, valid_from) VALUES (?,?,?)', cid, s, '2000-01-01');
        }
        const aid = uid();
        const p = db.get<{ product_family: string }>('SELECT product_family FROM product_ref WHERE product_code = ?', tpl.account.productCode)!;
        db.run('INSERT INTO account(account_id, customer_id, account_ref, product_code, account_type, status, opened_on, created_at) VALUES (?,?,?,?,?,?,?,?)', aid, cid, accRef, tpl.account.productCode, p.product_family, tpl.account.status ?? 'ACTIVE', '2000-01-01', now);
        const instType = tpl.instrumentType;
        if (instType) db.run('INSERT INTO instrument(instrument_id, customer_id, account_id, instrument_ref, instrument_type, product_code) VALUES (?,?,?,?,?,?)', uid(), cid, aid, `${accRef}-INS`, instType, tpl.account.productCode);
        custIds.push({ id: cid, ref, acc: accRef });
      }
    });

    const events: any[] = [];
    const len = daysBetween(period.start, period.end) + 1;
    for (const c of custIds) {
      if (balance) {
        const days = len;
        for (let d = 0; d < days; d++) {
          const date = addDays(period.start, d);
          events.push({ eventType: 'BALANCE_SNAPSHOT', sourceSystem: 'PERF', sourceEventId: `${c.acc}:${date}`, snapshot: { accountRef: c.acc, asOfDate: date, closingBalance: top * 1.2 } });
        }
      } else {
        const perAmount = def.kind === 'PER_EVENT' ? Math.max(tpl.minAmount, 500) : def.metric?.type === 'SUM' ? Math.max(tpl.minAmount, Math.round((top * 1.1 * 100) / per) / 100) : Math.max(tpl.minAmount, 500);
        for (let t = 0; t < per; t++) {
          const day = addDays(period.start, t % len);
          events.push({
            eventType: 'TRANSACTION', sourceSystem: 'PERF', sourceEventId: `${c.ref}-T${t}`,
            transaction: {
              sourceTxnId: `${c.ref}-T${t}`, customerRef: c.ref, accountRef: c.acc, instrumentRef: tpl.instrumentType ? `${c.acc}-INS` : undefined, productCode: tpl.productCode,
              txnType: tpl.type, categoryCode: tpl.category, channel: tpl.channel, amount: perAmount, drCr: tpl.drCr, status: 'POSTED', mcc: tpl.mcc, merchantId: tpl.merchantId,
              attributes: Object.keys(tpl.attributes).length ? tpl.attributes : undefined,
              txnTimestamp: zonedToIso(day, `${String(9 + (t % 10)).padStart(2, '0')}:${String((t * 7) % 60).padStart(2, '0')}`, tz),
            },
          });
        }
      }
    }
    if (events.length > 100_000) throw new MxpError('TOO_BIG', 'The test would generate more than 100,000 events. Reduce customers or transactions per customer.', 422);

    const lat: number[] = [];
    const t0 = performance.now();
    let rejected = 0;
    for (const e of events) {
      const s = performance.now();
      const r = sb.engine.ingestAndProcess([e]);
      lat.push(performance.now() - s);
      if (r.results[0].status === 'REJECTED') rejected++;
    }
    const duration = performance.now() - t0;
    const ledgerBefore = db.value<number>('SELECT COUNT(*) FROM xp_ledger') ?? 0;
    // Re-deliver a share of events: nothing may change.
    const dupCount = Math.floor(events.length * dupRatio);
    for (let i = 0; i < dupCount; i++) sb.engine.ingestAndProcess([events[(i * 7919) % events.length]]);
    const ledgerAfter = db.value<number>('SELECT COUNT(*) FROM xp_ledger') ?? 0;
    const dupAwards = db.value<number>(
      `SELECT COUNT(*) FROM (SELECT customer_id, rule_id, period_key, slot,
         SUM(CASE WHEN entry_type='AWARD' THEN 1 ELSE 0 END) - SUM(CASE WHEN entry_type='REVERSAL' THEN 1 ELSE 0 END) AS net FROM xp_ledger GROUP BY 1,2,3,4 HAVING net > 1)`,
    ) ?? 0;
    const recon = runReconciliation(sb.engine.ctx, { username: 'perf', roles: ['SYSTEM'] });
    lat.sort((a, b) => a - b);
    return {
      ruleCode: o.rule.ruleCode, customers, events: events.length, duplicatesDelivered: dupCount, durationMs: Math.round(duration),
      eventsPerSecond: Math.round((events.length / duration) * 1000),
      latencyMs: { p50: +pct(lat, 50).toFixed(2), p95: +pct(lat, 95).toFixed(2), p99: +pct(lat, 99).toFixed(2), max: +(lat[lat.length - 1] ?? 0).toFixed(2) },
      ledgerEntries: ledgerAfter, totalPoints: db.value<number>('SELECT COALESCE(SUM(points),0) FROM xp_ledger') ?? 0,
      customersRewarded: db.value<number>('SELECT COUNT(DISTINCT customer_id) FROM xp_ledger') ?? 0,
      duplicateAwards: dupAwards, ledgerStableAfterDuplicates: ledgerBefore === ledgerAfter, reconciliation: recon.status, rejected, limits,
    };
  } finally {
    sb.db.close();
  }
}

/**
 * Regenerates the files in samples/ from the seed definitions, for the fixed reference date 2026-10-10.
 *   npx tsx scripts/export-samples.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { arrivalOf, buildSampleEvents, sampleCampaigns, sampleRulePending, sampleRules, SAMPLE_CUSTOMERS } from '../packages/engine/src/index';

const NOW = new Date('2026-10-10T09:00:00Z');
const clock = { now: () => NOW };
const out = (f: string, v: unknown) => writeFileSync(new URL(`../samples/${f}`, import.meta.url), JSON.stringify(v, null, 2) + '\n');
mkdirSync(new URL('../samples/rules/', import.meta.url), { recursive: true });

const c = sampleCampaigns(clock);
out('campaigns.json', { campaigns: [c.alwaysOn, c.utility] });
out('customers.json', { customers: SAMPLE_CUSTOMERS });
for (const r of [...sampleRules(clock), sampleRulePending()]) out(`rules/${r.code}.json`, { code: r.code, changeNote: 'Initial version', definition: r.def });

const events = buildSampleEvents(clock)
  .map((event: any) => ({ arrivedAt: arrivalOf(event).toISOString(), event }))
  .filter((x: any) => x.event.eventType !== 'TRANSACTION' || new Date(x.event.transaction.txnTimestamp) <= NOW)
  .map((x: any) => ({ ...x, arrivedAt: x.arrivedAt > NOW.toISOString() ? NOW.toISOString() : x.arrivedAt }))
  .sort((a: any, b: any) => a.arrivedAt.localeCompare(b.arrivedAt));
out('events.json', { note: 'arrivedAt is when the source system delivered the event; the loader replays in this order.', events });
console.log('campaigns, customers, rules and', events.length, 'events written to samples/');

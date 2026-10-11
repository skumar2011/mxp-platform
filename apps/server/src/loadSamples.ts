import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A minimal transport so the same loader drives a live server (fetch) or an in-process app (tests). */
export type Call = (method: 'GET' | 'POST', url: string, as: string, body?: unknown) => Promise<{ status: number; json: any }>;

export interface LoadOptions {
  dir: string;
  /** Users that hold the maker, checker, activator and ingest/ops roles. Defaults to the demo users. */
  users?: { maker: string; checker: string; admin: string; ops: string };
  /** Called before each day's events are delivered, so tests can move a fixed clock to the arrival time. */
  beforeDelivery?: (arrivedAt: string) => void | Promise<void>;
  log?: (msg: string) => void;
}

const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

function ok(step: string, r: { status: number; json: any }) {
  if (r.status >= 300) throw new Error(`${step} failed (${r.status}): ${JSON.stringify(r.json?.error ?? r.json)}`);
  return r.json;
}

/**
 * Loads the sample dataset through the public API only, following the same maker-checker path an administrator would:
 * customers -> campaigns -> rules (create, submit, approve, activate) -> transactions in arrival order.
 */
export async function loadSamples(call: Call, o: LoadOptions) {
  const u = o.users ?? { maker: 'maker', checker: 'checker', admin: 'admin', ops: 'ops' };
  const log = o.log ?? (() => {});

  const customers = read(o.dir, 'customers.json');
  const imp = ok('customer import', await call('POST', '/api/admin/customers/import', u.admin, customers));
  log(`customers: ${imp.created} created, ${imp.skipped} skipped`);

  for (const c of read(o.dir, 'campaigns.json').campaigns) {
    ok(`campaign ${c.code}`, await call('POST', '/api/campaigns', u.maker, c));
    ok(`campaign ${c.code} activate`, await call('POST', `/api/campaigns/${c.code}/status`, u.admin, { status: 'ACTIVE' }));
  }
  log('campaigns: active');

  const files = ['SAV_AVG_BAL_50K', 'CARD_SPEND_10K', 'UPI_10_TXNS', 'UTILITY_3_BILLS', 'SAV_GROWTH_25K', 'BALANCE_PLUS_CARD', 'UPI_MERCHANT_PER_TXN'];
  for (const code of files) {
    const r = read(o.dir, `rules/${code}.json`);
    ok(`create ${code}`, await call('POST', '/api/rules', u.maker, r));
    ok(`submit ${code}`, await call('POST', `/api/rules/${code}/versions/1/submit`, u.maker));
    if (code === 'UPI_MERCHANT_PER_TXN') continue; // left in the approval queue on purpose
    ok(`approve ${code}`, await call('POST', `/api/rules/${code}/versions/1/approve`, u.checker, { note: 'Approved for launch' }));
    ok(`activate ${code}`, await call('POST', `/api/rules/${code}/versions/1/activate`, u.admin, {}));
  }
  log(`rules: ${files.length - 1} active, 1 pending approval`);

  const { events } = read(o.dir, 'events.json') as { events: { arrivedAt: string; event: unknown }[] };
  // With a clock hook each distinct arrival time is its own delivery (so nothing is ever future-dated); otherwise deliver by day.
  const keyOf = (at: string) => (o.beforeDelivery ? at : at.slice(0, 10));
  const groups = new Map<string, typeof events>();
  for (const e of events) groups.set(keyOf(e.arrivedAt), [...(groups.get(keyOf(e.arrivedAt)) ?? []), e]);
  const keys = [...groups.keys()].sort();
  let accepted = 0;
  let rejected = 0;
  for (const [n, key] of keys.entries()) {
    const group = groups.get(key)!;
    for (let i = 0; i < group.length; i += 500) {
      const chunk = group.slice(i, i + 500);
      await o.beforeDelivery?.(chunk[0].arrivedAt);
      const r = await call('POST', '/api/ingest', u.ops, { events: chunk.map((x) => x.event) });
      if (!r.json?.summary) ok('ingest', r);
      accepted += r.json.summary.accepted;
      rejected += r.json.summary.rejected;
    }
    const endOfDay = n === keys.length - 1 || keys[n + 1].slice(0, 10) !== key.slice(0, 10);
    if (endOfDay) {
      await call('POST', '/api/ops/close-periods', u.ops, {});
      await call('POST', '/api/ops/nudges/dispatch', u.ops, {});
    }
  }
  log(`events: ${accepted} accepted, ${rejected} rejected`);
  return { customers: imp, events: { accepted, rejected } };
}

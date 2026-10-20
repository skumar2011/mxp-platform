/**
 * Minimal host app: everything MXP needs is @mxp/rules plus a rule pack file.
 * No database, no MXP server. A real host swaps MemoryStateStore for its own
 * StateStore (Redis, DynamoDB, Postgres...) and persists the effects it returns.
 *
 *   npm run export:pack                 # writes examples/mxp-retail.pack.json
 *   npx tsx examples/embed-node.ts
 */
import { readFileSync } from 'node:fs';
import { MemoryStateStore, RulesEngine, type CustomerSettingInput, type EvalContext } from '@mxp/rules';

const pack = JSON.parse(readFileSync(new URL('./mxp-retail.pack.json', import.meta.url), 'utf8'));
const engine = RulesEngine.fromPack(pack); // validates the file; throws RulePackError with readable issues
const store = new MemoryStateStore();

const customer = { id: 'CUST-42', segment: 'MASS', timezone: 'Asia/Kolkata', status: 'ACTIVE' };
const settings: CustomerSettingInput[] = [];
const ctx = (): EvalContext => ({ customer, account: { id: 'SA-1', type: 'SAVINGS' }, settings, enrollments: [] });

// 1. What can this customer see? (spend controls to set, missions to chase)
for (const o of engine.availableFor(ctx())) console.log(`${o.family.padEnd(13)} ${o.code.padEnd(20)} ${o.summary}`);

// 2. The customer picks their own daily limit (the bank set the bounds).
const values = { limit: 2000 };
const issues = engine.validateSetting('DSL_MASS', values);
if (issues.length) throw new Error(issues.map((i) => i.message).join('; '));
settings.push({ settingId: 'S1', customerId: customer.id, ruleCode: 'DSL_MASS', values, effectiveFrom: '2026-10-01' });
console.log('\nSetting:', engine.describe('DSL_MASS', values));

// 3. Card authorisation asks for a decision; the transaction then posts.
const txn = (id: string, amount: number, at: string) => ({ id, type: 'TRANSACTION', customerId: customer.id, accountId: 'SA-1', timestamp: at, amount, dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', category: 'FOOD_GROCERY' });
console.log('\nprocess 1,500 ->', engine.process(txn('t1', 1500, '2026-10-14T05:00:00Z'), ctx(), store).decision);
const pre = engine.check(txn('t2', 800, '2026-10-14T09:00:00Z'), ctx(), store);
console.log('pre-auth 800   ->', pre.decision, '|', pre.evaluations.find((e) => e.ruleCode === 'DSL_MASS')?.message);

// 4. A worker closes windows once a day; compliant days earn points.
const day2 = engine.process(txn('t3', 400, '2026-10-15T05:00:00Z'), ctx(), store);
const closed = engine.close('2026-10-17', store, () => ctx());
console.log('\nclose ->', closed.evaluations.filter((e) => e.ruleCode === 'DSL_MASS').map((e) => `${e.windowKey} ${e.outcome} ${e.points} pts`).join(', '));
console.log('effects to persist:', [...day2.effects, ...closed.effects].map((f) => `${f.type}${'points' in f ? ` ${f.points}` : ''}`).join(', '));

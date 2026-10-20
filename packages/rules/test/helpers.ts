import { MemoryStateStore, RulesEngine, zonedToIso, type CustomerSettingInput, type EvalContext, type MxpEvent, type ProcessResult } from '../src';
import { samplePack } from '../src/catalog';

export const engine = () => RulesEngine.fromPack(samplePack());

export const at = (date: string, time = '12:00', tz = 'Asia/Kolkata') => zonedToIso(date, time, tz);

let seq = 0;
export function txn(date: string, amount: number, over: Partial<MxpEvent> = {}, time = '12:00'): MxpEvent {
  return {
    id: `t${++seq}`, type: 'TRANSACTION', customerId: 'C1', accountId: 'A1', timestamp: at(date, time),
    dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', amount, category: 'OTHER', merchant_id: 'M_X', product_family: 'DEBIT_CARD', ...over,
  };
}

export function ev(type: string, date: string, attrs: Record<string, unknown> = {}, over: Partial<MxpEvent> = {}): MxpEvent {
  return { id: `e${++seq}`, type, customerId: 'C1', accountId: 'A1', timestamp: at(date, '20:00'), ...attrs, ...over };
}

/** A small harness: one customer, a store, a running points total. */
export class Journey {
  store = new MemoryStateStore();
  points = 0;
  settings: CustomerSettingInput[] = [];
  enrollments: string[] = [];
  constructor(readonly eng: RulesEngine, public customer: EvalContext['customer'] = { id: 'C1', segment: 'MASS', timezone: 'Asia/Kolkata' }) {}
  ctx(): EvalContext {
    return { customer: this.customer, settings: this.settings, enrollments: this.enrollments };
  }
  set(ruleCode: string, values: Record<string, unknown>, over: Partial<CustomerSettingInput> = {}) {
    this.settings.push({ settingId: over.settingId ?? `S_${ruleCode}`, customerId: this.customer.id, ruleCode, values, ...over });
    return this;
  }
  send(e: MxpEvent): ProcessResult {
    const r = this.eng.process(e, this.ctx(), this.store);
    this.points += r.points;
    return r;
  }
  check(e: MxpEvent): ProcessResult {
    return this.eng.check(e, this.ctx(), this.store);
  }
  close(asOf: string): ProcessResult {
    const r = this.eng.close(asOf, this.store, () => this.ctx());
    this.points += r.points;
    return r;
  }
}

export const outcome = (r: ProcessResult, code: string) => r.evaluations.filter((e) => e.ruleCode === code).map((e) => e.outcome)[0];
export const pointsFor = (r: ProcessResult, code: string) => r.effects.filter((e) => (e.type === 'AWARD' || e.type === 'CLAWBACK') && e.ruleCode === code).reduce((s, e) => s + (e as { points: number }).points, 0);

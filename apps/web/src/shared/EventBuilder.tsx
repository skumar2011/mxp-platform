import { useEffect, useState } from 'react';
import { localParts, zonedToIso, type FactDef } from '@mxp/rules';
import { pretty } from './format';
import { Field } from './ui';

/** Sensible starting values per event type (a debit UPI grocery payment, a savings balance...). */
export const EVENT_DEFAULTS: Record<string, Record<string, unknown>> = {
  TRANSACTION: { amount: 500, dr_cr: 'D', channel: 'UPI', txn_type: 'PURCHASE', category: 'FOOD_GROCERY', product_family: 'SAVINGS', merchant_id: 'M_BIGBASKET', merchant_name: 'BigBasket' },
  BALANCE_SNAPSHOT: { account_type: 'SAVINGS', balance: 25000 },
  REFERRAL: { referral_id: 'REF-1', status: 'APPROVED' },
  PRODUCT_APPLICATION: { application_id: 'APP-1', product_family: 'CREDIT_CARD', status: 'APPROVED' },
  RD_INSTALLMENT: { account_type: 'RECURRING_DEPOSIT', installment_no: 1, on_time: true, amount: 2000 },
  RD_MATURITY: { account_type: 'RECURRING_DEPOSIT', status: 'COMPLETED', installments_missed: 0, tenure_months: 12 },
  FD_MATURITY: { account_type: 'FIXED_DEPOSIT', action: 'RENEW', amount: 100000, maturity_id: 'MAT-1', tenure_months: 12 },
};
// Fields not in the fact model but needed by some rules.
const EXTRA: Record<string, FactDef[]> = {
  REFERRAL: [{ path: 'event.status', label: 'Status', type: 'enum', values: ['SUBMITTED', 'APPROVED', 'REJECTED'] }],
  PRODUCT_APPLICATION: [{ path: 'event.status', label: 'Status', type: 'enum', values: ['SUBMITTED', 'APPROVED', 'REJECTED'] }],
  RD_MATURITY: [{ path: 'event.status', label: 'Status', type: 'enum', values: ['COMPLETED', 'BROKEN'] }],
};

export const fieldsFor = (type: string, facts: FactDef[]): FactDef[] => [
  ...facts.filter((f) => f.path.startsWith('event.') && !f.path.startsWith('event.local.') && f.events?.includes(type) && f.path !== 'event.status'),
  ...(EXTRA[type] ?? []),
];

export interface BuiltEvent {
  type: string;
  timestamp: string;
  accountId?: string | null;
  reversalOf?: string | null;
  [k: string]: unknown;
}

export function nowLocal(tz: string) {
  const p = localParts(new Date().toISOString(), tz);
  return { date: p.date, time: p.time };
}

/** Builds an event: type, local date and time in the customer's timezone, and the type's fields. */
export function EventBuilder({ facts, refs, tz, value, onChange, accounts, merchants }: {
  facts: FactDef[]; refs: Record<string, string[]>; tz: string; value: BuiltEvent; onChange: (e: BuiltEvent) => void; accounts?: { id: string; label: string }[]; merchants?: { merchant_id: string; name: string; category_code: string }[];
}) {
  const p = localParts(value.timestamp, tz);
  const [date, setDate] = useState(p.date);
  const [time, setTime] = useState(p.time);
  useEffect(() => { const q = localParts(value.timestamp, tz); setDate(q.date); setTime(q.time); }, [value.timestamp, tz]);
  const setWhen = (d: string, t: string) => { setDate(d); setTime(t); if (d && /^\d\d:\d\d$/.test(t)) onChange({ ...value, timestamp: zonedToIso(d, t, tz) }); };
  const setType = (type: string) => onChange({ type, timestamp: value.timestamp, accountId: value.accountId, ...EVENT_DEFAULTS[type] });
  const fields = fieldsFor(value.type, facts);
  const setField = (k: string, v: unknown) => {
    const next = { ...value, [k]: v };
    if (v === undefined || v === '') delete next[k];
    if (k === 'merchant_id' && merchants) {
      const m = merchants.find((x) => x.merchant_id === v);
      if (m) { next.merchant_name = m.name; next.category = m.category_code; }
    }
    onChange(next);
  };
  return (
    <div className="form-grid">
      <Field label="Event type">
        <select className="input" value={value.type} onChange={(e) => setType(e.target.value)}>
          {Object.keys(EVENT_DEFAULTS).map((t) => <option key={t} value={t}>{pretty(t)}</option>)}
        </select>
      </Field>
      <Field label="Date" hint={tz}><input className="input" type="date" value={date} onChange={(e) => setWhen(e.target.value, time)} /></Field>
      <Field label="Local time"><input className="input" type="time" value={time} onChange={(e) => setWhen(date, e.target.value)} /></Field>
      {accounts && accounts.length > 0 && (
        <Field label="Account">
          <select className="input" value={value.accountId ?? ''} onChange={(e) => onChange({ ...value, accountId: e.target.value || null })}>
            <option value="">–</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </Field>
      )}
      {fields.map((f) => {
        const k = f.path.slice(6);
        const v = value[k];
        const values = f.values ?? (f.valuesFrom ? refs[f.valuesFrom] : undefined);
        if (k === 'merchant_id' && merchants?.length)
          return <Field key={k} label={f.label}><select className="input" value={String(v ?? '')} onChange={(e) => setField(k, e.target.value || undefined)}><option value="">–</option>{merchants.map((m) => <option key={m.merchant_id} value={m.merchant_id}>{m.name} ({pretty(m.category_code)})</option>)}</select></Field>;
        if (f.type === 'boolean') return <Field key={k} label={f.label}><select className="input" value={v === undefined ? '' : String(v)} onChange={(e) => setField(k, e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">–</option><option value="true">Yes</option><option value="false">No</option></select></Field>;
        if (values) return <Field key={k} label={f.label}><select className="input" value={String(v ?? '')} onChange={(e) => setField(k, e.target.value || undefined)}><option value="">–</option>{values.map((x) => <option key={x} value={x}>{pretty(x)}</option>)}</select></Field>;
        if (f.type === 'number' || f.type === 'money') return <Field key={k} label={f.label}><input className="input" type="number" value={v === undefined ? '' : String(v)} onChange={(e) => setField(k, e.target.value === '' ? undefined : Number(e.target.value))} /></Field>;
        if (f.type === 'date') return <Field key={k} label={f.label}><input className="input" type="date" value={String(v ?? '')} onChange={(e) => setField(k, e.target.value || undefined)} /></Field>;
        return <Field key={k} label={f.label}><input className="input" value={String(v ?? '')} onChange={(e) => setField(k, e.target.value || undefined)} /></Field>;
      })}
      <Field label="Reverses event id" hint="Refund / reversal of an earlier event"><input className="input" value={value.reversalOf ?? ''} onChange={(e) => onChange({ ...value, reversalOf: e.target.value || null })} /></Field>
    </div>
  );
}

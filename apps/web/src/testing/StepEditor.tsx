import { useState } from 'react';
import type { Meta } from '../shared/meta';
import { Alert, Button, Field, Modal } from '../shared/ui';

const KINDS = [
  { id: 'TXN', label: 'Transaction' }, { id: 'BALANCE', label: 'Balance snapshot' }, { id: 'REVERSAL', label: 'Reversal' }, { id: 'REFUND', label: 'Refund' },
  { id: 'STATUS', label: 'Status change' }, { id: 'CLOSE', label: 'Close periods' },
];

const today = () => new Date().toISOString().slice(0, 10);

export const describeStep = (s: any) => {
  switch (s.kind) {
    case 'TXN': return `${s.id}: ${s.type} ${s.channel} ₹${s.amount} on ${s.at}${s.status && s.status !== 'POSTED' ? ` (${s.status})` : ''}${s.repeat ? ` · redelivered ${s.repeat}x` : ''}${s.resendAs ? ` · resent ${s.resendAs}x under new ids` : ''}${s.receivedAt ? ` · arrives ${s.receivedAt}` : ''}`;
    case 'BALANCE': return `${s.account}: closing balance ₹${s.balance} ${s.toDate ? `from ${s.date} to ${s.toDate}` : `on ${s.date}`}`;
    case 'REVERSAL': case 'REFUND': return `${s.kind === 'REFUND' ? 'Refund' : 'Reversal'} ${s.id} of ${s.original}${s.amount ? ` ₹${s.amount}` : ' (full)'} on ${s.at}`;
    case 'STATUS': return `${s.id} becomes ${s.status} on ${s.at}`;
    case 'CLOSE': return `Close periods as of ${s.at}`;
  }
  return JSON.stringify(s);
};

const blankFor = (kind: string, n: number, accounts: any[]): any => {
  const d = today();
  switch (kind) {
    case 'TXN': return { kind, id: `T${n}`, at: `${d}T10:00`, type: 'PURCHASE', channel: 'CARD_POS', amount: 1000, drCr: 'D', status: 'POSTED', accountRef: accounts[0]?.ref };
    case 'BALANCE': return { kind, account: accounts[0]?.ref, date: d, balance: 50000 };
    case 'REVERSAL': return { kind, id: `R${n}`, original: '', at: `${d}T12:00` };
    case 'REFUND': return { kind, id: `RF${n}`, original: '', at: `${d}T12:00` };
    case 'STATUS': return { kind, id: '', at: `${d}T12:00`, status: 'POSTED' };
    default: return { kind: 'CLOSE', at: `${d}T23:59` };
  }
};

/** Add or edit one scenario step. Fields are limited to what the simulator understands; anything else belongs in the JSON tab. */
export function StepEditor({ meta, accounts, steps, initial, onSave, onClose }: { meta: Meta; accounts: any[]; steps: any[]; initial?: any; onSave: (steps: any[]) => void; onClose: () => void }) {
  const [step, setStep] = useState<any>(initial ?? blankFor('TXN', steps.length + 1, accounts));
  const [count, setCount] = useState(1);
  const [every, setEvery] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: any) => setStep((s: any) => ({ ...s, ...patch }));
  const txnIds = steps.filter((s) => s.kind === 'TXN').map((s) => s.id);
  const num = (v: string) => (v === '' ? '' : Number(v));

  const save = () => {
    const bad = (m: string) => { setErr(m); return true; };
    if (['TXN', 'STATUS', 'REVERSAL', 'REFUND'].includes(step.kind) && !step.id) return bad('Give the step an id.');
    if (step.kind === 'TXN' && (step.amount === '' || step.amount < 0)) return bad('Enter an amount of zero or more.');
    if (['REVERSAL', 'REFUND'].includes(step.kind) && !step.original) return bad('Choose the original transaction.');
    if (step.kind === 'BALANCE' && (step.balance === '' || !step.account || !step.date)) return bad('Account, date and balance are required.');
    if (!initial && txnIds.includes(step.id) && step.kind === 'TXN') return bad(`A transaction with id ${step.id} already exists.`);
    const clean = Object.fromEntries(Object.entries(step).filter(([, v]) => v !== '' && v !== undefined && v !== null));
    if (step.kind === 'TXN' && !initial && count > 1) {
      const out: any[] = [];
      const base = new Date(`${String(step.at).slice(0, 10)}T00:00:00Z`);
      const time = String(step.at).length > 10 ? String(step.at).slice(10) : '';
      for (let i = 0; i < count; i++) {
        const d = new Date(base.getTime() + i * every * 86_400_000).toISOString().slice(0, 10);
        out.push({ ...clean, id: `${step.id}-${i + 1}`, at: `${d}${time}`, ...(step.receivedAt ? { receivedAt: undefined } : {}) });
      }
      onSave(out);
    } else onSave([clean]);
    return false;
  };

  return (
    <Modal wide title={initial ? 'Edit step' : 'Add step'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { if (!save()) onClose(); }}>{initial ? 'Save step' : count > 1 ? `Add ${count} steps` : 'Add step'}</Button></>}>
      {err && <Alert tone="err">{err}</Alert>}
      {!initial && (
        <div className="row gap wrap" style={{ marginBottom: 14 }}>
          {KINDS.map((k) => <Button key={k.id} small variant={step.kind === k.id ? 'primary' : 'secondary'} onClick={() => setStep(blankFor(k.id, steps.length + 1, accounts))}>{k.label}</Button>)}
        </div>
      )}
      <div className="form-grid">
        {step.kind === 'TXN' && <>
          <Field label="Transaction id"><input className="input mono" value={step.id} onChange={(e) => set({ id: e.target.value })} /></Field>
          <Field label="Date and time" hint="In the scenario time zone"><input className="input" type="datetime-local" value={String(step.at).length === 10 ? `${step.at}T10:00` : step.at} onChange={(e) => set({ at: e.target.value })} /></Field>
          <Field label="Type"><select className="input" value={step.type} onChange={(e) => set({ type: e.target.value })}>{meta.reference.txnTypes.filter((t: any) => !t.isReversal).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}</select></Field>
          <Field label="Channel"><select className="input" value={step.channel} onChange={(e) => set({ channel: e.target.value })}>{meta.reference.channels.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></Field>
          <Field label="Amount (₹)"><input className="input" type="number" min={0} step="0.01" value={step.amount} onChange={(e) => set({ amount: num(e.target.value) })} /></Field>
          <Field label="Debit / credit"><select className="input" value={step.drCr} onChange={(e) => set({ drCr: e.target.value })}><option value="D">Debit (customer pays)</option><option value="C">Credit</option></select></Field>
          <Field label="Status"><select className="input" value={step.status} onChange={(e) => set({ status: e.target.value })}>{meta.txnStatuses.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Category"><select className="input" value={step.category ?? ''} onChange={(e) => set({ category: e.target.value || undefined })}><option value="">None</option>{meta.reference.categories.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></Field>
          <Field label="Account"><select className="input" value={step.accountRef ?? ''} onChange={(e) => set({ accountRef: e.target.value || undefined })}>{accounts.map((a) => <option key={a.ref} value={a.ref}>{a.ref} ({a.productCode})</option>)}</select></Field>
          <Field label="Merchant name"><input className="input" value={step.merchantName ?? ''} onChange={(e) => set({ merchantName: e.target.value })} /></Field>
          <Field label="MCC"><input className="input" value={step.mcc ?? ''} onChange={(e) => set({ mcc: e.target.value })} /></Field>
          <Field label="Redeliver the identical event (times)" hint="Tests de-duplication"><input className="input" type="number" min={0} max={20} value={step.repeat ?? 0} onChange={(e) => set({ repeat: Number(e.target.value) || undefined })} /></Field>
          <Field label="Re-send under new event ids (times)" hint="Same transaction, different event id"><input className="input" type="number" min={0} max={20} value={step.resendAs ?? 0} onChange={(e) => set({ resendAs: Number(e.target.value) || undefined })} /></Field>
          <Field label="Arrives late at" hint="When MXP receives it, if after the transaction"><input className="input" type="datetime-local" value={step.receivedAt ?? ''} onChange={(e) => set({ receivedAt: e.target.value || undefined })} /></Field>
          {!initial && <>
            <Field label="Create this many transactions" hint="Ids get a -1, -2 suffix"><input className="input" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value)))} /></Field>
            <Field label="…one every (days)"><input className="input" type="number" min={0} value={every} onChange={(e) => setEvery(Math.max(0, Number(e.target.value)))} /></Field>
          </>}
        </>}
        {step.kind === 'BALANCE' && <>
          <Field label="Account"><select className="input" value={step.account} onChange={(e) => set({ account: e.target.value })}>{accounts.map((a) => <option key={a.ref} value={a.ref}>{a.ref} ({a.productCode})</option>)}</select></Field>
          <Field label="Date"><input className="input" type="date" value={step.date} onChange={(e) => set({ date: e.target.value })} /></Field>
          <Field label="Through (optional)" hint="Same balance every day up to this date"><input className="input" type="date" value={step.toDate ?? ''} onChange={(e) => set({ toDate: e.target.value || undefined })} /></Field>
          <Field label="Closing balance (₹)"><input className="input" type="number" step="0.01" value={step.balance} onChange={(e) => set({ balance: num(e.target.value) })} /></Field>
        </>}
        {(step.kind === 'REVERSAL' || step.kind === 'REFUND') && <>
          <Field label="Reversal id"><input className="input mono" value={step.id} onChange={(e) => set({ id: e.target.value })} /></Field>
          <Field label="Original transaction"><select className="input" value={step.original} onChange={(e) => set({ original: e.target.value })}><option value="">Choose...</option>{txnIds.map((i) => <option key={i}>{i}</option>)}</select></Field>
          <Field label="Date and time"><input className="input" type="datetime-local" value={step.at} onChange={(e) => set({ at: e.target.value })} /></Field>
          <Field label="Amount (₹)" hint="Blank = the full amount"><input className="input" type="number" min={0} step="0.01" value={step.amount ?? ''} onChange={(e) => set({ amount: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
        </>}
        {step.kind === 'STATUS' && <>
          <Field label="Transaction"><select className="input" value={step.id} onChange={(e) => set({ id: e.target.value })}><option value="">Choose...</option>{txnIds.map((i) => <option key={i}>{i}</option>)}</select></Field>
          <Field label="New status"><select className="input" value={step.status} onChange={(e) => set({ status: e.target.value })}>{meta.txnStatuses.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Date and time"><input className="input" type="datetime-local" value={step.at} onChange={(e) => set({ at: e.target.value })} /></Field>
        </>}
        {step.kind === 'CLOSE' && <Field label="Close periods as of" hint="Runs the end-of-period job at this moment"><input className="input" type="datetime-local" value={step.at} onChange={(e) => set({ at: e.target.value })} /></Field>}
        <Field label="Note for yourself" wide><input className="input" value={step.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined })} placeholder="Optional description shown in the results" /></Field>
      </div>
    </Modal>
  );
}

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { STATUS_TONE, pretty } from './format';

export type Tone = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'violet';

export const Badge = ({ tone = 'gray', children, title }: { tone?: Tone | string; children: ReactNode; title?: string }) => (
  <span className={`badge badge-${tone}`} title={title}>{children}</span>
);

export const StatusBadge = ({ status, label }: { status: string | null | undefined; label?: string }) =>
  status ? <Badge tone={STATUS_TONE[status] ?? 'gray'}>{label ?? pretty(status)}</Badge> : <span className="muted">-</span>;

export function Card({ title, actions, children, pad = true, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-h">
          <h3>{title}</h3>
          <div className="row gap">{actions}</div>
        </header>
      )}
      <div className={pad ? 'card-b' : ''}>{children}</div>
    </section>
  );
}

export function Button({ variant = 'secondary', busy, small, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean; small?: boolean }) {
  return (
    <button {...p} type={p.type ?? 'button'} disabled={p.disabled || busy} className={`btn btn-${variant} ${small ? 'btn-sm' : ''} ${p.className ?? ''}`}>
      {busy && <span className="spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, wide }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; wide?: boolean }) {
  const id = useId();
  return (
    <div className={`field ${wide ? 'field-wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div id={id} role="group">{children}</div>
      {hint && !error && <small className="muted">{hint}</small>}
      {error && <small className="err">{error}</small>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <header className="card-h"><h3>{title}</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="card-b modal-body">{children}</div>
        {footer && <footer className="modal-f">{footer}</footer>}
      </div>
    </div>
  );
}

/** Confirmation with an optional mandatory reason (used for reject, pause, retire, rollback...). */
export function ReasonDialog({ title, intro, label = 'Reason', minLen = 5, confirm, danger, required = true, onSubmit, onClose }: {
  title: string; intro?: ReactNode; label?: string; minLen?: number; confirm: string; danger?: boolean; required?: boolean;
  onSubmit: (reason: string) => Promise<unknown>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const short = required && reason.trim().length < minLen;
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onSubmit(reason.trim()); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} busy={busy} disabled={short} onClick={go}>{confirm}</Button></>}>
      {intro && <p>{intro}</p>}
      <Field label={label} hint={required ? `At least ${minLen} characters. This is recorded in the audit trail.` : undefined} error={err}>
        <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

// ---------- toasts ----------
interface Toast { id: number; tone: 'ok' | 'err'; text: string }
const ToastCtx = createContext<{ ok: (t: string) => void; err: (e: unknown) => void }>({ ok: () => {}, err: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === 'err' ? 8000 : 3500);
  }, []);
  const value = useMemo(() => ({ ok: (t: string) => push('ok', t), err: (e: unknown) => push('err', e instanceof Error ? e.message : String(e)) }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- states ----------
export const Loading = ({ text = 'Loading...' }: { text?: string }) => <div className="state"><span className="spin dark" aria-hidden /> {text}</div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="state muted">{children}</div>;
export function ErrorBox({ error, retry }: { error: ApiError | Error | null; retry?: () => void }) {
  if (!error) return null;
  const details = (error as ApiError).details;
  return (
    <div className="alert alert-err" role="alert">
      <strong>{error.message}</strong>
      {details && details.length > 1 && <ul>{details.slice(0, 8).map((d, i) => <li key={i}><code>{d.path || 'request'}</code> {d.message}</li>)}</ul>}
      {retry && <Button small onClick={retry}>Try again</Button>}
    </div>
  );
}
export const Alert = ({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok' | 'err'; children: ReactNode }) => <div className={`alert alert-${tone}`}>{children}</div>;

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-l">{label}</div>
      <div className="stat-v">{value}</div>
      {sub && <div className="stat-s">{sub}</div>}
    </div>
  );
}

// ---------- tables ----------
export interface Col<T> { key: string; header: ReactNode; render: (r: T) => ReactNode; align?: 'right' | 'center'; className?: string }

export function DataTable<T>({ cols, rows, empty = 'Nothing to show.', onRow, rowKey }: { cols: Col<T>[]; rows: T[]; empty?: ReactNode; onRow?: (r: T) => void; rowKey?: (r: T, i: number) => string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{cols.map((c) => <th key={c.key} className={c.align ? `t-${c.align}` : ''}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : i} className={onRow ? 'clickable' : ''} onClick={onRow ? () => onRow(r) : undefined}
              tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => e.key === 'Enter' && onRow(r) : undefined}>
              {cols.map((c) => <td key={c.key} className={`${c.align ? `t-${c.align}` : ''} ${c.className ?? ''}`}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return <div className="pager muted">{total} result{total === 1 ? '' : 's'}</div>;
  return (
    <div className="pager">
      <span className="muted">{offset + 1}-{Math.min(offset + limit, total)} of {total.toLocaleString('en-IN')}</span>
      <Button small disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
      <Button small disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</Button>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? 'tab on' : 'tab'} onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
  );
}

export const Json = ({ value, max = 400 }: { value: unknown; max?: number }) => <pre className="json" style={{ maxHeight: max }}>{JSON.stringify(value, null, 2)}</pre>;

/** Stacked bars for a daily series; accessible via the title tooltips. */
export function Bars({ data, height = 120 }: { data: { label: string; a: number; b?: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.a + (d.b ?? 0)));
  if (!data.length) return <Empty>No data yet.</Empty>;
  return (
    <div className="bars" style={{ height }} role="img" aria-label="Daily points awarded and reversed">
      {data.map((d) => (
        <div key={d.label} className="bar-col" title={`${d.label}: +${d.a}${d.b ? `, -${d.b}` : ''}`}>
          <div className="bar b-rev" style={{ height: `${((d.b ?? 0) / max) * 100}%` }} />
          <div className="bar b-awd" style={{ height: `${(d.a / max) * 100}%` }} />
        </div>
      ))}
    </div>
  );
}

export function Filters({ children, onApply }: { children: ReactNode; onApply?: () => void }) {
  return <form className="filters" onSubmit={(e) => { e.preventDefault(); onApply?.(); }}>{children}</form>;
}

export function KeyVal({ items }: { items: [string, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api } from './api';
import { useAuth, type NavItem } from './auth';
import { Button, Field, Modal, useToast } from './ui';

export function Layout({ title, mark, nav, other, children }: { title: string; mark: string; nav: NavItem[]; other: { label: string; href: string; perm?: string }; children: ReactNode }) {
  const { user, env, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  useLocation();
  let lastSection = '';
  return (
    <div className="shell">
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`side ${open ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand"><i>{mark}</i> {title}</div>
        <nav className="nav" onClick={() => setOpen(false)}>
          {nav.filter((n) => !n.perm || can(n.perm)).map((n) => {
            const sec = n.section && n.section !== lastSection ? (lastSection = n.section) : null;
            return (
              <div key={n.to}>
                {sec && <div className="sec">{sec}</div>}
                <NavLink to={n.to} end={n.end ?? n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}><span aria-hidden>{n.icon}</span>{n.label}</NavLink>
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="main">
        <header className="top">
          <button className="btn btn-ghost menu-btn" onClick={() => setOpen(true)} aria-label="Open menu">☰</button>
          <span className={`env env-${env}`}>{env.toUpperCase()}</span>
          {env !== 'prod' && <span className="muted env-note">Non-production environment</span>}
          <span className="grow" />
          {(!other.perm || can(other.perm)) && <a href={other.href} className="btn btn-sm hide-sm">{other.label} ↗</a>}
          <span className="hide-sm" style={{ textAlign: 'right', lineHeight: 1.2 }}>
            <strong>{user?.name}</strong><br /><small className="muted">{user?.roles.map((r) => r.replace(/_/g, ' ').toLowerCase()).join(', ')}</small>
          </span>
          <Button small onClick={() => setPw(true)}>Password</Button>
          <Button small onClick={logout}>Sign out</Button>
        </header>
        <main className="content">{children}</main>
      </div>
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await api('/auth/password', { body: { current, password } }); toast.ok('Password changed.'); onClose(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Change password" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={go} disabled={!current || !password}>Change password</Button></>}>
      <div className="stack">
        {err && <div className="alert alert-err">{err}</div>}
        <Field label="Current password"><input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="10+ characters with upper case, lower case and a digit."><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
      </div>
    </Modal>
  );
}

export const PageHead = ({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) => (
  <div className="page-h"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="row gap wrap">{actions}</div></div>
);

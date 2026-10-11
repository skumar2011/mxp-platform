import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';
import { Alert, Button, Field, ToastProvider } from './ui';
import './styles.css';

export interface User { username: string; name: string; roles: string[]; permissions: string[] }
interface AuthState { user: User | null; env: string; can: (p: string) => boolean; logout: () => void }
const Ctx = createContext<AuthState>({ user: null, env: 'dev', can: () => false, logout: () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthGate({ app, theme, children }: { app: string; theme?: 'testing'; children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [env, setEnv] = useState('dev');
  const [ready, setReady] = useState(false);

  useEffect(() => { document.body.classList.toggle('theme-testing', theme === 'testing'); }, [theme]);

  const load = useCallback(async () => {
    if (!getToken()) { setReady(true); return; }
    try { const r = await api<{ user: User; env: string }>('/auth/me'); setUser(r.user); setEnv(r.env); } catch { setToken(null); }
    setReady(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const h = () => setUser(null);
    window.addEventListener('mxp:logout', h);
    window.addEventListener('storage', (e) => e.key === 'mxp.token' && void load());
    return () => window.removeEventListener('mxp:logout', h);
  }, [load]);

  const logout = useCallback(() => { void api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}); setToken(null); setUser(null); }, []);

  if (!ready) return null;
  if (!user) return <ToastProvider><Login app={app} onDone={(u, e) => { setUser(u); setEnv(e); }} /></ToastProvider>;
  return <Ctx.Provider value={{ user, env, can: (p) => user.permissions.includes(p), logout }}><ToastProvider>{children}</ToastProvider></Ctx.Provider>;
}

function Login({ app, onDone }: { app: string; onDone: (u: User, env: string) => void }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [isDev, setIsDev] = useState(false);
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then((h) => setIsDev(h.env === 'dev')).catch(() => {}); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api<{ token: string; user: User; env: string }>('/auth/login', { body: { username: username.trim(), password } });
      setToken(r.token); onDone(r.user, r.env);
    } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="card-b stack">
          <div className="brand" style={{ color: 'var(--ink)', padding: 0 }}><i style={{ color: '#fff' }}>XP</i> Money XP</div>
          <div><h2>{app}</h2><span className="muted">Sign in with your work account.</span></div>
          {err && <Alert tone="err">{err}</Alert>}
          <Field label="Username"><input className="input" value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus required /></Field>
          <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required /></Field>
          <Button variant="primary" type="submit" busy={busy}>Sign in</Button>
          {isDev && <small className="muted">Demo users: maker, checker, qa, ops, auditor, admin. Password <code>Mxp@Demo1</code>.</small>}
        </div>
      </form>
    </div>
  );
}

export interface NavItem { to: string; label: string; icon: string; perm?: string; section?: string }

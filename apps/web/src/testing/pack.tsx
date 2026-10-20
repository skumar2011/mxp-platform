import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fingerprint, RulePackError, RulesEngine, type RulePackInput } from '@mxp/rules';
import { api } from '../shared/api';
import { Alert, Badge, Button } from '../shared/ui';

export type PackSource = 'CURRENT' | 'OPEN' | 'FILE';
interface PackState {
  source: PackSource;
  setSource: (s: PackSource) => void;
  pack: RulePackInput | null;
  engine: RulesEngine | null;
  hash: string | null;
  error: string | null;
  loading: boolean;
  /** Use an arbitrary pack file (uploaded, or built in the rule lab). */
  useFile: (pack: RulePackInput, label?: string) => void;
  fileLabel: string | null;
  reload: () => void;
}
const Ctx = createContext<PackState | null>(null);
export const usePack = () => useContext(Ctx)!;

export function PackProvider({ children }: { children: ReactNode }) {
  const [source, setSourceState] = useState<PackSource>(() => (sessionStorage.getItem('mxp.packSource') as PackSource) || 'CURRENT');
  const [pack, setPack] = useState<RulePackInput | null>(null);
  const [file, setFile] = useState<{ pack: RulePackInput; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    const load = source === 'FILE' ? Promise.resolve(file?.pack ?? null) : api<RulePackInput>('/packs/preview', { query: { source } });
    load.then((p) => { if (live) { setPack(p); if (!p) setError('No pack file loaded. Upload one in the Rule file lab.'); } })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [source, file, tick]);

  const { engine, hash, engineError } = useMemo(() => {
    if (!pack) return { engine: null, hash: null, engineError: null };
    try {
      return { engine: RulesEngine.fromPack(pack, { skipInvalidRules: true }), hash: fingerprint({ ...pack, generatedAt: undefined }), engineError: null };
    } catch (e) {
      return { engine: null, hash: null, engineError: e instanceof RulePackError ? e.message : (e as Error).message };
    }
  }, [pack]);

  const setSource = useCallback((s: PackSource) => { sessionStorage.setItem('mxp.packSource', s); setSourceState(s); }, []);
  const useFile = useCallback((p: RulePackInput, label = 'uploaded file') => { setFile({ pack: p, label }); setSource('FILE'); }, [setSource]);
  const value: PackState = { source, setSource, pack, engine, hash, error: error ?? engineError, loading, useFile, fileLabel: file?.label ?? null, reload: () => setTick((t) => t + 1) };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function PackPicker() {
  const p = usePack();
  const skipped = p.engine?.issues.filter((i) => i.severity === 'error').length ?? 0;
  return (
    <div className="banner row gap wrap">
      <strong>Rule pack</strong>
      <div className="pill">
        <button className={p.source === 'CURRENT' ? 'on' : ''} onClick={() => p.setSource('CURRENT')}>Live release</button>
        <button className={p.source === 'OPEN' ? 'on' : ''} onClick={() => p.setSource('OPEN')}>Live + drafts</button>
        <button className={p.source === 'FILE' ? 'on' : ''} disabled={!p.fileLabel} onClick={() => p.setSource('FILE')}>{p.fileLabel ? `File: ${p.fileLabel}` : 'File'}</button>
      </div>
      {p.pack && <span className="muted">{p.pack.pack} {p.pack.version} · {p.engine?.listRules().length ?? 0} rules · <code>{p.hash?.slice(0, 10)}</code></span>}
      {skipped > 0 && <Badge tone="amber">{skipped} invalid rule(s) skipped</Badge>}
      <span className="grow" />
      <Button small onClick={p.reload}>Reload</Button>
      <span className="muted" style={{ fontSize: 12 }}>The engine runs in your browser: same code, same file as the server.</span>
      {p.error && <div style={{ width: '100%' }}><Alert tone="err">{p.error}</Alert></div>}
    </div>
  );
}

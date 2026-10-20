/** Deterministic JSON (sorted keys) so fingerprints are stable across runtimes. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** 64-bit FNV-1a fingerprint (hex). For change detection, not security; hosts seal with SHA-256. */
export function fingerprint(v: unknown): string {
  const s = typeof v === 'string' ? v : canonicalJson(v);
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * p) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

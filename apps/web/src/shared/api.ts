const KEY = 'mxp.token';

export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export interface Opts {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
}

const qs = (q?: Opts['query']) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

function expire() {
  setToken(null);
  window.dispatchEvent(new Event('mxp:logout'));
}

async function send(path: string, o: Opts) {
  const headers: Record<string, string> = {};
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}${qs(o.query)}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0, 'NETWORK');
  }
  if (res.status === 401 && !path.startsWith('/auth/login')) expire();
  return res;
}

export async function api<T = any>(path: string, o: Opts = {}): Promise<T> {
  const res = await send(path, o);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(e.message ?? `Request failed (${res.status})`, res.status, e.code ?? 'ERROR', e.details);
  }
  return json as T;
}

/** Downloads an authenticated file (CSV/JSON). Links cannot carry the bearer token, so we fetch and save a blob. */
export async function download(path: string, query: Opts['query'], fallbackName: string) {
  const res = await send(path, { query });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      msg = (await res.json()).error?.message ?? msg;
    } catch {}
    throw new ApiError(msg, res.status, 'DOWNLOAD');
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  saveBlob(await res.blob(), name);
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const saveJson = (data: unknown, name: string) => saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name);

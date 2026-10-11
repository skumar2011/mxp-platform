import { resolve } from 'node:path';
import { DEMO_PASSWORD } from '@mxp/engine';
import { loadSamples, type Call } from './loadSamples';

/**
 * npm run load:samples -- [baseUrl] [--dir samples]
 * Logs in as the demo users (or the users in MXP_LOAD_USERS=maker:checker:admin:ops with the password in MXP_LOAD_PASSWORD).
 * Sample events are dated 2026-09/10; they earn rewards only when the server clock is inside that window.
 */
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const base = (args[0] ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const dirIdx = process.argv.indexOf('--dir');
const dir = resolve(dirIdx > 0 ? process.argv[dirIdx + 1] : new URL('../../../samples', import.meta.url).pathname);
const [maker, checker, admin, ops] = (process.env.MXP_LOAD_USERS ?? 'maker:checker:admin:ops').split(':');
const password = process.env.MXP_LOAD_PASSWORD ?? DEMO_PASSWORD;

const tokens = new Map<string, string>();
const call: Call = async (method, url, as, body) => {
  if (!tokens.has(as)) {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: as, password }) });
    if (!r.ok) throw new Error(`login as ${as} failed (${r.status})`);
    tokens.set(as, ((await r.json()) as { token: string }).token);
  }
  const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${tokens.get(as)}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};

loadSamples(call, { dir, users: { maker, checker, admin, ops }, log: (m) => console.log(m) }).then(
  () => console.log('Done.'),
  (e) => { console.error(String(e.message ?? e)); process.exit(1); },
);

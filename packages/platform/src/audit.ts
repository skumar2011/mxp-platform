import type { Db } from './db';
import { json, sha256, type Actor, type Clock } from './util';

const GENESIS = '0'.repeat(64);

export function audit(db: Db, clock: Clock, actor: Actor | string, action: string, entityType: string, entityId: string, detail?: unknown): void {
  const prev = db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY audit_id DESC LIMIT 1')?.hash ?? GENESIS;
  const at = clock.now().toISOString();
  const who = typeof actor === 'string' ? actor : actor.username;
  const d = json(detail);
  const hash = sha256([prev, at, who, action, entityType, entityId, d ?? ''].join('|'));
  db.run('INSERT INTO audit_log(occurred_at, actor, action, entity_type, entity_id, detail_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)', at, who, action, entityType, entityId, d, prev, hash);
}

/** Re-computes the chain; returns the first broken row, if any. */
export function verifyAudit(db: Db): { ok: boolean; checked: number; brokenAt?: number } {
  let prev = GENESIS;
  let n = 0;
  for (const r of db.all<any>('SELECT * FROM audit_log ORDER BY audit_id')) {
    const h = sha256([prev, r.occurred_at, r.actor, r.action, r.entity_type, r.entity_id, r.detail_json ?? ''].join('|'));
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, checked: n, brokenAt: r.audit_id };
    prev = r.hash;
    n++;
  }
  return { ok: true, checked: n };
}

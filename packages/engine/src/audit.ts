import type { Db } from './db';
import { canonicalJson, sha256, type Clock } from './util';

export interface Actor {
  username: string;
  roles: string[];
}

export const SYSTEM_ACTOR: Actor = { username: 'system', roles: ['SYSTEM'] };

const GENESIS = 'GENESIS';

/** Appends a tamper-evident audit record. Each row commits to the previous row's hash. */
export function audit(
  db: Db,
  clock: Clock,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason?: string | null,
  correlationId?: string | null,
): void {
  const prev = db.value<string>('SELECT hash FROM audit_log ORDER BY audit_id DESC LIMIT 1') ?? GENESIS;
  const occurredAt = clock.now().toISOString();
  const beforeJson = before === undefined || before === null ? null : canonicalJson(before);
  const afterJson = after === undefined || after === null ? null : canonicalJson(after);
  const roles = actor.roles.join(',');
  const hash = sha256(
    canonicalJson({ prev, occurredAt, actor: actor.username, roles, action, entityType, entityId, beforeJson, afterJson, reason: reason ?? null }),
  );
  db.run(
    `INSERT INTO audit_log(occurred_at, actor, actor_roles, action, entity_type, entity_id, before_json, after_json, reason, correlation_id, prev_hash, hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    occurredAt,
    actor.username,
    roles,
    action,
    entityType,
    entityId,
    beforeJson,
    afterJson,
    reason ?? null,
    correlationId ?? null,
    prev,
    hash,
  );
}

export function verifyAuditChain(db: Db): { ok: boolean; checked: number; brokenAt?: number } {
  const rows = db.all<any>('SELECT * FROM audit_log ORDER BY audit_id');
  let prev = GENESIS;
  for (const r of rows) {
    const expected = sha256(
      canonicalJson({
        prev,
        occurredAt: r.occurred_at,
        actor: r.actor,
        roles: r.actor_roles ?? '',
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        beforeJson: r.before_json,
        afterJson: r.after_json,
        reason: r.reason,
      }),
    );
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, checked: rows.length, brokenAt: r.audit_id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length };
}

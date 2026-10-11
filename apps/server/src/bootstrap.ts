import { audit, hashPassword, seedAll, seedReference, uid, type Db, type Clock } from '@mxp/engine';

/** True when the database has never been initialised with users. */
export const isEmpty = (db: Db) => (db.value<number>('SELECT COUNT(*) FROM app_user') ?? 0) === 0;

/** Demo data: reference data, demo users (all roles), sample rules, campaigns, customers and a month of transactions. */
export function bootstrapDemo(db: Db) {
  return seedAll(db);
}

/**
 * Production bootstrap: reference data and a single SYSTEM_ADMIN whose password comes from the environment.
 * Rules, campaigns and further users are then created through the console, under maker-checker.
 */
export function bootstrapProduction(db: Db, clock: Clock, password: string) {
  if (password.length < 12) throw new Error('MXP_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
  seedReference(db);
  const id = uid();
  db.tx(() => {
    db.run('INSERT INTO app_user(user_id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)', id, 'admin', 'Administrator', hashPassword(password), clock.now().toISOString());
    db.run('INSERT INTO user_role(user_id, role_code) VALUES (?,?)', id, 'SYSTEM_ADMIN');
    audit(db, clock, { username: 'system', roles: ['SYSTEM'] }, 'BOOTSTRAP', 'app_user', 'admin', null, { roles: ['SYSTEM_ADMIN'] });
  });
}

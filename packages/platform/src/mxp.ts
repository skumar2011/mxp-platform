import { audit, verifyAudit } from './audit';
import { Catalog } from './catalog';
import { openDb, type Db } from './db';
import { Participation } from './participation';
import { Queries, TestStore } from './queries';
import { Runtime } from './runtime';
import { hashPassword, MxpError, permissionsFor, systemClock, uid, verifyPassword, type Actor, type Clock } from './util';

let DUMMY_HASH: string | undefined;

/** The MXP platform: one object wiring the database, the rules catalogue and the runtime. */
export class Mxp {
  readonly catalog: Catalog;
  readonly participation: Participation;
  readonly runtime: Runtime;
  readonly queries: Queries;
  readonly tests: TestStore;

  constructor(readonly db: Db, readonly clock: Clock = systemClock) {
    this.catalog = new Catalog(db, clock);
    this.participation = new Participation(db, clock, this.catalog);
    this.runtime = new Runtime(db, clock, this.catalog, this.participation);
    this.queries = new Queries(db, clock, this.catalog, this.participation);
    this.tests = new TestStore(db, clock);
  }

  static open(path = ':memory:', clock: Clock = systemClock) {
    return new Mxp(openDb(path), clock);
  }

  // ---------- users ----------
  createUser(username: string, displayName: string, password: string, roles: string[], actor?: Actor) {
    const id = uid();
    this.db.tx(() => {
      this.db.run('INSERT INTO app_user(user_id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)', id, username, displayName, hashPassword(password), this.clock.now().toISOString());
      for (const r of roles) this.db.run('INSERT INTO user_role(user_id, role_code) VALUES (?,?)', id, r);
      audit(this.db, this.clock, actor ?? 'system', 'USER_CREATE', 'app_user', username, { roles });
    });
    return id;
  }

  login(username: string, password: string): Actor & { displayName: string; permissions: string[] } {
    const u = this.db.get<any>('SELECT * FROM app_user WHERE username = ?', username);
    const now = this.clock.now();
    if (!u || !u.active) {
      verifyPassword(password, (DUMMY_HASH ??= hashPassword('not-a-real-password'))); // same cost as a real user: no enumeration by timing
      audit(this.db, this.clock, username.slice(0, 64), 'LOGIN_FAILED', 'app_user', username.slice(0, 64), { reason: u ? 'inactive' : 'unknown user' });
      throw new MxpError('BAD_CREDENTIALS', 'Invalid username or password.', 401);
    }
    if (u.locked_until && new Date(u.locked_until) > now) throw new MxpError('LOCKED', 'Account temporarily locked after failed attempts. Try again later.', 423);
    if (!verifyPassword(password, u.password_hash)) {
      const fails = u.failed_logins + 1;
      this.db.run('UPDATE app_user SET failed_logins = ?, locked_until = ? WHERE user_id = ?', fails >= 5 ? 0 : fails, fails >= 5 ? new Date(now.getTime() + 15 * 60000).toISOString() : null, u.user_id);
      audit(this.db, this.clock, username, 'LOGIN_FAILED', 'app_user', username);
      throw new MxpError('BAD_CREDENTIALS', 'Invalid username or password.', 401);
    }
    this.db.run('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE user_id = ?', u.user_id);
    audit(this.db, this.clock, username, 'LOGIN', 'app_user', username);
    return this.user(username);
  }

  user(username: string): Actor & { displayName: string; permissions: string[] } {
    const u = this.db.get<any>('SELECT * FROM app_user WHERE username = ? AND active = 1', username);
    if (!u) throw new MxpError('UNAUTHENTICATED', 'Unknown user.', 401);
    const roles = this.db.all<{ role_code: string }>('SELECT role_code FROM user_role WHERE user_id = ?', u.user_id).map((r) => r.role_code);
    return { username: u.username, displayName: u.display_name, roles, permissions: permissionsFor(roles) };
  }

  changePassword(username: string, current: string, next: string) {
    const u = this.db.get<any>('SELECT * FROM app_user WHERE username = ?', username);
    if (!u || !verifyPassword(current, u.password_hash)) throw new MxpError('BAD_CREDENTIALS', 'Current password is incorrect.', 401);
    if (next.length < 10 || !/[A-Z]/.test(next) || !/[a-z]/.test(next) || !/\d/.test(next)) throw new MxpError('WEAK_PASSWORD', 'Use 10+ characters with upper case, lower case and a digit.', 422);
    this.db.run('UPDATE app_user SET password_hash = ? WHERE user_id = ?', hashPassword(next), u.user_id);
    audit(this.db, this.clock, username, 'PASSWORD_CHANGE', 'app_user', username);
  }

  users() {
    return this.db.all<any>("SELECT u.username, u.display_name, u.active, group_concat(r.role_code, ',') AS roles FROM app_user u LEFT JOIN user_role r ON r.user_id = u.user_id GROUP BY u.user_id ORDER BY u.username")
      .map((u) => ({ ...u, roles: u.roles ? u.roles.split(',') : [] }));
  }

  verifyAudit() {
    return verifyAudit(this.db);
  }

  close() {
    this.db.close();
  }
}

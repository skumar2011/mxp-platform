import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite is loaded through createRequire so bundlers/test runners do not
// try to resolve the `node:` scheme themselves.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => any };

export type Row = Record<string, any>;
type Param = string | number | bigint | null | undefined | boolean;

function norm(p: Param): string | number | bigint | null {
  if (p === undefined || p === null) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
}

/**
 * Minimal synchronous database facade. The engine depends only on this
 * interface, so a PostgreSQL implementation can replace it without touching
 * business logic (see docs/03-data-model.md).
 */
export class Db {
  readonly raw: any;
  private depth = 0;
  private cache = new Map<string, any>();

  constructor(readonly path: string = ':memory:') {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params.map(norm));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    const r = this.stmt(sql).get(...params.map(norm));
    return r ? ({ ...r } as T) : undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql)
      .all(...params.map(norm))
      .map((r: Row) => ({ ...r }) as T);
  }

  value<T = any>(sql: string, ...params: Param[]): T | undefined {
    const r = this.stmt(sql).get(...params.map(norm));
    if (!r) return undefined;
    return Object.values(r)[0] as T;
  }

  /** Runs fn in a transaction; nested calls become savepoints. */
  tx<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth = 1;
      try {
        const r = fn();
        this.raw.exec('COMMIT');
        this.depth = 0;
        return r;
      } catch (e) {
        this.depth = 0;
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw e;
      }
    }
    const name = `sp${this.depth}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      this.raw.exec(`RELEASE ${name}`);
      return r;
    } catch (e) {
      this.depth--;
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw e;
    }
  }

  close() {
    this.cache.clear();
    this.raw.close();
  }
}

const here = dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = 1;

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = db.value<number>('SELECT MAX(version) FROM schema_migration');
  if (applied && applied >= SCHEMA_VERSION) return;
  const ddl = readFileSync(join(here, 'schema.sql'), 'utf8');
  db.exec(ddl);
  db.run('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)', SCHEMA_VERSION, new Date().toISOString());
}

export function openDb(path = ':memory:'): Db {
  const db = new Db(path);
  migrate(db);
  return db;
}

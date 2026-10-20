import type { IndexEntry, StateStore, WindowState } from '@mxp/rules';
import type { Db } from './db';

/** SQLite StateStore: every engine key lives in one `rule_state` table. */
export class SqliteStateStore implements StateStore {
  constructor(private db: Db, private now: () => string) {}

  get<T>(key: string): T | undefined {
    return parse<T>(this.db.value<string>('SELECT state_json FROM rule_state WHERE state_key = ?', key));
  }

  set(key: string, value: unknown): void {
    const prefix = key.slice(0, 2);
    const now = this.now();
    let ruleCode: string | null = null;
    let customerId: string | null = null;
    let windowKey: string | null = null;
    let closeAfter: string | null = null;
    let status: string | null = null;
    let windowEnd: string | null = null;

    if (prefix === 'w|') {
      const w = value as WindowState;
      ruleCode = w.ruleCode;
      customerId = w.customerId;
      windowKey = w.windowKey;
      closeAfter = w.closeAfter;
      status = w.status;
      windowEnd = w.windowEnd;
    } else if (prefix === 'l|') {
      const [, rule, subject] = key.split('|');
      ruleCode = rule;
      customerId = subject.split(/[/#]/)[0];
    } else if (prefix === 'x|') {
      windowKey = (value as IndexEntry).windowKey;
    } else if (prefix !== 'r|') {
      throw new Error(`Unknown state key ${key}`);
    }

    this.db.run(
      `INSERT INTO rule_state(state_key, prefix, rule_code, customer_id, window_key, close_after, status, window_end, state_json, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(state_key) DO UPDATE SET prefix=excluded.prefix, rule_code=excluded.rule_code, customer_id=excluded.customer_id,
         window_key=excluded.window_key, close_after=excluded.close_after, status=excluded.status, window_end=excluded.window_end,
         state_json=excluded.state_json, updated_at=excluded.updated_at`,
      key, prefix, ruleCode, customerId, windowKey, closeAfter, status, windowEnd, JSON.stringify(value), now,
    );
  }

  dueWindows(date: string): WindowState[] {
    return this.db
      .all<{ state_json: string }>("SELECT state_json FROM rule_state WHERE prefix = 'w|' AND status = 'OPEN' AND close_after < ? ORDER BY close_after", date)
      .map((r) => JSON.parse(r.state_json));
  }
}

const parse = <T>(s: string | undefined): T | undefined => (s ? (JSON.parse(s) as T) : undefined);

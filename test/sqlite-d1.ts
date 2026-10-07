// A D1Database stand-in backed by Node's built-in SQLite, the engine D1 runs
// on. It applies the real migrations, so tests exercise the app's actual SQL
// rather than an in-memory imitation of it. Covers the D1 API the app uses:
// prepare().bind().first()/all()/run() and batch().

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

// D1 accepts numbered parameters (?1, ?2, each usable more than once), but
// node:sqlite in Node 22 won't bind values to them ("column index out of
// range"). Each becomes a plain ? with its value repeated in order.
function positional(sql: string, params: SQLInputValue[]): [string, SQLInputValue[]] {
  if (!/\?\d/.test(sql)) return [sql, params];
  const ordered: SQLInputValue[] = [];
  const rewritten = sql.replace(/\?(\d+)/g, (_, n: string) => {
    ordered.push(params[Number(n) - 1]);
    return '?';
  });
  return [rewritten, ordered];
}

class Statement {
  private readonly sql: string;
  private readonly params: SQLInputValue[];

  constructor(
    private readonly db: DatabaseSync,
    private readonly rawSql: string,
    rawParams: SQLInputValue[] = []
  ) {
    [this.sql, this.params] = positional(rawSql, rawParams);
  }

  bind(...params: unknown[]) {
    return new Statement(this.db, this.rawSql, params as SQLInputValue[]);
  }

  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

export function sqliteD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  }
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    // D1 runs a batch as one transaction.
    async batch(statements: Statement[]) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return d1 as unknown as D1Database;
}

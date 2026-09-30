import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

/**
 * The only storage seam (ADR-0008). Everything above this uses these five calls, so
 * swapping node:sqlite for better-sqlite3 means reimplementing this interface only.
 */
export interface SqlDatabase {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(file: string): SqlDatabase {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: <T extends Row>(sql: string, ...params: SqlValue[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T extends Row>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      // Nested calls join the outer transaction.
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}

import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | Uint8Array | null;

export class SqliteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    const cause = options?.cause;
    const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    super(detail ? `${message} (${detail})` : message, options);
    this.name = 'SqliteError';
  }
}

/**
 * Thin, synchronous wrapper over Node's built-in `node:sqlite`. Using the bundled driver
 * keeps the runtime dependency-free: no native module download, no rebuild on the owner's
 * Windows PC, and the safe online-backup API is available directly.
 */
export class SqliteDatabase {
  private constructor(readonly handle: DatabaseSync) {}

  static open(file: string): SqliteDatabase {
    let handle: DatabaseSync;
    try {
      handle = new DatabaseSync(file);
    } catch (error) {
      throw new SqliteError(`Could not open the SQLite database "${file}".`, { cause: error });
    }
    const database = new SqliteDatabase(handle);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    return database;
  }

  /**
   * Setting a pragma must go through `exec`; SQLite will not let an assignment pragma be
   * prepared as a statement. Reading a pragma uses the query path instead.
   */
  pragma(statement: string): void {
    this.exec(`PRAGMA ${statement}`);
  }

  pragmaValue<T = unknown>(name: string): T | undefined {
    const row = this.get<Record<string, T>>(`PRAGMA ${name}`);
    return row ? row[name] : undefined;
  }

  exec(sql: string): void {
    try {
      this.handle.exec(sql);
    } catch (error) {
      throw new SqliteError('SQLite statement failed.', { cause: error });
    }
  }

  prepare(sql: string): PreparedStatement {
    try {
      return new PreparedStatement(this.handle.prepare(sql));
    } catch (error) {
      throw new SqliteError(`Could not prepare the statement: ${sql.slice(0, 160)}`, { cause: error });
    }
  }

  all<T = Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.prepare(sql).all<T>(params);
  }

  get<T = Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []): T | undefined {
    return this.prepare(sql).get<T>(params);
  }

  run(sql: string, params: readonly SqlValue[] = []): RunResult {
    return this.prepare(sql).run(params);
  }

  /**
   * Runs `work` inside one write transaction. `BEGIN IMMEDIATE` takes the write lock up
   * front so concurrent writers fail fast instead of deadlocking on an upgrade.
   */
  transaction<T>(work: () => T): T {
    this.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // The transaction can already be finished when the original error was thrown.
      }
      throw error;
    }
  }

  get userVersion(): number {
    return this.pragmaValue<number>('user_version') ?? 0;
  }

  set userVersion(version: number) {
    this.exec(`PRAGMA user_version = ${Number(version)}`);
  }

  close(): void {
    try {
      this.handle.close();
    } catch {
      // Closing an already-closed handle is not an error worth surfacing.
    }
  }
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  /**
   * The driver's methods are native and must be invoked on the statement itself; the
   * parameter list is spread so the correct overload is selected.
   */
  private callAll(params: readonly SqlValue[]): unknown[] {
    return this.statement.all(...(params as never[]));
  }

  private callGet(params: readonly SqlValue[]): unknown {
    return this.statement.get(...(params as never[]));
  }

  private callRun(params: readonly SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.statement.run(...(params as never[])) as { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  /** Rows come back null-prototyped; they are copied into plain objects for callers. */
  all<T = Record<string, unknown>>(params: readonly SqlValue[] = []): T[] {
    try {
      const rows = this.callAll(params);
      return rows.map((row) => ({ ...(row as object) }) as T);
    } catch (error) {
      throw new SqliteError('SQLite query failed.', { cause: error });
    }
  }

  get<T = Record<string, unknown>>(params: readonly SqlValue[] = []): T | undefined {
    try {
      const row = this.callGet(params);
      return row === undefined || row === null ? undefined : ({ ...(row as object) } as T);
    } catch (error) {
      throw new SqliteError('SQLite query failed.', { cause: error });
    }
  }

  run(params: readonly SqlValue[] = []): RunResult {
    try {
      const result = this.callRun(params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    } catch (error) {
      throw new SqliteError('SQLite write failed.', { cause: error });
    }
  }
}

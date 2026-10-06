import type { SqliteDatabase } from './connection';

/**
 * Schema evolution is version-driven. `PRAGMA user_version` is the applied level; every
 * migration runs once, in order, inside a single transaction. Adding a later phase means
 * appending a migration here — never editing an already-released one.
 */
export const SCHEMA_VERSION = 1;

export interface Migration {
  version: number;
  description: string;
  up(database: SqliteDatabase): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'records, audit history, import history, reports and backups',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS records (
          id_key TEXT PRIMARY KEY,
          raw_id TEXT NOT NULL,
          id_is_integer INTEGER NOT NULL,
          record_source TEXT NOT NULL,
          mgmt_no TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT '',
          fingerprint TEXT NOT NULL DEFAULT '',
          registered_date TEXT,
          due_date TEXT,
          completed_date TEXT,
          payload TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_records_fingerprint ON records (fingerprint);
        CREATE INDEX IF NOT EXISTS idx_records_mgmt_no ON records (mgmt_no);
        CREATE INDEX IF NOT EXISTS idx_records_status ON records (status);

        CREATE TABLE IF NOT EXISTS import_history (
          id TEXT PRIMARY KEY,
          imported_at TEXT NOT NULL,
          files_json TEXT NOT NULL,
          added INTEGER NOT NULL,
          updated INTEGER NOT NULL,
          unchanged INTEGER NOT NULL,
          total INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_import_history_imported_at ON import_history (imported_at DESC);

        CREATE TABLE IF NOT EXISTS audit_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at TEXT NOT NULL,
          operation TEXT NOT NULL,
          record_id_key TEXT,
          mgmt_no TEXT,
          import_batch_id TEXT,
          client_ip TEXT,
          client_label TEXT,
          changes_json TEXT,
          details_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_events (record_id_key, seq DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events (occurred_at DESC, seq DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_operation ON audit_events (operation);

        -- Append-only: history is evidence and must not be editable through SQL.
        CREATE TRIGGER audit_events_no_update
        BEFORE UPDATE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'audit_events is append-only');
        END;

        CREATE TRIGGER audit_events_no_delete
        BEFORE DELETE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'audit_events is append-only');
        END;

        CREATE TABLE IF NOT EXISTS reports (
          record_id_key TEXT PRIMARY KEY,
          stored_name TEXT NOT NULL,
          original_name TEXT NOT NULL,
          content_type TEXT,
          size_bytes INTEGER NOT NULL,
          attached_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Kept separately so unlinking a record can drop the association while leaving
        -- the stored bytes untouched, as required.
        CREATE TABLE IF NOT EXISTS report_files (
          stored_name TEXT PRIMARY KEY,
          original_name TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          linked INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS backups (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          note TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups (created_at DESC);

        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

export interface MigrationResult {
  from: number;
  to: number;
  applied: { version: number; description: string }[];
  created: boolean;
}

/** Applies every migration above the current level. Idempotent on an up-to-date database. */
export function applyMigrations(
  database: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  const from = database.userVersion;
  const created = from === 0;
  const pending = migrations.filter((migration) => migration.version > from);
  const applied: { version: number; description: string }[] = [];

  if (pending.length === 0) return { from, to: from, applied, created };

  const ordered = [...pending].sort((left, right) => left.version - right.version);
  database.transaction(() => {
    for (const migration of ordered) {
      migration.up(database);
      database.userVersion = migration.version;
      applied.push({ version: migration.version, description: migration.description });
    }
  });

  return { from, to: ordered[ordered.length - 1].version, applied, created };
}

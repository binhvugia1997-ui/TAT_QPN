import type { ImportFileSummary, ImportHistoryEntry } from '../../src/models/import-history';
import type { SqlValue } from './connection';
import type { SqliteDatabase } from './connection';

interface ImportHistoryRow {
  id: string;
  imported_at: string;
  files_json: string;
  added: number;
  updated: number;
  unchanged: number;
  total: number;
}

export class ImportHistoryStore {
  constructor(private readonly database: SqliteDatabase) {}

  append(entry: ImportHistoryEntry): void {
    this.database.run(
      `INSERT INTO import_history (id, imported_at, files_json, added, updated, unchanged, total)
       VALUES (?,?,?,?,?,?,?)`,
      [
        entry.id,
        entry.importedAt,
        JSON.stringify(entry.files),
        entry.added,
        entry.updated,
        entry.unchanged,
        entry.total,
      ] satisfies SqlValue[],
    );
  }

  list(limit = 200): ImportHistoryEntry[] {
    const rows = this.database.all<ImportHistoryRow>(
      'SELECT * FROM import_history ORDER BY imported_at DESC LIMIT ?',
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      importedAt: row.imported_at,
      files: parseFiles(row.files_json),
      added: row.added,
      updated: row.updated,
      unchanged: row.unchanged,
      total: row.total,
    }));
  }
}

function parseFiles(value: string): ImportFileSummary[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ImportFileSummary[]) : [];
  } catch {
    return [];
  }
}

import type { SqlValue } from './connection';
import type { SqliteDatabase } from './connection';

export interface ReportLinkRow {
  record_id_key: string;
  stored_name: string;
  original_name: string;
  content_type: string | null;
  size_bytes: number;
  attached_at: string;
  updated_at: string;
}

export interface ReportLink {
  recordIdKey: string;
  storedName: string;
  originalName: string;
  contentType: string | null;
  sizeBytes: number;
  attachedAt: string;
  updatedAt: string;
}

export class ReportCatalog {
  constructor(private readonly database: SqliteDatabase) {}

  upsert(link: Omit<ReportLink, 'updatedAt'> & { updatedAt?: string }): ReportLink {
    const updatedAt = link.updatedAt ?? new Date().toISOString();
    this.database.run(
      `INSERT INTO reports (record_id_key, stored_name, original_name, content_type, size_bytes, attached_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(record_id_key) DO UPDATE SET
         stored_name = excluded.stored_name,
         original_name = excluded.original_name,
         content_type = excluded.content_type,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at`,
      [
        link.recordIdKey,
        link.storedName,
        link.originalName,
        link.contentType,
        link.sizeBytes,
        link.attachedAt,
        updatedAt,
      ] satisfies SqlValue[],
    );

    this.database.run(
      `INSERT INTO report_files (stored_name, original_name, size_bytes, created_at, linked)
       VALUES (?,?,?,?,1)
       ON CONFLICT(stored_name) DO UPDATE SET linked = 1`,
      [link.storedName, link.originalName, link.sizeBytes, link.attachedAt] satisfies SqlValue[],
    );

    return { ...link, updatedAt };
  }

  get(recordIdKey: string): ReportLink | undefined {
    const row = this.database.get<ReportLinkRow>('SELECT * FROM reports WHERE record_id_key = ?', [recordIdKey]);
    return row ? hydrate(row) : undefined;
  }

  /**
   * Every attached report link, ordered by canonical record id key. This backs the
   * bulk report index so a list screen can show a link per row with a single query.
   */
  listAll(): ReportLink[] {
    return this.database
      .all<ReportLinkRow>('SELECT * FROM reports ORDER BY record_id_key')
      .map((row) => hydrate(row));
  }

  /** Removes the association only. Stored bytes are intentionally left in place. */
  unlink(recordIdKey: string): ReportLink | undefined {
    const existing = this.get(recordIdKey);
    if (!existing) return undefined;

    this.database.transaction(() => {
      this.database.run('DELETE FROM reports WHERE record_id_key = ?', [recordIdKey]);
      const stillLinked = this.database.get<{ total: number }>(
        'SELECT COUNT(*) AS total FROM reports WHERE stored_name = ?',
        [existing.storedName],
      )?.total ?? 0;
      if (stillLinked === 0) {
        this.database.run('UPDATE report_files SET linked = 0 WHERE stored_name = ?', [existing.storedName]);
      }
    });

    return existing;
  }

  orphanedFiles(): { storedName: string; originalName: string; sizeBytes: number; createdAt: string }[] {
    return this.database
      .all<{ stored_name: string; original_name: string; size_bytes: number; created_at: string }>(
        'SELECT * FROM report_files WHERE linked = 0 ORDER BY created_at DESC',
      )
      .map((row) => ({
        storedName: row.stored_name,
        originalName: row.original_name,
        sizeBytes: row.size_bytes,
        createdAt: row.created_at,
      }));
  }
}

function hydrate(row: ReportLinkRow): ReportLink {
  return {
    recordIdKey: row.record_id_key,
    storedName: row.stored_name,
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    attachedAt: row.attached_at,
    updatedAt: row.updated_at,
  };
}

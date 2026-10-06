import fs from 'node:fs';
import crypto from 'node:crypto';
import { backup as sqliteBackup } from 'node:sqlite';
import type { SqliteDatabase } from '../db/connection';
import type { MetadataStore } from '../db/metadata';
import { resolveContainedPath } from './safePath';

export type BackupKind = 'daily' | 'pre-import' | 'manual';

export interface BackupEntry {
  id: string;
  createdAt: string;
  kind: BackupKind;
  fileName: string;
  sizeBytes: number;
  note: string | null;
}

export const DEFAULT_RETENTION = 30;
const LAST_DAILY_KEY = 'backup.lastDailyDate';

interface BackupRow {
  id: string;
  created_at: string;
  kind: string;
  file_name: string;
  size_bytes: number;
  note: string | null;
}

/**
 * Snapshots use SQLite's own online backup API, which produces a consistent copy of a live
 * WAL database. A plain file copy of an open database is not safe and is never used.
 */
export class BackupService {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly databaseFile: string,
    private readonly backupsDir: string,
    private readonly metadata: MetadataStore,
    private readonly retention = DEFAULT_RETENTION,
  ) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  get directory(): string {
    return this.backupsDir;
  }

  async create(kind: BackupKind, note?: string, now = new Date()): Promise<BackupEntry> {
    const stamp = toStamp(now);
    // The random suffix keeps names unique; several snapshots can share one second and
    // retention deletes by file name.
    const suffix = crypto.randomBytes(3).toString('hex');
    const id = `backup-${stamp}-${suffix}`;
    const fileName = `tnp-${stamp}-${kind}-${suffix}.db`;
    const target = resolveContainedPath(this.backupsDir, fileName);

    await sqliteBackup(this.database.handle, target);

    const sizeBytes = fs.statSync(target).size;
    this.database.run(
      'INSERT INTO backups (id, created_at, kind, file_name, size_bytes, note) VALUES (?,?,?,?,?,?)',
      [id, now.toISOString(), kind, fileName, sizeBytes, note ?? null],
    );

    this.prune();
    return { id, createdAt: now.toISOString(), kind, fileName, sizeBytes, note: note ?? null };
  }

  /**
   * Runs at most once per calendar day, on the first write of that day. A restarted server
   * does not duplicate the daily snapshot.
   */
  async createDailyIfDue(now = new Date()): Promise<BackupEntry | null> {
    const today = toCalendarDay(now);
    if (this.metadata.get(LAST_DAILY_KEY) === today) return null;
    const entry = await this.create('daily', 'Automatic daily snapshot', now);
    this.metadata.set(LAST_DAILY_KEY, today, now.toISOString());
    return entry;
  }

  list(): BackupEntry[] {
    const rows = this.database.all<BackupRow>('SELECT * FROM backups ORDER BY created_at DESC, id DESC');
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      kind: row.kind as BackupKind,
      fileName: row.file_name,
      sizeBytes: row.size_bytes,
      note: row.note,
    }));
  }

  /** Backups are listed and sized only; no destructive restore is exposed. */
  resolve(fileName: string): string {
    return resolveContainedPath(this.backupsDir, fileName);
  }

  /** Drops the oldest snapshots so the folder cannot grow without bound. */
  prune(): { removed: number } {
    const entries = this.list();
    if (entries.length <= this.retention) return { removed: 0 };

    const stale = entries.slice(this.retention);
    this.database.transaction(() => {
      for (const entry of stale) {
        this.database.run('DELETE FROM backups WHERE id = ?', [entry.id]);
        try {
          fs.rmSync(this.resolve(entry.fileName), { force: true });
        } catch {
          // A file already removed by the operator is not a failure.
        }
      }
    });

    return { removed: stale.length };
  }

  /** Files present on disk that the catalog no longer references. */
  orphanedFiles(): string[] {
    const known = new Set(this.list().map((entry) => entry.fileName));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.backupsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.db') && !known.has(entry.name))
      .map((entry) => entry.name);
  }

  get databasePath(): string {
    return this.databaseFile;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function toCalendarDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

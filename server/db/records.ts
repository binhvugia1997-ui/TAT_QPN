import { getRecordFingerprint } from '../../src/business/duplicate/identity';
import { normalizeDefectRecord } from '../../src/models/defect-record';
import type { DefectRecord, RecordId, RecordSource } from '../../src/models/defect-record';
import { getRecordIdKey } from '../../src/business/records/recordKey';
import type { SqlValue } from './connection';
import type { SqliteDatabase } from './connection';
import { RecordConflictError, RecordNotFoundError } from '../errors';

export interface StoredRecord {
  idKey: string;
  record: DefectRecord;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SeedOutcome {
  seeded: number;
  skippedExistingIds: number;
  alreadyInitialized: boolean;
}

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** Field injected for the API layer only; it is never part of the stored payload. */
export const VERSION_FIELD = 'version';

interface RecordRow {
  id_key: string;
  raw_id: string;
  id_is_integer: number;
  record_source: string;
  mgmt_no: string;
  status: string;
  fingerprint: string;
  registered_date: string | null;
  due_date: string | null;
  completed_date: string | null;
  payload: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function toDateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toTextValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function recordIdFromRow(row: RecordRow): RecordId {
  return row.id_is_integer === 1 ? Number(row.raw_id) : row.raw_id;
}

/** Strips the API-only revision field before a record is written back to SQLite. */
function stripVersion(record: DefectRecord): DefectRecord {
  if (!Object.prototype.hasOwnProperty.call(record, VERSION_FIELD)) return record;
  const copy = { ...record };
  delete copy[VERSION_FIELD];
  return copy;
}

export function toApiRecord(stored: StoredRecord): DefectRecord {
  return { ...stripVersion(stored.record), [VERSION_FIELD]: stored.version } as DefectRecord;
}

/** Field-by-field diff used for the audit trail; one save becomes one grouped operation. */
export function diffRecords(before: DefectRecord, after: DefectRecord): FieldChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete(VERSION_FIELD);
  const changes: FieldChange[] = [];

  for (const field of [...keys].sort()) {
    const oldValue = before[field];
    const newValue = after[field];
    if (JSON.stringify(oldValue ?? null) === JSON.stringify(newValue ?? null)) continue;
    changes.push({ field, oldValue: oldValue ?? null, newValue: newValue ?? null });
  }

  return changes;
}

export class RecordStore {
  constructor(private readonly database: SqliteDatabase) {}

  private hydrate(row: RecordRow): StoredRecord {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.payload) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Stored payload for record "${row.id_key}" is not valid JSON.`, { cause: error });
    }
    const record = {
      ...parsed,
      id: recordIdFromRow(row),
      recordSource: row.record_source as RecordSource,
    } as DefectRecord;

    return {
      idKey: row.id_key,
      record,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private insertRow(record: DefectRecord, now: string, version = 1): StoredRecord {
    const idKey = getRecordIdKey(record.id);
    const payload = stripVersion(record);
    this.database.run(
      `INSERT INTO records (
         id_key, raw_id, id_is_integer, record_source, mgmt_no, status, fingerprint,
         registered_date, due_date, completed_date, payload, version, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        idKey,
        String(record.id),
        typeof record.id === 'number' ? 1 : 0,
        record.recordSource,
        toTextValue(record.mgmtNo),
        toTextValue(record.status),
        getRecordFingerprint(record),
        toDateValue(record.registeredDate),
        toDateValue(record.dueDate),
        toDateValue(record.completedDate),
        JSON.stringify(payload),
        version,
        now,
        now,
      ] satisfies SqlValue[],
    );

    return { idKey, record: payload, version, createdAt: now, updatedAt: now };
  }

  count(): number {
    return this.database.get<{ total: number }>('SELECT COUNT(*) AS total FROM records')?.total ?? 0;
  }

  /**
   * Ordering deliberately mirrors the IndexedDB store the approved UI read from: numeric
   * ids first in numeric order, then string ids in lexicographic order. The shared
   * identity index is last-entry-wins, so record order is part of the matching behavior.
   */
  list(): StoredRecord[] {
    const rows = this.database.all<RecordRow>(
      `SELECT * FROM records
       ORDER BY id_is_integer DESC,
                CASE WHEN id_is_integer = 1 THEN CAST(raw_id AS INTEGER) ELSE 0 END ASC,
                raw_id ASC`,
    );
    return rows.map((row) => this.hydrate(row));
  }

  /** Records in canonical form, in the same order the browser repository returned them. */
  listRecords(): DefectRecord[] {
    return this.list().map((stored) => toApiRecord(stored));
  }

  getStored(idKey: string): StoredRecord | undefined {
    const row = this.database.get<RecordRow>('SELECT * FROM records WHERE id_key = ?', [idKey]);
    return row ? this.hydrate(row) : undefined;
  }

  get(id: RecordId): StoredRecord | undefined {
    return this.getStored(getRecordIdKey(id));
  }

  /**
   * Inserts a new record. `source` is authoritative so an import can never masquerade as
   * a legacy seed row.
   */
  insert(input: Record<string, unknown>, source: RecordSource, now = new Date().toISOString()): StoredRecord {
    const record = normalizeDefectRecord(input, source);
    return this.insertRow(record, now);
  }

  /** Inserts an already-normalized record, used by the import pipeline. */
  insertNormalized(record: DefectRecord, now = new Date().toISOString()): StoredRecord {
    return this.insertRow(normalizeDefectRecord(record, record.recordSource), now);
  }

  /**
   * Writes a full record only when the caller still holds the revision it read.
   * A stale write is rejected instead of silently clobbering another client's save.
   */
  update(
    idKey: string,
    nextRecord: DefectRecord,
    expectedVersion: number,
    now = new Date().toISOString(),
  ): StoredRecord {
    const current = this.getStored(idKey);
    if (!current) throw new RecordNotFoundError(idKey);
    if (current.version !== expectedVersion) {
      throw new RecordConflictError(idKey, expectedVersion, current.version);
    }

    const normalized = normalizeDefectRecord(
      { ...stripVersion(nextRecord), id: current.record.id, recordSource: current.record.recordSource },
      current.record.recordSource,
    );
    const payload = stripVersion(normalized);

    const result = this.database.run(
      `UPDATE records SET
         mgmt_no = ?, status = ?, fingerprint = ?, registered_date = ?, due_date = ?,
         completed_date = ?, payload = ?, version = version + 1, updated_at = ?
       WHERE id_key = ? AND version = ?`,
      [
        toTextValue(payload.mgmtNo),
        toTextValue(payload.status),
        getRecordFingerprint(payload),
        toDateValue(payload.registeredDate),
        toDateValue(payload.dueDate),
        toDateValue(payload.completedDate),
        JSON.stringify(payload),
        now,
        idKey,
        expectedVersion,
      ] satisfies SqlValue[],
    );

    if (result.changes === 0) {
      const raced = this.getStored(idKey);
      if (!raced) throw new RecordNotFoundError(idKey);
      throw new RecordConflictError(idKey, expectedVersion, raced.version);
    }

    return { idKey, record: payload, version: current.version + 1, createdAt: current.createdAt, updatedAt: now };
  }

  remove(idKey: string): void {
    const result = this.database.run('DELETE FROM records WHERE id_key = ?', [idKey]);
    if (result.changes === 0) throw new RecordNotFoundError(idKey);
  }

  /**
   * Seeds the canonical records only when this database has never been seeded. An
   * existing database keeps its records untouched, so operator edits and imports survive
   * every restart.
   */
  seedIfEmpty(seedRecords: readonly DefectRecord[], markerKey: string): SeedOutcome {
    const marker = this.database.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key = ?',
      [markerKey],
    );
    if (marker) return { seeded: 0, skippedExistingIds: 0, alreadyInitialized: true };

    const existing = new Set(this.database.all<{ id_key: string }>('SELECT id_key FROM records').map((row) => row.id_key));
    let seeded = 0;
    let skippedExistingIds = 0;
    const now = new Date().toISOString();

    this.database.transaction(() => {
      for (const record of seedRecords) {
        const idKey = getRecordIdKey(record.id);
        if (existing.has(idKey)) {
          skippedExistingIds += 1;
          continue;
        }
        existing.add(idKey);
        this.insertRow(normalizeDefectRecord(record, 'legacy-seed'), now);
        seeded += 1;
      }
      this.database.run(
        'INSERT INTO metadata (key, value, updated_at) VALUES (?,?,?) '
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [markerKey, String(seedRecords.length), now],
      );
    });

    return { seeded, skippedExistingIds, alreadyInitialized: false };
  }
}

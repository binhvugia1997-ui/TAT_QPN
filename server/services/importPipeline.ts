import { buildRecordIndex, getRecordFingerprint } from '../../src/business/duplicate/identity';
import {
  buildTnpSyncPatch,
  getImportIdentityCandidate,
} from '../../src/business/import/tnpSyncRules';
import { getRecordIdKey } from '../../src/business/records/recordKey';
import { normalizeDefectRecord, normalizeDefectRecordPatch } from '../../src/models/defect-record';
import type { DefectRecord } from '../../src/models/defect-record';
import type { ImportFileSummary, ImportHistoryEntry } from '../../src/models/import-history';
import { createRecordId } from '../../src/utils/id';
import type { AuditStore, AuditActor } from '../db/audit';
import type { SqliteDatabase } from '../db/connection';
import type { ImportHistoryStore } from '../db/importHistory';
import { diffRecords, toApiRecord, type StoredRecord } from '../db/records';
import type { RecordStore } from '../db/records';
import type { BackupService } from './backup';

export interface ImportCommitOptions {
  fileName: string;
  importedAt?: string;
  actor?: AuditActor;
}

export interface ImportPreviewResult extends Omit<ImportFileSummary, 'fileName' | 'error'> {}

export interface ImportCommitResult extends ImportFileSummary {
  history: ImportHistoryEntry;
  backupFileName: string | null;
}

interface PlannedUpdate {
  stored: StoredRecord;
  next: DefectRecord;
}

interface ImportPlan {
  inserts: DefectRecord[];
  updates: PlannedUpdate[];
  summary: ImportFileSummary;
  history: ImportHistoryEntry;
}

/**
 * The authoritative import. It reuses the same identity index and the same strict
 * `status` + `dueDate` whitelist the browser-side preview uses, so a matched record can
 * never be merged differently depending on where the import runs.
 *
 * Flow: pre-import backup → transaction (match, whitelist sync, audit, history) → commit.
 * Any failure rolls the transaction back, so a partially applied import is impossible.
 */
export class ImportPipeline {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly records: RecordStore,
    private readonly audit: AuditStore,
    private readonly history: ImportHistoryStore,
    private readonly backups: BackupService,
  ) {}

  /** Read-only preview using the identical matching and sync rules. */
  preview(rows: readonly Record<string, unknown>[], fileName: string): ImportPreviewResult {
    const plan = this.plan(rows, fileName);
    const { added, updated, unchanged, total } = plan.summary;
    return { added, updated, unchanged, total };
  }

  async commit(
    rows: readonly Record<string, unknown>[],
    options: ImportCommitOptions,
  ): Promise<ImportCommitResult> {
    // The snapshot is taken before the transaction starts so a failed import still leaves
    // a restore point behind.
    const backup = await this.backups.create('pre-import', `Before import of ${options.fileName}`);

    const result = this.database.transaction(() => {
      const plan = this.plan(rows, options.fileName, options.importedAt);
      const actor = options.actor ?? {};

      for (const inserted of plan.inserts) {
        const stored = this.records.insertNormalized(inserted);
        this.audit.append({
          operation: 'record.create',
          recordIdKey: stored.idKey,
          mgmtNo: String(inserted.mgmtNo ?? ''),
          importBatchId: plan.history.id,
          changes: [{ field: '(new record)', oldValue: null, newValue: inserted.mgmtNo ?? null }],
          details: { origin: 'import', fileName: options.fileName },
          ...actor,
        });
      }

      for (const { stored, next } of plan.updates) {
        const changes = diffRecords(stored.record, next);
        const updatedStored = this.records.update(stored.idKey, next, stored.version);
        this.audit.append({
          operation: 'record.update',
          recordIdKey: stored.idKey,
          mgmtNo: String(next.mgmtNo ?? ''),
          importBatchId: plan.history.id,
          changes,
          details: { origin: 'import', fileName: options.fileName },
          ...actor,
        });
        void updatedStored;
      }

      this.audit.append({
        operation: 'import.commit',
        importBatchId: plan.history.id,
        changes: [],
        details: {
          fileName: options.fileName,
          added: plan.summary.added,
          updated: plan.summary.updated,
          unchanged: plan.summary.unchanged,
          total: plan.summary.total,
          backupFileName: backup.fileName,
        },
        ...actor,
      });

      this.history.append(plan.history);
      return { ...plan.summary, history: plan.history, backupFileName: backup.fileName };
    });

    return result;
  }

  /**
   * Matching and whitelist sync, isolated so preview and commit share one implementation.
   * Semantics are intentionally identical to the approved browser-side import: the
   * identity index is last-entry-wins and only whitelisted fields can mark a record UPDATED.
   */
  private plan(
    rows: readonly Record<string, unknown>[],
    fileName: string,
    importedAtOption?: string,
  ): ImportPlan {
    const storedRecords = this.records.list();
    const storedByIdKey = new Map(storedRecords.map((stored) => [stored.idKey, stored]));
    const identityIndex = buildRecordIndex(storedRecords.map((stored) => toApiRecord(stored)));
    // Mirrors the approved browser-side batch map: one pending write per canonical id, and a
    // row that matches an earlier insert in the same batch stays an insert.
    const changesByIdKey = new Map<string, { kind: 'insert' | 'update'; record: DefectRecord; stored?: StoredRecord }>();
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const row of rows) {
      const identityCandidate = getImportIdentityCandidate(row);
      const fingerprint = getRecordFingerprint(identityCandidate);
      const match = identityIndex.get(fingerprint);

      if (match) {
        const patch = buildTnpSyncPatch(match, row);
        const didChange = Object.keys(patch).length > 0;
        let merged = match;

        if (didChange) {
          merged = normalizeDefectRecord(
            { ...match, ...patch, id: match.id, recordSource: match.recordSource },
            match.recordSource,
          );
          const key = getRecordIdKey(match.id);
          const pending = changesByIdKey.get(key);
          changesByIdKey.set(key, {
            kind: pending?.kind === 'insert' ? 'insert' : 'update',
            record: merged,
            stored: pending?.stored ?? storedByIdKey.get(key),
          });
        }

        identityIndex.set(fingerprint, merged);
        if (didChange) updated += 1;
        else unchanged += 1;
        continue;
      }

      // A new record keeps all recognized canonical source fields plus any unrecognized
      // sourceExtras. The strict two-field whitelist applies only to matched records.
      const importPatch = normalizeDefectRecordPatch(row);
      const id = createRecordId('i');
      const inserted = normalizeDefectRecord({ ...importPatch, id, recordSource: 'import' }, 'import');
      identityIndex.set(fingerprint, inserted);
      changesByIdKey.set(getRecordIdKey(id), { kind: 'insert', record: inserted });
      added += 1;
    }

    const inserts: DefectRecord[] = [];
    const updates: PlannedUpdate[] = [];
    for (const change of changesByIdKey.values()) {
      if (change.kind === 'insert') {
        inserts.push(change.record);
        continue;
      }
      if (!change.stored) {
        throw new Error(`Matched record "${getRecordIdKey(change.record.id)}" disappeared during import planning.`);
      }
      updates.push({ stored: change.stored, next: change.record });
    }

    const importedAt = importedAtOption ?? new Date().toISOString();
    const summary: ImportFileSummary = {
      fileName,
      added,
      updated,
      unchanged,
      total: rows.length,
    };
    const history: ImportHistoryEntry = {
      id: createRecordId('import-log'),
      importedAt,
      files: [summary],
      added,
      updated,
      unchanged,
      total: rows.length,
    };

    return { inserts, updates, summary, history };
  }
}

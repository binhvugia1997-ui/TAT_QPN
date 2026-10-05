import { buildRecordIndex, getRecordFingerprint, type IdentityCandidate } from '../../business/duplicate/identity';
import { normalizeDefectRecord, normalizeDefectRecordPatch } from '../../models/defect-record';
import type { DefectRecord, DefectRecordPatch, RecordId } from '../../models/defect-record';
import type { ImportFileSummary, ImportHistoryEntry } from '../../models/import-history';
import { createRecordId } from '../../utils/id';
import { RecordRepository, type RecordChange } from '../database/recordRepository';

export interface CanonicalImportOptions {
  fileName: string;
  importedAt?: string;
}

export interface ImportResult extends ImportFileSummary {
  history: ImportHistoryEntry;
}

export type ImportPreviewSummary = Omit<ImportFileSummary, 'fileName' | 'error'>;

const IMPORT_IDENTITY_FIELDS = [
  'mgmtNo',
  'registeredDate',
  'plant',
  'partCode',
  'title',
  'defectQty',
] as const satisfies readonly (keyof DefectRecord)[];

/**
 * Only these TNP-controlled fields may update a matched local record.
 * - status: includes the source Reject state.
 * - dueDate: exact TNP header alias "Reply expeced date for final countermeasure";
 *   it is the current/effective TAT deadline for all applicable open records.
 *
 * registeredDate is used only as a TAT fallback input and identity information; it is
 * deliberately not synchronized on an existing record. Other source and app-managed
 * fields are also preserved.
 */
export const TNP_SYNC_FIELDS = ['status', 'dueDate'] as const;

interface PreparedImport {
  changes: RecordChange[];
  summary: ImportFileSummary;
  history: ImportHistoryEntry;
}

function idKey(id: RecordId): string {
  return `${typeof id}:${String(id)}`;
}

function pickPresentFields(
  row: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field) && row[field] !== undefined) {
      picked[field] = row[field];
    }
  }
  return picked;
}

function valuesEquivalent(left: unknown, right: unknown): boolean {
  // Null, undefined and an explicit blank have the same meaning for these source fields.
  return String(left ?? '') === String(right ?? '');
}

/**
 * Builds a change-only whitelist patch for an existing record. Importing unrelated TNP
 * columns or app-managed fields cannot overwrite local corrections or make the record
 * count as UPDATED.
 */
export function buildTnpSyncPatch(
  existingRecord: DefectRecord,
  importedRow: Record<string, unknown>,
): DefectRecordPatch {
  const incoming = normalizeDefectRecordPatch(pickPresentFields(importedRow, TNP_SYNC_FIELDS));
  const patch: Record<string, unknown> = {};

  for (const field of TNP_SYNC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
    const value = incoming[field];
    if (!valuesEquivalent(existingRecord[field], value)) patch[field] = value;
  }

  return patch as DefectRecordPatch;
}

function getImportIdentityCandidate(row: Record<string, unknown>): IdentityCandidate {
  // Normalize only fields used by the legacy identity key; unrelated row data never
  // participates in lookup or becomes part of an existing-record update.
  return normalizeDefectRecordPatch(pickPresentFields(row, IMPORT_IDENTITY_FIELDS)) as IdentityCandidate;
}

/**
 * Import orchestration for canonical rows. File parsing and preview UI live at the
 * service boundary; this service owns matching, whitelist sync, inserts and the audit.
 */
export class ImportService {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly repository: RecordRepository) {}

  /** Read-only preview that uses the same matching and sync rules as the eventual commit. */
  previewCanonicalRows(
    rows: readonly Record<string, unknown>[],
    fileName: string,
  ): Promise<ImportPreviewSummary> {
    const operation = this.writeQueue.then(async () => {
      const prepared = await this.prepareImport(rows, fileName);
      const { added, updated, unchanged, total } = prepared.summary;
      return { added, updated, unchanged, total };
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  importCanonicalRows(
    rows: readonly Record<string, unknown>[],
    options: CanonicalImportOptions,
  ): Promise<ImportResult> {
    const operation = this.writeQueue.then(
      () => this.performImport(rows, options),
      () => this.performImport(rows, options),
    );
    // Keep subsequent batches runnable after a rejected operation while returning the original rejection.
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async performImport(
    rows: readonly Record<string, unknown>[],
    options: CanonicalImportOptions,
  ): Promise<ImportResult> {
    const prepared = await this.prepareImport(rows, options.fileName, options.importedAt);
    // Record changes and the matching audit entry commit atomically. Failure leaves both untouched.
    await this.repository.commitImport(prepared.changes, prepared.history);
    return { ...prepared.summary, history: prepared.history };
  }

  private async prepareImport(
    rows: readonly Record<string, unknown>[],
    fileName: string,
    importedAtOption?: string,
  ): Promise<PreparedImport> {
    const existingRecords = await this.repository.getAllRecords();
    const identityIndex = buildRecordIndex(existingRecords);
    const changesById = new Map<string, RecordChange>();
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
          const key = idKey(match.id);
          changesById.set(key, {
            kind: changesById.get(key)?.kind === 'insert' ? 'insert' : 'update',
            record: merged,
          });
        }

        identityIndex.set(fingerprint, merged);
        if (didChange) updated += 1;
        else unchanged += 1;
        continue;
      }

      // A new record starts with all recognized canonical source fields plus any preserved
      // unrecognized sourceExtras. The strict two-field whitelist applies only to matches.
      const importPatch = normalizeDefectRecordPatch(row);
      const id = createRecordId('i');
      const inserted = normalizeDefectRecord({ ...importPatch, id, recordSource: 'import' }, 'import');
      identityIndex.set(fingerprint, inserted);
      changesById.set(idKey(id), { kind: 'insert', record: inserted });
      added += 1;
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
    return { changes: [...changesById.values()], summary, history };
  }
}

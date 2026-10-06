import { normalizeDefectRecordPatch } from '../../models/defect-record';
import type { DefectRecord, DefectRecordPatch } from '../../models/defect-record';

/**
 * Single source of truth for the TNP import rules. Both the browser-side preview and
 * the authoritative Node/SQLite import pipeline import these helpers, so a matched
 * record can never be merged differently depending on where the import runs.
 */

export const IMPORT_IDENTITY_FIELDS = [
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

export function pickPresentFields(
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

export function valuesEquivalent(left: unknown, right: unknown): boolean {
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

export type ImportIdentityCandidate = Partial<DefectRecord> & {
  mgmtNo?: unknown;
  registeredDate?: unknown;
  plant?: unknown;
  partCode?: unknown;
  title?: unknown;
  defectQty?: unknown;
};

/**
 * Normalize only fields used by the legacy identity key; unrelated row data never
 * participates in lookup or becomes part of an existing-record update.
 */
export function getImportIdentityCandidate(row: Record<string, unknown>): ImportIdentityCandidate {
  return normalizeDefectRecordPatch(pickPresentFields(row, IMPORT_IDENTITY_FIELDS)) as ImportIdentityCandidate;
}

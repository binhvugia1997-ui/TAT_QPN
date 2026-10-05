import type { DefectRecord } from '../../models/defect-record';

export type IdentityCandidate = Partial<DefectRecord> & {
  mgmtNo?: unknown;
  registeredDate?: unknown;
  plant?: unknown;
  partCode?: unknown;
  title?: unknown;
  defectQty?: unknown;
};

function legacyFingerprintPart(value: unknown): string {
  // Preserve the source algorithm's `value || ''` behavior (including 0 -> blank).
  return String(value || '').trim().toLowerCase();
}

/** Management Number first; exact legacy composite fallback when it is blank. */
export function getRecordFingerprint(record: IdentityCandidate): string {
  const managementNumber = legacyFingerprintPart(record.mgmtNo);
  if (managementNumber) return `mn:${managementNumber}`;
  return [
    'fp',
    record.registeredDate,
    record.plant,
    record.partCode,
    record.title,
    record.defectQty,
  ].map(legacyFingerprintPart).join('|');
}

/**
 * Match with the same last-entry-wins behavior as the legacy Map index.
 * Callers pass records in the same order used for the index (seed, then local/imported).
 */
export function findExistingRecord<T extends IdentityCandidate>(
  incoming: IdentityCandidate,
  records: readonly T[],
): T | undefined {
  const index = new Map<string, T>();
  for (const record of records) index.set(getRecordFingerprint(record), record);
  return index.get(getRecordFingerprint(incoming));
}

export function buildRecordIndex<T extends IdentityCandidate>(records: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const record of records) index.set(getRecordFingerprint(record), record);
  return index;
}

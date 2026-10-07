import type { RecordId } from '../../models/defect-record';

/**
 * Canonical record ids are either numbers (the immutable legacy seed) or strings
 * (imported/manual records). Persistence layers must never collapse `1` and `"1"`
 * into the same identity, so every stored id carries its type.
 */
export function getRecordIdKey(id: RecordId): string {
  return `${typeof id}:${String(id)}`;
}

export function parseRecordIdKey(key: string): RecordId {
  const separator = key.indexOf(':');
  if (separator < 0) return key;
  const kind = key.slice(0, separator);
  const raw = key.slice(separator + 1);
  if (kind === 'number') {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : raw;
  }
  return raw;
}

/** True when both ids denote the same canonical record, including its type. */
export function isSameRecordId(left: RecordId, right: RecordId): boolean {
  return getRecordIdKey(left) === getRecordIdKey(right);
}

import {
  normalizeVisibleColumns,
  serializeColumnPreference,
} from '../../business/records/columnVisibility';
import type { RecordsTableColumnKey } from '../../business/records/recordsTable';

/**
 * Per-client storage for the Records column choice.
 *
 * This is a UI preference and lives only in the browser's own storage: it is never sent
 * to the server, never written to SQLite, and never shared between workstations. Every
 * read is defensive — a missing key, corrupt JSON, a wrong shape or an unavailable
 * storage all fall back to the default configuration instead of throwing.
 */

export const RECORDS_COLUMN_STORAGE_KEY = 'tnp.records.visibleColumns';

/** Minimal storage surface, so tests and non-browser runtimes can inject their own. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): PreferenceStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can throw when it is disabled or blocked (private mode, locked profile).
    return null;
  }
}

/** Reads the saved column choice, falling back to the default when it is unusable. */
export function loadVisibleColumns(
  storage: PreferenceStorage | null = defaultStorage(),
  available?: readonly RecordsTableColumnKey[],
): ReadonlySet<RecordsTableColumnKey> {
  const fallback = normalizeVisibleColumns(null, available);
  if (!storage) return fallback;

  let raw: string | null;
  try {
    raw = storage.getItem(RECORDS_COLUMN_STORAGE_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;

  try {
    return normalizeVisibleColumns(JSON.parse(raw), available);
  } catch {
    return fallback;
  }
}

/**
 * Persists the column choice. A storage failure is not an error worth surfacing: the
 * selection still applies for the current session.
 */
export function saveVisibleColumns(
  visible: ReadonlySet<RecordsTableColumnKey>,
  storage: PreferenceStorage | null = defaultStorage(),
  available?: readonly RecordsTableColumnKey[],
): void {
  if (!storage) return;
  try {
    storage.setItem(RECORDS_COLUMN_STORAGE_KEY, JSON.stringify(serializeColumnPreference(visible, available)));
  } catch {
    // Quota or access errors leave the in-memory selection intact.
  }
}

import type { RecordsTableColumnKey } from '../../business/records/recordsTable';
import {
  columnWidthsToStore,
  parseStoredColumnWidth,
  type ColumnWidths,
} from '../../business/records/columnWidths';
import type { PreferenceStorage } from './columnPreferences';
import { browserStorage } from './preferenceStorage';

/**
 * Per-client storage for manually resized Records column widths.
 *
 * The shape deliberately mirrors the column-visibility preference — a versioned object holding
 * only what differs from the approved defaults — but it uses its own key so a corrupt or
 * half-upgraded width preference can never damage which columns are shown, or vice versa.
 *
 * Like every other preference here this is UI state: it is never sent to the server, never
 * written to SQLite, and never shared between workstations. Every read is defensive; a missing
 * key, corrupt JSON, an unknown column or an unavailable storage all fall back to the approved
 * widths instead of throwing.
 */

export const RECORDS_COLUMN_WIDTH_STORAGE_KEY = 'tnp.records.columnWidths';
export const COLUMN_WIDTH_PREFERENCE_VERSION = 1;

export interface ColumnWidthPreference {
  version: number;
  widths: Record<string, number>;
}

/** Reads the saved widths, dropping anything unusable and any column the table no longer has. */
export function loadColumnWidths(
  defaults: Readonly<Record<RecordsTableColumnKey, number>>,
  storage: PreferenceStorage | null = browserStorage(),
): ColumnWidths {
  let raw: string | null = null;
  try {
    raw = storage ? storage.getItem(RECORDS_COLUMN_WIDTH_STORAGE_KEY) : null;
  } catch {
    return {};
  }
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return normalizeColumnWidthPreference(parsed, defaults);
}

/** Coerces untrusted stored input into the known shape. Exported so the rule is testable. */
export function normalizeColumnWidthPreference(
  input: unknown,
  defaults: Readonly<Record<RecordsTableColumnKey, number>>,
): ColumnWidths {
  const widths = isPreferenceObject(input) ? input.widths : input;
  if (typeof widths !== 'object' || widths === null || Array.isArray(widths)) return {};

  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(widths as Record<string, unknown>)) {
    if (!(key in defaults)) continue;
    const width = parseStoredColumnWidth(value);
    // A stored value that already equals the default is dropped rather than pinned, so the
    // approved default can still move in a later version.
    if (width === null || width === defaults[key as RecordsTableColumnKey]) continue;
    next[key] = width;
  }
  return next;
}

function isPreferenceObject(input: unknown): input is ColumnWidthPreference & { widths: unknown } {
  return typeof input === 'object'
    && input !== null
    && !Array.isArray(input)
    && 'widths' in (input as Record<string, unknown>);
}

/** Persists the manual widths. A storage failure leaves the in-memory layout intact. */
export function saveColumnWidths(
  widths: ColumnWidths,
  defaults: Readonly<Record<RecordsTableColumnKey, number>>,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  if (!storage) return;
  const stored = columnWidthsToStore(widths, defaults);
  const preference: ColumnWidthPreference = { version: COLUMN_WIDTH_PREFERENCE_VERSION, widths: stored };
  try {
    // Writing an empty map is how "reset this column" is recorded: keeping the key with a
    // stale value would resurrect the width on the next reload.
    storage.setItem(RECORDS_COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Quota or access errors are not worth surfacing to an operator resizing a column.
  }
}

/** Removes the preference entirely, returning every column to its approved width. */
export function clearColumnWidths(storage: PreferenceStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(RECORDS_COLUMN_WIDTH_STORAGE_KEY);
  } catch {
    // Nothing to do: the in-memory reset still applies for this session.
  }
}

import type { RecordsTableColumn, RecordsTableColumnKey } from './recordsTable';
import { REQUIRED_RECORDS_COLUMNS } from './recordsTable';

/**
 * Which Records columns a client shows. This is display state only: it never touches
 * record data, the SQLite schema, imports, filters or TAT calculations. Hiding a column
 * hides the cell — the underlying field keeps its value and stays available in the
 * Detail drawer.
 */

const ALL_RECORDS_KEYS: readonly RecordsTableColumnKey[] = REQUIRED_RECORDS_COLUMNS.map(({ key }) => key);

/**
 * Columns the selector refuses to hide, so the table can never be reduced to something
 * unusable: a row still needs its sequence number, its identity and its QPN actions.
 */
export const PROTECTED_RECORDS_COLUMNS: readonly RecordsTableColumnKey[] = ['no', 'title', 'qpn'];

/** The default configuration: every approved column visible. */
export const DEFAULT_VISIBLE_COLUMNS: ReadonlySet<RecordsTableColumnKey> = new Set(ALL_RECORDS_KEYS);

/** Keys the column selector offers. The corrective CA badge is not user-configurable. */
export const SELECTABLE_RECORDS_COLUMNS: readonly RecordsTableColumn[] = REQUIRED_RECORDS_COLUMNS;

export function isProtectedColumn(key: RecordsTableColumnKey): boolean {
  return PROTECTED_RECORDS_COLUMNS.includes(key);
}

function selectableFrom(available: readonly RecordsTableColumnKey[]): RecordsTableColumnKey[] {
  const known = new Set<RecordsTableColumnKey>(available);
  return ALL_RECORDS_KEYS.filter((key) => known.has(key));
}

/**
 * Stored shape. The preference records which columns are *hidden* rather than which are
 * visible, which makes forward migration correct for free: a column added by a later
 * version is simply absent from `hidden`, so it appears by default. An older saved
 * preference can therefore never permanently hide a newly required column.
 */
export interface ColumnPreference {
  version: number;
  hidden: RecordsTableColumnKey[];
}

export const COLUMN_PREFERENCE_VERSION = 1;

/**
 * Turns stored or incoming input into a safe visible-column set.
 *
 * Deliberately forgiving, because a saved preference can outlive the version that wrote it:
 * - anything that is not a well-formed preference object falls back to the default;
 * - unknown or non-string keys (renamed/removed columns) are dropped;
 * - protected columns are always re-added, so the table stays usable;
 * - columns absent from `hidden` (including newly introduced ones) stay visible.
 */
export function normalizeVisibleColumns(
  input: unknown,
  available: readonly RecordsTableColumnKey[] = ALL_RECORDS_KEYS,
): ReadonlySet<RecordsTableColumnKey> {
  const keys = selectableFrom(available);
  const visible = new Set(keys);

  const hidden = isHiddenList(input);
  if (!hidden) return visible;

  for (const entry of hidden) {
    if (typeof entry !== 'string') continue;
    const key = entry as RecordsTableColumnKey;
    if (!visible.has(key) || isProtectedColumn(key)) continue;
    visible.delete(key);
  }

  return visible;
}

/** Accepts either the stored preference object or a bare array of hidden keys. */
function isHiddenList(input: unknown): unknown[] | null {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') {
    const candidate = (input as { hidden?: unknown }).hidden;
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

/**
 * Toggles one column, refusing to hide a protected one. Returns a new set, always ordered
 * by column order rather than by click order, so the rendered table never reorders itself.
 */
export function toggleVisibleColumn(
  current: ReadonlySet<RecordsTableColumnKey>,
  key: RecordsTableColumnKey,
): ReadonlySet<RecordsTableColumnKey> {
  const wanted = new Set(current);
  // A protected column cannot be switched off; the request is simply ignored.
  if (wanted.has(key) && !isProtectedColumn(key)) wanted.delete(key);
  else wanted.add(key);
  return new Set(ALL_RECORDS_KEYS.filter((item) => wanted.has(item)));
}

/** Select all: every selectable column visible. */
export function selectAllColumns(
  available: readonly RecordsTableColumnKey[] = ALL_RECORDS_KEYS,
): ReadonlySet<RecordsTableColumnKey> {
  return new Set(selectableFrom(available));
}

/** Reset default: back to the application's default configuration. */
export function resetVisibleColumns(
  available: readonly RecordsTableColumnKey[] = ALL_RECORDS_KEYS,
): ReadonlySet<RecordsTableColumnKey> {
  return new Set(selectableFrom(available));
}

/** Stable stored form, in column order. */
export function serializeColumnPreference(
  visible: ReadonlySet<RecordsTableColumnKey>,
  available: readonly RecordsTableColumnKey[] = ALL_RECORDS_KEYS,
): ColumnPreference {
  return {
    version: COLUMN_PREFERENCE_VERSION,
    hidden: selectableFrom(available).filter((key) => !visible.has(key)),
  };
}

/**
 * Applies visibility to the columns a workspace renders. The corrective CA badge is not
 * part of the approved selector list, so it is always kept in the corrective workspace.
 */
export function applyColumnVisibility(
  columns: readonly RecordsTableColumn[],
  visible: ReadonlySet<RecordsTableColumnKey>,
): readonly RecordsTableColumn[] {
  return columns.filter(({ key, correctiveOnly }) => correctiveOnly === true || visible.has(key));
}

/** Total rendered width of a column set; drives the table's minimum width. */
export function totalColumnWidth(columns: readonly RecordsTableColumn[]): number {
  return columns.reduce((sum, { width }) => sum + width, 0);
}

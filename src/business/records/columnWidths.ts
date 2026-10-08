import type { RecordsTableColumn, RecordsTableColumnKey } from './recordsTable';

/**
 * Manually resizable column widths for the Records table.
 *
 * The approved column spec carries a default width per column. An operator may drag a header
 * divider to a different width, and that choice belongs to *this client only* — it is a display
 * preference, stored in browser localStorage beside the column-visibility preference, never sent
 * to the server and never written to SQLite.
 *
 * The whole module is pure arithmetic on numbers and records, so the resize, clamp, persist and
 * layout rules are all unit-testable without a DOM.
 */

export const MIN_RECORDS_COLUMN_WIDTH = 48;
export const MAX_RECORDS_COLUMN_WIDTH = 640;

/**
 * Snap threshold for the table's own layout mode. Below the natural width the table keeps its
 * fixed px sizing and the container scrolls; at or above it, columns share the extra space in
 * proportion to their widths, which is what makes the table responsive to the window size.
 */
export const RESPONSIVE_SNAP_EPSILON_PX = 1;

export type ColumnWidths = Readonly<Partial<Record<RecordsTableColumnKey, number>>>;

/**
 * The default width map, straight from the approved spec, so a preference can be compared
 * against "untouched" without each caller re-reading the table definition.
 */
export function defaultColumnWidths(
  columns: readonly RecordsTableColumn[],
): Record<RecordsTableColumnKey, number> {
  const widths: Record<string, number> = {};
  for (const { key, width } of columns) widths[key] = width;
  return widths as Record<RecordsTableColumnKey, number>;
}

/** Clamps an already-numeric width into the usable range. */
function clampColumnWidthRange(value: number): number {
  if (value < MIN_RECORDS_COLUMN_WIDTH) return MIN_RECORDS_COLUMN_WIDTH;
  if (value > MAX_RECORDS_COLUMN_WIDTH) return MAX_RECORDS_COLUMN_WIDTH;
  return value;
}

/**
 * Interprets one stored width. Anything unusable — a non-numeric type, a non-finite number,
 * a negative or zero value — is reported as `null` so the caller falls back to the approved
 * default rather than inventing a layout.
 *
 * A numeric *string* is accepted because localStorage is text and a hand-edited preference is
 * legitimate; a boolean is not, since `true` would otherwise silently mean "1px".
 */
export function parseStoredColumnWidth(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const candidate = Number(value);
  if (!Number.isFinite(candidate) || candidate <= 0) return null;
  return clampColumnWidthRange(Math.round(candidate));
}

/** A stored width, or the column's approved default when the stored value is unusable. */
export function clampColumnWidth(value: unknown, fallback: number): number {
  const parsed = parseStoredColumnWidth(value);
  if (parsed !== null) return parsed;
  const fallbackWidth = Number(fallback);
  return clampColumnWidthRange(
    Number.isFinite(fallbackWidth) && fallbackWidth > 0 ? Math.round(fallbackWidth) : MIN_RECORDS_COLUMN_WIDTH,
  );
}

/**
 * The width a column takes after a drag: the starting width plus the pointer delta, clamped.
 *
 * `pointerClientX` is measured from the viewport, so `startPointerClientX` must come from the
 * same gesture for the arithmetic to be a delta rather than two unrelated positions.
 */
export function resizedColumnWidth(input: {
  startWidth: number;
  startPointerClientX: number;
  pointerClientX: number;
}): number {
  const start = clampColumnWidth(input.startWidth, MIN_RECORDS_COLUMN_WIDTH);
  const delta = Number(input.pointerClientX) - Number(input.startPointerClientX);
  if (!Number.isFinite(delta)) return start;
  // Clamp the *result*, not the start: dragging far past either edge must land exactly on the
  // bound. Falling back to `start` here would silently refuse a legitimate large drag.
  const target = start + delta;
  if (!Number.isFinite(target)) return start;
  return clampColumnWidth(target, MIN_RECORDS_COLUMN_WIDTH);
}

/**
 * Only widths that differ from the approved default are kept. A preference that stores nothing
 * is stored as nothing at all, so removing a width (double-click reset) needs no tombstone and
 * an upgrade that changes a default width is picked up automatically.
 */
export function columnWidthsToStore(
  widths: ColumnWidths,
  defaults: Readonly<Record<RecordsTableColumnKey, number>>,
): Record<string, number> {
  const stored: Record<string, number> = {};
  for (const [key, value] of Object.entries(widths)) {
    const columnKey = key as RecordsTableColumnKey;
    if (!(columnKey in defaults)) continue;
    if (value === undefined) continue;
    const clamped = clampColumnWidth(value, defaults[columnKey]);
    if (clamped === defaults[columnKey]) continue;
    stored[columnKey] = clamped;
  }
  return stored;
}

/**
 * Applies stored widths to the columns a workspace renders, in the column order that module owns.
 * Unknown keys are ignored, so a renamed or removed column cannot poison the layout, and a
 * missing key simply uses the approved default.
 */
export function applyColumnWidths(
  columns: readonly RecordsTableColumn[],
  stored: ColumnWidths,
): RecordsTableColumn[] {
  return columns.map((column) => {
    const width = stored[column.key];
    if (width === undefined) return { ...column };
    return { ...column, width: clampColumnWidth(width, column.width) };
  });
}

/** Restores one column to its approved default width, leaving every other column alone. */
export function resetColumnWidth(
  widths: ColumnWidths,
  key: RecordsTableColumnKey,
): ColumnWidths {
  if (widths[key] === undefined) return widths;
  const next: Record<string, number> = { ...widths };
  delete next[key];
  return next as ColumnWidths;
}

/** Drops every manual width. */
export function resetAllColumnWidths(): ColumnWidths {
  return {};
}

/**
 * Per-column sizing for the `<colgroup>` of a responsive table.
 *
 * `table-layout: fixed` ignores px `<col>` widths once their total is smaller than the table's
 * own computed width, which leaves dead space to the right of the last column and stops the
 * table from adapting to the window. Percentages avoid that: they always fill the table, and the
 * table's `min-width` (the natural width, in px) preserves each column's real minimum. Below that
 * width the container scrolls and the same proportions apply, so a resized column keeps the
 * share it was given.
 */
export interface ColumnLayoutInput {
  columns: readonly RecordsTableColumn[];
  /** Usable width of the scroll container, or null when it has not been measured yet. */
  availableWidth: number | null;
}

export interface ColumnLayout {
  /** Percentage width per column key, summing to 100. */
  percentages: Record<string, number>;
  /** The table's CSS `min-width` in px — the point below which it scrolls instead of shrinking. */
  minWidth: number;
  /** Natural (preferred) width in px, i.e. the sum of the columns' own widths. */
  naturalWidth: number;
  /** True when the container is narrower than the natural width, so it scrolls. */
  scrolls: boolean;
}

export function computeColumnLayout(input: ColumnLayoutInput): ColumnLayout {
  const naturalWidth = input.columns.reduce((sum, { width }) => sum + clampColumnWidth(width, MIN_RECORDS_COLUMN_WIDTH), 0);
  const percentages: Record<string, number> = {};

  if (input.columns.length === 0) {
    return { percentages, minWidth: 0, naturalWidth: 0, scrolls: false };
  }

  for (const { key, width } of input.columns) {
    const clamped = clampColumnWidth(width, MIN_RECORDS_COLUMN_WIDTH);
    percentages[key] = roundPercentage((clamped / naturalWidth) * 100);
  }

  // Percentages are rounded to 4 dp; absorb the residual into the widest column so the row
  // always accounts for exactly 100% and no column is starved by a rounding remainder.
  const residual = roundPercentage(100 - Object.values(percentages).reduce((sum, value) => sum + value, 0));
  if (residual !== 0) {
    const widest = input.columns.reduce((best, column) => (
      column.width > best.width ? column : best
    ), input.columns[0]!);
    percentages[widest.key] = roundPercentage(percentages[widest.key]! + residual);
  }

  return {
    percentages,
    minWidth: naturalWidth,
    naturalWidth,
    scrolls: input.availableWidth !== null
      && Number.isFinite(input.availableWidth)
      && input.availableWidth < naturalWidth - RESPONSIVE_SNAP_EPSILON_PX,
  };
}

function roundPercentage(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Width of the scroll container, measured defensively. jsdom and other non-layout hosts report
 * 0, which must not collapse the table; the caller falls back to natural sizing in that case.
 */
export function measureScrollWidth(clientWidth: unknown, scrollWidth: unknown): number | null {
  const primary = Number(clientWidth);
  if (Number.isFinite(primary) && primary > 0) return primary;
  const fallback = Number(scrollWidth);
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return null;
}

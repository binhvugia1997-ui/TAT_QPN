import type { DefectRecord } from '../../models/defect-record';
import type { MessageKey } from '../../i18n';
import type { DateOnly } from '../../utils/date';
import { isDateOnly } from '../../utils/date';
import { naturalTextCompare } from '../../utils/naturalCompare';
import { getPendingDays, getTatDueDate } from '../tat/tat';
import { getRecordIdKey } from './recordKey';

/**
 * Single source of truth for the approved Records table layout.
 *
 * The fourteen columns below and their order are the approved specification; the table
 * renders them in a horizontally scrolling container rather than collapsing back into a
 * compact subset. Keeping the spec here (instead of inline in JSX) makes the column
 * order and every cell mapping directly unit-testable.
 */

export type RecordsTableColumnKey =
  | 'no'
  | 'mqis'
  | 'registeredDate'
  | 'pic'
  | 'approval'
  | 'plant'
  | 'title'
  | 'occurPlace'
  | 'partGroup'
  | 'defectName'
  | 'condition'
  | 'qpn'
  | 'tatSystem'
  | 'pendingDays'
  | 'caLink';

/**
 * Columns that have an orderable source value. `no` is a rendered row sequence,
 * `qpn` is a file link and `caLink` is a workspace-only badge, so none of those are
 * sortable. `condition` is app-managed free text rather than a source field, so it stays
 * out of the approved sort set.
 */
export type RecordsTableSortableColumn = Exclude<RecordsTableColumnKey, 'no' | 'condition' | 'qpn' | 'caLink'>;

export interface RecordsTableColumn {
  key: RecordsTableColumnKey;
  label: MessageKey;
  /**
   * Rendered width in px. Drives the generated `<colgroup>`, so widths always line up
   * with whichever columns are currently visible instead of relying on column position.
   */
  width: number;
  sortable?: RecordsTableSortableColumn;
  /** Appended after the fourteen approved columns, and only in the corrective workspace. */
  correctiveOnly?: boolean;
}

/** The approved Records columns, in exactly this order. */
export const REQUIRED_RECORDS_COLUMNS: readonly RecordsTableColumn[] = [
  { key: 'no', label: 'noColumn', width: 52 },
  { key: 'mqis', label: 'mqisColumn', width: 130, sortable: 'mqis' },
  { key: 'registeredDate', label: 'registeredDateColumn', width: 108, sortable: 'registeredDate' },
  { key: 'pic', label: 'picColumn', width: 100, sortable: 'pic' },
  { key: 'approval', label: 'approvalColumn', width: 130, sortable: 'approval' },
  { key: 'plant', label: 'recordsPlantColumn', width: 78, sortable: 'plant' },
  { key: 'title', label: 'titleColumn', width: 200, sortable: 'title' },
  { key: 'occurPlace', label: 'occurPlaceColumn', width: 160, sortable: 'occurPlace' },
  { key: 'partGroup', label: 'partGroupColumn', width: 170, sortable: 'partGroup' },
  { key: 'defectName', label: 'defectNameColumn', width: 220, sortable: 'defectName' },
  { key: 'condition', label: 'conditionColumn', width: 100 },
  { key: 'qpn', label: 'qpnColumn', width: 124 },
  { key: 'tatSystem', label: 'tatSystemColumn', width: 128, sortable: 'tatSystem' },
  { key: 'pendingDays', label: 'pendingDaysColumn', width: 100, sortable: 'pendingDays' },
];

/** Everything the table can render: the approved columns plus the corrective-only badge. */
export const RECORDS_TABLE_COLUMNS: readonly RecordsTableColumn[] = [
  ...REQUIRED_RECORDS_COLUMNS,
  { key: 'caLink', label: 'caLinkColumn', width: 102, correctiveOnly: true },
];

/** Columns a given workspace mode actually renders, in order. */
export function getVisibleRecordsColumns(mode: { corrective: boolean }): readonly RecordsTableColumn[] {
  return RECORDS_TABLE_COLUMNS.filter(({ correctiveOnly }) => !correctiveOnly || mode.corrective);
}

/**
 * The field the MQIS column displays: the canonical Management Number.
 *
 * Named once and exported so the cell mapping, the row component, the search haystack and
 * the tests cannot drift apart. It is a *display* binding only — record identity matching,
 * the import whitelist and the SQLite schema are untouched, and no new database field is
 * introduced: `mgmtNo` is already stored in its own column and in the record payload.
 *
 * The value is handed through as text, so a stored number keeps every leading zero and its
 * original formatting; nothing parses or re-serialises it as a number.
 */
export const MQIS_COLUMN: RecordsTableColumnKey = 'mqis';
export const MQIS_DISPLAY_FIELD = 'mgmtNo' as const;

/**
 * The "Tên lỗi" column and the app-managed field behind it. Exported so the row component,
 * the save handler, and the tests all name the manual field in one place.
 */
export const MANUAL_DEFECT_NAME_COLUMN: RecordsTableColumnKey = 'defectName';
export const MANUAL_DEFECT_NAME_FIELD = 'manualDefectName' as const;

/**
 * The "Tình trạng" column and its app-managed field. `manualCondition` exists so the
 * operator can record a condition by hand without disturbing the canonical TNP `status`,
 * which drives Approval, Completed/Rejected scoping and TAT. Like `manualDefectName` it is
 * outside the import whitelist, so an Excel re-import can never overwrite it.
 */
export const MANUAL_CONDITION_COLUMN: RecordsTableColumnKey = 'condition';
export const MANUAL_CONDITION_FIELD = 'manualCondition' as const;

/** The app-managed manual fields editable inline in the Records table. */
export const MANUAL_INLINE_FIELDS = [MANUAL_DEFECT_NAME_FIELD, MANUAL_CONDITION_FIELD] as const;
export type ManualInlineField = (typeof MANUAL_INLINE_FIELDS)[number];

/** True when `field` is one of the Records table's app-managed inline manual fields. */
export function isManualInlineField(field: string): field is ManualInlineField {
  return (MANUAL_INLINE_FIELDS as readonly string[]).includes(field);
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return trimToNull(value);
  if (typeof value === 'number') return numberToCanonicalText(value);
  return null;
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Renders a numeric source value as canonical text without going through any numeric
 * round-trip that could drop information. A stored number is already lossless here; a
 * string is returned untouched, so leading zeros survive.
 */
function numberToCanonicalText(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return String(value);
}

/**
 * Canonical display text for an identity-style code (the MQIS column).
 *
 * Accepted shapes are strings and finite numbers only. Anything else — objects, arrays,
 * booleans — is treated as absent rather than stringified, so a malformed value can never
 * render `[object Object]` in a column the operator reads as a record number. Leading zeros
 * and inner spacing of a stored string are preserved exactly: the only transformation is
 * trimming outer whitespace.
 */
export function canonicalCodeText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (typeof value === 'number') return numberToCanonicalText(value);
  return null;
}

export { naturalTextCompare };

function dateOnly(value: unknown): DateOnly | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Raw source value behind one cell, before locale formatting. `null` means the cell
 * shows the em dash placeholder.
 *
 * - `no` is never sourced from data: the caller renders the row sequence.
 * - `qpn` is answered by `findAttachedReport`, not by a record field.
 * - `mqis` shows the canonical Management Number, not the optional `mqisCode` extension.
 * - `condition` shows the app-manual `manualCondition`, never the Approval status.
 * - `tatSystem` uses the effective TAT deadline (source dueDate, else registeredDate + 7).
 * - `pendingDays` is derived only from registeredDate and never reads dueDate.
 */
export function getRecordCellSource(
  record: DefectRecord,
  column: RecordsTableColumnKey,
  today: DateOnly,
): string | number | null {
  switch (column) {
    case 'no': return null;
    // MQIS is the record's canonical Management Number. The separate `mqisCode` extension
    // field is deliberately NOT the display source: it is unpopulated for every seeded
    // record, which is what made this column render "—" on rows that do have a number.
    case 'mqis': return canonicalCodeText(record[MQIS_DISPLAY_FIELD]);
    case 'registeredDate': return dateOnly(record.registeredDate);
    case 'pic': return text(record.pic);
    case 'approval': return text(record.status);
    case 'plant': return text(record.plant);
    case 'title': return text(record.title);
    case 'occurPlace': return text(record.occurPlace);
    case 'partGroup': return text(record.partGroup);
    // "Tên lỗi" is the app-managed manual value, never the imported `defectDetails`.
    case 'defectName': return text(record.manualDefectName);
    // "Tình trạng" is app-managed and independent of the canonical Approval/status value.
    case 'condition': return text(record.manualCondition);
    case 'qpn': return null;
    case 'tatSystem': return getTatDueDate(record);
    case 'pendingDays': return getPendingDays(record, today);
    case 'caLink': return text(record.caFileLink);
  }
}

/** True when the effective TAT deadline came from the source TNP dueDate, not the 7-day fallback. */
export function hasSourceTatDeadline(record: DefectRecord): boolean {
  return getTatDueDate(record) !== null && isDateOnly(record.dueDate);
}

export interface AttachedReport {
  originalName: string;
}

export type ReportIndex = ReadonlyMap<string, AttachedReport>;

/** Indexes the bulk report payload by canonical record id key (`type:value`). */
export function createReportIndex(
  entries: readonly { recordIdKey: string; originalName: string }[],
): ReportIndex {
  const index = new Map<string, AttachedReport>();
  for (const entry of entries) {
    index.set(entry.recordIdKey, { originalName: entry.originalName });
  }
  return index;
}

/** The report linked to a record, matched on the type-preserving canonical id key. */
export function findAttachedReport(
  record: Pick<DefectRecord, 'id'>,
  index: ReportIndex,
): AttachedReport | undefined {
  return index.get(getRecordIdKey(record.id));
}

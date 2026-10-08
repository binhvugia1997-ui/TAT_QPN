import type { DefectRecord } from '../../models/defect-record';
import type { MessageKey } from '../../i18n';
import type { DateOnly } from '../../utils/date';
import { isDateOnly } from '../../utils/date';
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
 * `condition` has no verified source field, `qpn` is a file link and `caLink` is a
 * workspace-only badge, so none of those are sortable.
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

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function dateOnly(value: unknown): DateOnly | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Raw source value behind one cell, before locale formatting. `null` means the cell
 * shows the em dash placeholder.
 *
 * - `no` is never sourced from data: the caller renders the row sequence.
 * - `qpn` is answered by `findAttachedReport`, not by a record field.
 * - `condition` has no verified source field, so it always returns `null` and the table
 *   shows "—". No value is invented or derived for it.
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
    case 'mqis': return text(record.mqisCode);
    case 'registeredDate': return dateOnly(record.registeredDate);
    case 'pic': return text(record.pic);
    case 'approval': return text(record.status);
    case 'plant': return text(record.plant);
    case 'title': return text(record.title);
    case 'occurPlace': return text(record.occurPlace);
    case 'partGroup': return text(record.partGroup);
    // "Tên lỗi" is the app-managed manual value, never the imported `defectDetails`.
    case 'defectName': return text(record.manualDefectName);
    case 'condition': return null;
    case 'qpn': return null;
    case 'tatSystem': return getTatDueDate(record);
    case 'pendingDays': return getPendingDays(record, today);
    case 'caLink': return text(record.caFileLink);
  }
}

/**
 * The "Tên lỗi" column and the app-managed field behind it. Exported so the row component,
 * the save handler, and the tests all name the manual field in one place.
 */
export const MANUAL_DEFECT_NAME_COLUMN: RecordsTableColumnKey = 'defectName';
export const MANUAL_DEFECT_NAME_FIELD = 'manualDefectName' as const;

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

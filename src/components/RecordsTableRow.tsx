import type { ReactNode } from 'react';
import type { DefectRecord } from '../models/defect-record';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import {
  findAttachedReport,
  getRecordCellSource,
  hasSourceTatDeadline,
  type RecordsTableColumnKey,
  type ReportIndex,
} from '../business/records/recordsTable';
import { isCompletedStatus } from '../business/status/status';
import { isRejectedStatus } from '../business/status/status';
import { displayDate } from '../utils/displayDate';
import InlineTextCell from './InlineTextCell';
import QpnCell from './QpnCell';
import { shouldOpenDrawer } from './recordRowInteraction';

/** Text form of a cell's source value; `null` means the cell shows the em dash placeholder. */
export function cellText(record: DefectRecord, column: RecordsTableColumnKey, today: string): string | null {
  const value = getRecordCellSource(record, column, today);
  return value === null ? null : String(value);
}

export function statusTone(status: string): string {
  if (isRejectedStatus(status)) return 'status-rejected';
  if (isCompletedStatus(status)) return 'status-completed';
  if (status === 'Đợi đối sách') return 'status-active';
  return 'status-unknown';
}

interface RecordsTableRowProps {
  locale: Locale;
  record: DefectRecord;
  /** Rendered row sequence for the NO column; never read from the record. */
  sequence: number;
  today: string;
  reportIndex: ReportIndex;
  showCaLink: boolean;
  /** Columns currently visible, in approved order; the CA badge is appended when shown. */
  columns: readonly RecordsTableColumnKey[];
  onSelect: (record: DefectRecord) => void;
  /**
   * Persists an inline edit of the manual "Tên lỗi" field through the record update path.
   * Rejecting leaves the previous value on screen and the reason is shown in the cell.
   */
  onSaveDefectName: (record: DefectRecord, next: string) => Promise<void>;
  /**
   * Same contract as `onSaveDefectName`, for the manual "Tình trạng" field. Optional because
   * workspaces that do not own the manual field (Corrective, Rejected) keep rendering the
   * value read-only rather than offering an edit that could not be saved.
   */
  onSaveCondition?: (record: DefectRecord, next: string) => Promise<void>;
  /** Called after a QPN attachment change so the row refreshes without a full reload. */
  onReportChanged: () => void;
}

/**
 * One row of the approved Records table, rendering only the visible columns in the
 * approved order. The corrective workspace appends the pre-existing CA-file badge.
 */
export default function RecordsTableRow({
  locale,
  record,
  sequence,
  today,
  reportIndex,
  showCaLink,
  columns,
  onSelect,
  onSaveDefectName,
  onSaveCondition,
  onReportChanged,
}: RecordsTableRowProps) {
  const mqis = cellText(record, 'mqis', today);
  const registeredDate = cellText(record, 'registeredDate', today);
  const pic = cellText(record, 'pic', today);
  const approval = cellText(record, 'approval', today);
  const plant = cellText(record, 'plant', today);
  const title = cellText(record, 'title', today);
  const occurPlace = cellText(record, 'occurPlace', today);
  const partGroup = cellText(record, 'partGroup', today);
  const defectName = cellText(record, 'defectName', today);
  const condition = cellText(record, 'condition', today);
  const tatDeadline = cellText(record, 'tatSystem', today);
  const pendingDays = getRecordCellSource(record, 'pendingDays', today);
  const report = findAttachedReport(record, reportIndex);
  const hasCaLink = Boolean(record.caFileLink?.trim());
  const placeholder = <span className="unassigned-value">—</span>;
  const shown = new Set(columns);

  /** Renders one approved cell, or nothing when the user hid that column. */
  function cell(key: RecordsTableColumnKey, content: ReactNode) {
    return shown.has(key) ? content : null;
  }

  return (
    <tr
      className={`record-row${isCompletedStatus(record.status) ? ' completed-record-row' : ''}`}
      onDoubleClick={(event) => {
        // Buttons, links, inputs and anything opting in via data-tnp-row-interactive keep
        // the double-click for themselves; the drawer opens only on row chrome.
        const target = event.target instanceof Element ? event.target : null;
        if (shouldOpenDrawer(target)) onSelect(record);
      }}
    >
      {/* NO is the rendered row sequence only. */}
      {cell('no', <td className="row-sequence-cell" key="no">{sequence}</td>)}
      {cell('mqis', <td className="mqis-cell" key="mqis" title={mqis ?? undefined}>{mqis ?? placeholder}</td>)}
      {cell('registeredDate', <td className="date-cell" key="registeredDate">{displayDate(registeredDate, locale)}</td>)}
      {cell('pic', <td className="pic-cell" key="pic">{pic ?? placeholder}</td>)}
      {cell('approval', (
        <td className="approval-cell" key="approval">
          {approval
            ? <span className={`status-pill ${statusTone(approval)}`}>{approval}</span>
            : placeholder}
        </td>
      ))}
      {cell('plant', <td className="plant-cell" key="plant">{plant ?? placeholder}</td>)}
      {cell('title', <td className="title-cell" key="title" title={title ?? undefined}>{title ?? placeholder}</td>)}
      {cell('occurPlace', <td className="occur-place-cell" key="occurPlace" title={occurPlace ?? undefined}>{occurPlace ?? placeholder}</td>)}
      {cell('partGroup', <td className="part-group-cell" key="partGroup" title={partGroup ?? undefined}>{partGroup ?? placeholder}</td>)}
      {/*
        "Tên lỗi" is app-managed: it starts blank and is typed here, saved through the record
        update path. The imported `defectDetails` is never shown in this column and is never
        written by an edit, so it stays intact as the source value.
      */}
      {cell('defectName', (
        <td className="defect-name-cell" key="defectName" data-tnp-row-interactive="">
          <InlineTextCell
            value={defectName ?? ''}
            label={translate(locale, 'defectNameEditLabel')}
            placeholder={translate(locale, 'defectNamePlaceholder')}
            onSave={(next) => onSaveDefectName(record, next)}
          />
        </td>
      ))}
      {/*
        "Tình trạng" is app-managed, exactly like "Tên lỗi": it reads and writes only
        `manualCondition`. The canonical Approval column keeps showing the TNP `status`, so
        entering a condition here cannot move the record between the Active, Completed or
        Rejected scopes. Without a save handler the cell stays a plain read-only value.
      */}
      {cell('condition', (
        onSaveCondition
          ? (
            <td className="condition-cell" key="condition" data-tnp-row-interactive="">
              <InlineTextCell
                value={condition ?? ''}
                label={translate(locale, 'conditionEditLabel')}
                placeholder={translate(locale, 'conditionPlaceholder')}
                onSave={(next) => onSaveCondition(record, next)}
              />
            </td>
          )
          : <td className="condition-cell" key="condition">{condition ?? placeholder}</td>
      ))}
      {cell('qpn', (
        <td className="qpn-cell" key="qpn" data-tnp-row-interactive="">
          <QpnCell locale={locale} record={record} report={report} onChanged={onReportChanged} />
        </td>
      ))}
      {cell('tatSystem', (
        <td className="date-cell deadline-cell" key="tatSystem">
          {displayDate(tatDeadline, locale)}
          {tatDeadline && <small>{translate(locale, hasSourceTatDeadline(record) ? 'sourceDeadline' : 'fallbackDeadline')}</small>}
        </td>
      ))}
      {/*
        Ngày Pending is derived from registeredDate only and never reads dueDate. It renders
        blank — not 0, not "—" — when the defect is no longer in the active response stage.
      */}
      {cell('pendingDays', (
        <td className={pendingDays === null ? 'pending-cell pending-blank' : 'pending-cell'} key="pendingDays">
          {pendingDays ?? ''}
        </td>
      ))}
      {showCaLink && (
        <td className="ca-link-cell" title={hasCaLink ? record.caFileLink ?? undefined : undefined}>
          <span className={hasCaLink ? 'ca-link-state attached' : 'ca-link-state missing'}>
            {translate(locale, hasCaLink ? 'caLinked' : 'missingCaLink')}
          </span>
        </td>
      )}
    </tr>
  );
}

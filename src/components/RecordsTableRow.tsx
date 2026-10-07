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
import { serverApi } from '../services/server/serverRecordRepository';
import { displayDate } from '../utils/displayDate';

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
  onSelect: (record: DefectRecord) => void;
}

/**
 * One row of the approved 14-column Records table, rendered in the approved order.
 * The corrective workspace appends the pre-existing CA-file badge as a 15th column.
 */
export default function RecordsTableRow({
  locale,
  record,
  sequence,
  today,
  reportIndex,
  showCaLink,
  onSelect,
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
  const tatDeadline = cellText(record, 'tatSystem', today);
  const pendingDays = getRecordCellSource(record, 'pendingDays', today);
  const qpn = findAttachedReport(record, reportIndex);
  const hasCaLink = Boolean(record.caFileLink?.trim());
  const placeholder = <span className="unassigned-value">—</span>;

  return (
    <tr
      className={`record-row${isCompletedStatus(record.status) ? ' completed-record-row' : ''}`}
      onClick={() => onSelect(record)}
    >
      {/* NO is the rendered row sequence only. */}
      <td className="row-sequence-cell">{sequence}</td>
      <td className="mqis-cell" title={mqis ?? undefined}>{mqis ?? placeholder}</td>
      <td className="date-cell">{displayDate(registeredDate, locale)}</td>
      <td className="pic-cell">{pic ?? placeholder}</td>
      <td className="approval-cell">
        {approval
          ? <span className={`status-pill ${statusTone(approval)}`}>{approval}</span>
          : placeholder}
      </td>
      <td className="plant-cell">{plant ?? placeholder}</td>
      <td className="title-cell" title={title ?? undefined}>{title ?? placeholder}</td>
      <td className="occur-place-cell" title={occurPlace ?? undefined}>{occurPlace ?? placeholder}</td>
      <td className="part-group-cell" title={partGroup ?? undefined}>{partGroup ?? placeholder}</td>
      <td className="defect-name-cell" title={defectName ?? undefined}>{defectName ?? placeholder}</td>
      {/* Tình trạng has no verified source field, so the column spec returns null and this cell is always "—". */}
      <td className="condition-cell">{cellText(record, 'condition', today) ?? placeholder}</td>
      <td className="qpn-cell">
        {qpn ? (
          <a
            className="qpn-file-link"
            href={serverApi.reportUrl(record.id)}
            target="_blank"
            rel="noreferrer"
            title={qpn.originalName}
            aria-label={`${translate(locale, 'qpnFileLabel')}: ${qpn.originalName}`}
            onClick={(event) => event.stopPropagation()}
          >
            {translate(locale, 'qpnFileLabel')}
          </a>
        ) : placeholder}
      </td>
      <td className="date-cell deadline-cell">
        {displayDate(tatDeadline, locale)}
        {tatDeadline && <small>{translate(locale, hasSourceTatDeadline(record) ? 'sourceDeadline' : 'fallbackDeadline')}</small>}
      </td>
      {/* Ngày Pending is derived from registeredDate only; it never reads dueDate. */}
      <td className="pending-cell">{pendingDays === null ? placeholder : pendingDays}</td>
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

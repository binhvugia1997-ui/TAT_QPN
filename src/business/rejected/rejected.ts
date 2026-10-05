import type { DefectRecord } from '../../models/defect-record';
import type { DateOnly } from '../../utils/date';
import { isRejectedStatus } from '../status/status';
import { sortTatByPriority } from '../tat/tat';

/** Exact legacy Rejected status only; Rejected stays open and uses shared TAT urgency. */
export function getRejectedRecords(records: readonly DefectRecord[], today: DateOnly): DefectRecord[] {
  return sortTatByPriority(records.filter((record) => isRejectedStatus(record.status)), today);
}

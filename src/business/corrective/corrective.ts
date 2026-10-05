import type { DefectRecord } from '../../models/defect-record';
import type { DateOnly } from '../../utils/date';
import { isCompletedStatus } from '../status/status';
import { isTatOverdue, sortRecordsByOperationalPriority } from '../tat/tat';

export type CorrectiveActionScope = 'all' | 'unassigned' | 'missing-ca-link';

export interface CorrectiveActionSummary {
  actionable: number;
  overdue: number;
  unassigned: number;
  missingCaLink: number;
}

export function summarizeCorrectiveActions(records: readonly DefectRecord[], today: DateOnly): CorrectiveActionSummary {
  const active = records.filter((record) => !isCompletedStatus(record.status));
  return {
    actionable: active.length,
    overdue: active.filter((record) => isTatOverdue(record, today)).length,
    unassigned: active.filter((record) => !record.pic?.trim()).length,
    missingCaLink: active.filter((record) => !record.caFileLink?.trim()).length,
  };
}

/** Active/rejected records share the existing effective-TAT priority, without a new database or edit path. */
export function getCorrectiveActionRecords(
  records: readonly DefectRecord[],
  today: DateOnly,
  scope: CorrectiveActionScope = 'all',
): DefectRecord[] {
  const actionable = records.filter((record) => !isCompletedStatus(record.status));
  const scoped = scope === 'unassigned'
    ? actionable.filter((record) => !record.pic?.trim())
    : scope === 'missing-ca-link'
      ? actionable.filter((record) => !record.caFileLink?.trim())
      : actionable;
  return sortRecordsByOperationalPriority(scoped, today);
}

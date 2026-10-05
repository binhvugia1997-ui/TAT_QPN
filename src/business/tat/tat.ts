import type { DefectRecord } from '../../models/defect-record';
import { addCalendarDays, daysUntil, normalizeDateOnly, type DateOnly } from '../../utils/date';
import { isCompletedStatus } from '../status/status';

export const LEGACY_TAT_WINDOW_DAYS = 7;
export type TatTier = 'overdue' | 'due-today' | 'one-day' | 'two-days' | 'on-track';
type TatDeadlineRecord = Pick<DefectRecord, 'registeredDate' | 'dueDate'>;
type TrackedTatRecord = TatDeadlineRecord & Pick<DefectRecord, 'status'>;

/**
 * The TNP final-countermeasure reply date is the current/effective TAT deadline.
 * `registeredDate + 7` is only a fallback when that source deadline is blank/missing.
 */
export function getTatDueDate(record: TatDeadlineRecord): DateOnly | null {
  if (record.dueDate) {
    try {
      const sourceDeadline = normalizeDateOnly(record.dueDate);
      if (sourceDeadline) return sourceDeadline;
    } catch {
      // An invalid TNP date is not an effective deadline; use the explicit fallback.
    }
  }
  return addCalendarDays(record.registeredDate, LEGACY_TAT_WINDOW_DAYS);
}

export function getTatDaysRemaining(
  record: TatDeadlineRecord,
  today: DateOnly,
): number | null {
  const dueDate = getTatDueDate(record);
  return dueDate ? daysUntil(dueDate, today) : null;
}

export function getTatTier(
  record: TrackedTatRecord,
  today: DateOnly,
): TatTier | null {
  if (isCompletedStatus(record.status)) return null;
  const remaining = getTatDaysRemaining(record, today);
  if (remaining === null) return null;
  if (remaining < 0) return 'overdue';
  if (remaining === 0) return 'due-today';
  if (remaining === 1) return 'one-day';
  if (remaining === 2) return 'two-days';
  return 'on-track';
}

/** Open-record overdue state against the current/effective TAT deadline. */
export function isTatOverdue(record: TrackedTatRecord, today: DateOnly): boolean {
  if (isCompletedStatus(record.status)) return false;
  const remaining = getTatDaysRemaining(record, today);
  return remaining !== null && remaining < 0;
}

/** Sorts open records most urgent first; undated records are last and completed records are excluded. */
export function sortTatByPriority<T extends TrackedTatRecord>(
  records: readonly T[],
  today: DateOnly,
): T[] {
  return records
    .filter((record) => !isCompletedStatus(record.status))
    .map((record, index) => ({ record, index, remaining: getTatDaysRemaining(record, today) }))
    .sort((left, right) => {
      if (left.remaining === null) return right.remaining === null ? left.index - right.index : 1;
      if (right.remaining === null) return -1;
      return left.remaining - right.remaining || left.index - right.index;
    })
    .map(({ record }) => record);
}

/** Active work is urgent-first; exact legacy Completed statuses remain together at the bottom. */
export function sortRecordsByOperationalPriority<T extends DefectRecord>(
  records: readonly T[],
  today: DateOnly,
): T[] {
  const active = sortTatByPriority(records.filter((record) => !isCompletedStatus(record.status)), today);
  const completed = records
    .filter((record) => isCompletedStatus(record.status))
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const completionOrder = String(right.record.completedDate ?? '').localeCompare(String(left.record.completedDate ?? ''));
      if (completionOrder) return completionOrder;
      const registrationOrder = String(right.record.registeredDate ?? '').localeCompare(String(left.record.registeredDate ?? ''));
      return registrationOrder || left.index - right.index;
    })
    .map(({ record }) => record);
  return [...active, ...completed];
}

/** Corrective-action deadline uses the source dueDate; TAT also uses it as its current deadline. */
export function isActionOverdue(
  record: Pick<DefectRecord, 'status' | 'dueDate'>,
  today: DateOnly,
): boolean {
  if (isCompletedStatus(record.status) || !record.dueDate) return false;
  const remaining = daysUntil(record.dueDate, today);
  return remaining !== null && remaining < 0;
}

export function isActionDueSoon(
  record: Pick<DefectRecord, 'status' | 'dueDate'>,
  today: DateOnly,
): boolean {
  if (isCompletedStatus(record.status) || !record.dueDate) return false;
  const remaining = daysUntil(record.dueDate, today);
  return remaining !== null && remaining >= 0 && remaining <= 3;
}

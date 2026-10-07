export const LEGACY_STATUS_VALUES = [
  'Hoàn thành',
  'Đợi đối sách',
  'Đợi duyệt',
  'Đợi xét',
  'Rejected (xét)',
] as const;

export type KnownLegacyStatus = (typeof LEGACY_STATUS_VALUES)[number];

// This set is intentionally derived from the exact legacy completed logic.
export const COMPLETED_STATUSES: ReadonlySet<string> = new Set([
  'Hoàn thành',
  'Đợi duyệt',
  'Đợi xét',
]);

export function isCompletedStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && COMPLETED_STATUSES.has(status);
}

export function isRejectedStatus(status: string | null | undefined): boolean {
  return status === 'Rejected (xét)';
}

/** Reject is a separate dashboard classification and remains open in legacy KPIs/TAT. */
export function isOpenStatus(status: string | null | undefined): boolean {
  return !isCompletedStatus(status);
}

/**
 * Whether the "Ngày Pending" window still applies to a record.
 *
 * The pending window is only meaningful while a defect is still in the active response
 * stage. The project already classifies exactly those no-longer-active states in
 * `COMPLETED_STATUSES` ("Hoàn thành", "Đợi duyệt", "Đợi xét"), so this reuses that
 * canonical set instead of restating the status strings. "Rejected (xét)" is still an
 * open classification and keeps its pending window.
 *
 * This is a display rule only: it never changes status, registeredDate, dueDate or the
 * TAT effective deadline, and no pending value is persisted.
 */
export function isPendingWindowApplicable(status: string | null | undefined): boolean {
  return !isCompletedStatus(status);
}

export function statusClassification(status: string | null | undefined): {
  completed: boolean;
  rejected: boolean;
  open: boolean;
  known: boolean;
} {
  return {
    completed: isCompletedStatus(status),
    rejected: isRejectedStatus(status),
    open: isOpenStatus(status),
    known: status !== null && status !== undefined && LEGACY_STATUS_VALUES.includes(status as KnownLegacyStatus),
  };
}

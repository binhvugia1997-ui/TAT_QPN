import type { DefectRecord } from '../../models/defect-record';
import type { DateOnly } from '../../utils/date';
import { isCompletedStatus, isRejectedStatus } from '../status/status';
import { isTatOverdue } from '../tat/tat';

export interface DefectKpis {
  total: number;
  open: number;
  completed: number;
  overdue: number;
  rejected: number;
  onTimeClosureRate: number | null;
  closedWithBothDates: number;
  onTimeClosed: number;
}

/** Keeps legacy counts/on-time formulas while overdue uses the confirmed effective TAT date. */
export function calculateDefectKpis(records: readonly DefectRecord[], today: DateOnly): DefectKpis {
  const completed = records.filter((record) => isCompletedStatus(record.status)).length;
  const recordsWithBothDates = records.filter((record) => record.completedDate && record.dueDate);
  const onTimeClosed = recordsWithBothDates.filter(
    (record) => String(record.completedDate) <= String(record.dueDate),
  ).length;

  return {
    total: records.length,
    open: records.length - completed,
    completed,
    overdue: records.filter((record) => isTatOverdue(record, today)).length,
    rejected: records.filter((record) => isRejectedStatus(record.status)).length,
    onTimeClosureRate: recordsWithBothDates.length
      ? Math.round((onTimeClosed / recordsWithBothDates.length) * 100)
      : null,
    closedWithBothDates: recordsWithBothDates.length,
    onTimeClosed,
  };
}

export interface PlantStats {
  total: number;
  open: number;
  completed: number;
  overdue: number;
  rejected: number;
}

export function calculatePlantStats(
  records: readonly DefectRecord[],
  today: DateOnly,
): Record<string, PlantStats> {
  const byPlant: Record<string, PlantStats> = {};
  for (const record of records) {
    const plant = record.plant || 'Not analyzed';
    const stats = byPlant[plant] ??= { total: 0, open: 0, completed: 0, overdue: 0, rejected: 0 };
    stats.total += 1;
    if (isCompletedStatus(record.status)) stats.completed += 1;
    else stats.open += 1;
    if (isTatOverdue(record, today)) stats.overdue += 1;
    if (isRejectedStatus(record.status)) stats.rejected += 1;
  }
  return byPlant;
}

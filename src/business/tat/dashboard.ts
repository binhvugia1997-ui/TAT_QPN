import type { DefectRecord } from '../../models/defect-record';
import type { DateOnly } from '../../utils/date';
import { isCompletedStatus } from '../status/status';
import { getTatDaysRemaining } from './tat';

export type TatDashboardBucket = 'overdue' | 'due-today' | 'one-day' | 'two-days' | 'later' | 'no-deadline';
export type TatMonitoringFilter = 'all' | TatDashboardBucket | 'due-soon' | 'on-track';

export interface TatPlantBreakdown {
  plant: string;
  filterValue: string;
  count: number;
}

export interface TatDashboardSnapshot {
  active: number;
  tracked: number;
  buckets: Record<TatDashboardBucket, number>;
  overdueByPlant: TatPlantBreakdown[];
}

function bucketFor(remaining: number | null): TatDashboardBucket {
  if (remaining === null) return 'no-deadline';
  if (remaining < 0) return 'overdue';
  if (remaining === 0) return 'due-today';
  if (remaining === 1) return 'one-day';
  if (remaining === 2) return 'two-days';
  return 'later';
}

export function getTatMonitoringBucket(record: DefectRecord, today: DateOnly): TatDashboardBucket | null {
  if (isCompletedStatus(record.status)) return null;
  return bucketFor(getTatDaysRemaining(record, today));
}

/** Shared Records drill-down predicate for dashboard TAT buckets. */
export function matchesTatMonitoringFilter(
  record: DefectRecord,
  filter: TatMonitoringFilter,
  today: DateOnly,
): boolean {
  if (filter === 'all') return true;
  if (isCompletedStatus(record.status)) return false;
  const remaining = getTatDaysRemaining(record, today);
  if (filter === 'due-soon') return remaining !== null && remaining >= 1 && remaining <= 3;
  if (filter === 'on-track') return remaining !== null && remaining > 3;
  return getTatMonitoringBucket(record, today) === filter;
}

/** Uses the shared effective-deadline helper and exact Completed status set. */
export function calculateTatDashboard(
  records: readonly DefectRecord[],
  today: DateOnly,
): TatDashboardSnapshot {
  const buckets: TatDashboardSnapshot['buckets'] = {
    overdue: 0,
    'due-today': 0,
    'one-day': 0,
    'two-days': 0,
    later: 0,
    'no-deadline': 0,
  };
  const overduePlants = new Map<string, number>();
  let active = 0;
  let tracked = 0;

  for (const record of records) {
    if (isCompletedStatus(record.status)) continue;
    active += 1;
    const remaining = getTatDaysRemaining(record, today);
    if (remaining !== null) tracked += 1;
    const bucket = bucketFor(remaining);
    buckets[bucket] += 1;
    if (bucket === 'overdue') {
      const plant = record.plant?.trim() ? record.plant : '';
      overduePlants.set(plant, (overduePlants.get(plant) ?? 0) + 1);
    }
  }

  return {
    active,
    tracked,
    buckets,
    overdueByPlant: [...overduePlants.entries()]
      .map(([filterValue, count]) => ({ plant: filterValue || 'Not analyzed', filterValue, count }))
      .sort((left, right) => right.count - left.count || left.plant.localeCompare(right.plant)),
  };
}

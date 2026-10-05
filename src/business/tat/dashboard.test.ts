import { describe, expect, it } from 'vitest';
import { applyRecordFilters, buildRecordsHref, createEmptyFilters, parseRecordFilters } from '../filters/filters';
import type { DefectRecord } from '../../models/defect-record';
import { calculateTatDashboard, matchesTatMonitoringFilter } from './dashboard';

const record = (id: number, overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id,
  recordSource: 'legacy-seed',
  mgmtNo: `T-${id}`,
  status: 'Đợi đối sách',
  registeredDate: '2026-10-01',
  dueDate: '2026-10-10',
  plant: 'SEV',
  ...overrides,
});

const today = '2026-10-05';

describe('TAT dashboard aggregation', () => {
  it('counts urgency buckets from effective dueDate, falls back by seven days, and excludes Completed', () => {
    const snapshot = calculateTatDashboard([
      record(1, { dueDate: '2026-10-04', plant: 'SEV' }),
      record(2, { dueDate: today }),
      record(3, { dueDate: '2026-10-06' }),
      record(4, { dueDate: '2026-10-07', registeredDate: '2026-09-01' }),
      record(5, { dueDate: '2026-10-08' }),
      record(6, { registeredDate: '2026-09-27', dueDate: null, plant: 'SEVT' }),
      record(7, { status: 'Hoàn thành', dueDate: '2026-10-01' }),
    ], today);

    expect(snapshot.active).toBe(6);
    expect(snapshot.tracked).toBe(6);
    expect(snapshot.buckets).toEqual({
      overdue: 2,
      'due-today': 1,
      'one-day': 1,
      'two-days': 1,
      later: 1,
      'no-deadline': 0,
    });
    expect(snapshot.overdueByPlant).toEqual([
      { plant: 'SEV', filterValue: 'SEV', count: 1 },
      { plant: 'SEVT', filterValue: 'SEVT', count: 1 },
    ]);
  });

  it('places active records with neither source nor fallback date in No deadline', () => {
    const snapshot = calculateTatDashboard([record(1, { dueDate: null, registeredDate: null })], today);
    expect(snapshot.active).toBe(1);
    expect(snapshot.tracked).toBe(0);
    expect(snapshot.buckets['no-deadline']).toBe(1);
  });

  it('drills a one-day bucket into the matching filtered Records subset', () => {
    const records = [
      record(1, { plant: 'SEV', dueDate: '2026-10-06' }),
      record(2, { plant: 'SEV', dueDate: '2026-10-07' }),
      record(3, { plant: 'SEVT', dueDate: '2026-10-06' }),
      record(4, { plant: 'SEV', status: 'Hoàn thành', dueDate: '2026-10-06' }),
    ];
    const filters = { ...createEmptyFilters(), plant: new Set(['SEV']) };
    const href = buildRecordsHref(filters, { view: 'active', tat: 'one-day' });
    const params = new URL(href, 'https://local.test').searchParams;
    const subset = applyRecordFilters(records, parseRecordFilters(params))
      .filter((item) => matchesTatMonitoringFilter(item, params.get('tat') as 'one-day', today));

    expect(subset.map(({ id }) => id)).toEqual([1]);
  });

  it('returns zero buckets and no chart categories for an empty filtered set', () => {
    expect(calculateTatDashboard([], today)).toEqual({
      active: 0,
      tracked: 0,
      buckets: {
        overdue: 0,
        'due-today': 0,
        'one-day': 0,
        'two-days': 0,
        later: 0,
        'no-deadline': 0,
      },
      overdueByPlant: [],
    });
  });
});

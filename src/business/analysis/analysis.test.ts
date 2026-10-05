import { describe, expect, it } from 'vitest';
import { applyRecordFilters, createEmptyFilters } from '../filters/filters';
import type { DefectRecord } from '../../models/defect-record';
import { calculateAnalysis } from './analysis';

const record = (id: number, overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id,
  recordSource: 'import',
  mgmtNo: `A-${id}`,
  status: 'Đợi đối sách',
  registeredDate: '2026-10-01',
  plant: 'SEV',
  project: 'Project A',
  model: 'Model A',
  reason1: 'Máy móc',
  partCode: 'CODE-A',
  ...overrides,
});

const today = '2026-10-05';

describe('analysis aggregation', () => {
  it('aggregates by plant and preserves the current exact status classification', () => {
    const snapshot = calculateAnalysis([
      record(1, { plant: 'SEV', dueDate: '2026-10-04' }),
      record(2, { plant: 'SEVT', status: 'Hoàn thành', dueDate: '2026-10-01' }),
      record(3, { plant: 'SEV', status: 'Rejected (xét)', dueDate: '2026-10-04' }),
    ], today);

    expect(snapshot.byPlant.map(({ label, count }) => [label, count])).toEqual([['SEV', 2], ['SEVT', 1]]);
    expect(Object.fromEntries(snapshot.byStatus.map(({ label, count }) => [label, count]))).toEqual({
      'Rejected (xét)': 1, 'Hoàn thành': 1, 'Đợi đối sách': 1,
    });
    expect(snapshot.summary).toMatchObject({ total: 3, active: 2, completed: 1, rejected: 1, overdue: 2 });
  });

  it('groups the registered-date trend by month and excludes records without valid dates', () => {
    const snapshot = calculateAnalysis([
      record(1, { registeredDate: '2026-09-30' }),
      record(2, { registeredDate: '2026-10-01' }),
      record(3, { registeredDate: '2026-10-19' }),
      record(4, { registeredDate: null }),
    ], today);

    expect(snapshot.trend).toEqual([
      { month: '2026-09', count: 1 },
      { month: '2026-10', count: 2 },
    ]);
    expect(snapshot.summary.monthCount).toBe(2);
  });

  it('returns only the requested top categories in count order', () => {
    const snapshot = calculateAnalysis([
      record(1, { reason1: 'A' }),
      record(2, { reason1: 'A' }),
      record(3, { reason1: 'A' }),
      record(4, { reason1: 'B' }),
      record(5, { reason1: 'B' }),
      record(6, { reason1: 'C' }),
    ], today, 2);

    expect(snapshot.byReason.map(({ label, count }) => [label, count])).toEqual([['A', 3], ['B', 2]]);
  });

  it('keeps every distinct imported source status even when other categories are top-N', () => {
    const records = Array.from({ length: 8 }, (_, index) => record(index + 1, {
      status: `Source status ${index + 1}`,
      reason1: 'Shared reason',
    }));
    const snapshot = calculateAnalysis(records, today, 2);
    expect(snapshot.byReason).toHaveLength(1);
    expect(snapshot.byStatus).toHaveLength(8);
  });

  it('recalculates every analysis group from the shared filtered subset', () => {
    const records = [
      record(1, { plant: 'SEV', project: 'P1', status: 'Đợi đối sách' }),
      record(2, { plant: 'SEVT', project: 'P2', status: 'Hoàn thành' }),
      record(3, { plant: 'SEV', project: 'P3', status: 'Rejected (xét)' }),
    ];
    const filtered = applyRecordFilters(records, { ...createEmptyFilters(), plant: new Set(['SEV']) });
    const snapshot = calculateAnalysis(filtered, today);

    expect(snapshot.summary.total).toBe(2);
    expect(snapshot.summary.completed).toBe(0);
    expect(snapshot.byProjectModel.map(({ label }) => label)).toEqual(['P1 · Model A', 'P3 · Model A']);
    expect(snapshot.byPlant).toHaveLength(1);
  });

  it('returns safe empty aggregations for no matching records', () => {
    const snapshot = calculateAnalysis([], today);
    expect(snapshot.summary).toEqual({
      total: 0, active: 0, completed: 0, rejected: 0, overdue: 0, plantCount: 0, monthCount: 0,
    });
    expect(snapshot.trend).toEqual([]);
    expect(snapshot.byPlant).toEqual([]);
    expect(snapshot.byStatus).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { DefectRecord } from '../../models/defect-record';
import { getRejectedRecords } from './rejected';

const record = (id: number, status: string, dueDate: string | null): DefectRecord => ({
  id,
  recordSource: 'import',
  mgmtNo: `R-${id}`,
  status,
  registeredDate: '2026-10-01',
  dueDate,
});

const today = '2026-10-05';

describe('Rejected operational scope', () => {
  it('includes only the exact Rejected status and orders by effective TAT urgency', () => {
    const records = [
      record(1, 'Rejected (xét)', '2026-10-08'),
      record(2, 'Đợi đối sách', '2026-10-02'),
      record(3, 'Rejected (xét)', '2026-10-03'),
      record(4, 'Hoàn thành', '2026-10-01'),
      record(5, 'Rejected', '2026-10-01'),
    ];
    expect(getRejectedRecords(records, today).map(({ id }) => id)).toEqual([3, 1]);
  });

  it('updates inclusion automatically when the source status changes', () => {
    const current = record(1, 'Rejected (xét)', '2026-10-08');
    expect(getRejectedRecords([current], today).map(({ id }) => id)).toEqual([1]);
    expect(getRejectedRecords([{ ...current, status: 'Hoàn thành' }], today)).toEqual([]);
    expect(getRejectedRecords([{ ...current, status: 'Đợi đối sách' }], today)).toEqual([]);
    expect(getRejectedRecords([{ ...current, status: 'Rejected (xét)' }], today).map(({ id }) => id)).toEqual([1]);
  });

  it('returns empty after all rejected records transition away', () => {
    expect(getRejectedRecords([record(1, 'Hoàn thành', '2026-10-01')], today)).toEqual([]);
  });
});

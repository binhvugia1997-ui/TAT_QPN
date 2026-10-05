import { describe, expect, it } from 'vitest';
import type { DefectRecord } from '../../models/defect-record';
import { calculateDefectKpis, calculatePlantStats } from './kpi';

const row = (id: number, overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id,
  recordSource: 'legacy-seed',
  mgmtNo: `M-${id}`,
  status: 'Đợi đối sách',
  plant: 'SEV',
  ...overrides,
});

const today = '2026-10-02';

describe('legacy KPI formulas', () => {
  it('counts completed, open, rejected and effective-deadline overdue statuses', () => {
    const records = [
      row(1, { status: 'Hoàn thành', dueDate: '2026-10-01', completedDate: '2026-10-01' }),
      row(2, { status: 'Đợi duyệt' }),
      row(3, { status: 'Đợi đối sách', dueDate: '2026-10-01' }),
      row(4, { status: 'Rejected (xét)', dueDate: '2026-10-01' }),
    ];
    expect(calculateDefectKpis(records, today)).toMatchObject({
      total: 4,
      open: 2,
      completed: 2,
      overdue: 2,
      rejected: 1,
      onTimeClosureRate: 100,
      closedWithBothDates: 1,
    });
  });

  it('does not count the stale +7 date as overdue when a later TNP deadline is present', () => {
    const extended = row(8, {
      registeredDate: '2026-10-01',
      dueDate: '2026-10-17',
    });
    expect(calculateDefectKpis([extended], '2026-10-12').overdue).toBe(0);
    expect(calculatePlantStats([extended], '2026-10-12').SEV.overdue).toBe(0);
  });

  it('uses registeredDate + 7 as the overdue fallback when the current TNP deadline is blank', () => {
    const overdueFallback = row(7, {
      registeredDate: '2026-09-24',
      dueDate: null,
    });
    expect(calculateDefectKpis([overdueFallback], today).overdue).toBe(1);
    expect(calculatePlantStats([overdueFallback], today).SEV.overdue).toBe(1);
  });

  it('uses all records with both dates in the on-time denominator, even if status is open', () => {
    const records = [
      row(1, { status: 'Hoàn thành', dueDate: '2026-10-01', completedDate: '2026-10-01' }),
      row(2, { status: 'Đợi đối sách', dueDate: '2026-10-01', completedDate: '2026-10-02' }),
    ];
    expect(calculateDefectKpis(records, today).onTimeClosureRate).toBe(50);
  });

  it('groups market totals using the same completed/open rules', () => {
    const stats = calculatePlantStats([
      row(1, { status: 'Đợi đối sách', dueDate: '2026-10-01' }),
      row(2, { status: 'Hoàn thành', plant: 'SEVT' }),
    ], today);
    expect(stats.SEV.open).toBe(1);
    expect(stats.SEV.overdue).toBe(1);
    expect(stats.SEVT.completed).toBe(1);
  });
});

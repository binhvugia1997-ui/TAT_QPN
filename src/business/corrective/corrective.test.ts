import { describe, expect, it } from 'vitest';
import type { DefectRecord } from '../../models/defect-record';
import { getCorrectiveActionRecords, summarizeCorrectiveActions } from './corrective';

const record = (id: number, overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id,
  recordSource: 'legacy-seed',
  mgmtNo: `C-${id}`,
  status: 'Đợi đối sách',
  registeredDate: '2026-10-01',
  dueDate: '2026-10-10',
  plant: 'SEV',
  ...overrides,
});

const today = '2026-10-05';

describe('corrective-action workspace selection', () => {
  it('keeps open and Rejected work, excludes Completed, and prioritizes effective TAT urgency', () => {
    const records = [
      record(1, { dueDate: '2026-10-08', pic: 'Lan' }),
      record(2, { status: 'Rejected (xét)', dueDate: '2026-10-03', caFileLink: 'file:///ca.xlsx' }),
      record(3, { status: 'Hoàn thành', dueDate: '2026-10-01' }),
      record(4, { status: 'Đợi duyệt', dueDate: '2026-10-02' }),
    ];

    expect(getCorrectiveActionRecords(records, today).map(({ id }) => id)).toEqual([2, 1]);
  });

  it('supports compact follow-up scopes for unassigned PIC and missing CA link', () => {
    const records = [
      record(1, { pic: null, caFileLink: 'file:///ca.xlsx' }),
      record(2, { pic: 'Lan', caFileLink: null }),
      record(3, { pic: null, caFileLink: null, status: 'Hoàn thành' }),
    ];

    expect(getCorrectiveActionRecords(records, today, 'unassigned').map(({ id }) => id)).toEqual([1]);
    expect(getCorrectiveActionRecords(records, today, 'missing-ca-link').map(({ id }) => id)).toEqual([2]);
    expect(summarizeCorrectiveActions(records, today)).toEqual({
      actionable: 2,
      overdue: 0,
      unassigned: 1,
      missingCaLink: 1,
    });
  });

  it('returns a safe empty summary and list', () => {
    expect(summarizeCorrectiveActions([], today)).toEqual({ actionable: 0, overdue: 0, unassigned: 0, missingCaLink: 0 });
    expect(getCorrectiveActionRecords([], today)).toEqual([]);
  });
});

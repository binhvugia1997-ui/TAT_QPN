import { describe, expect, it } from 'vitest';
import { isCompletedStatus, isOpenStatus, isRejectedStatus, statusClassification } from './status';

describe('legacy status rules', () => {
  it.each(['Hoàn thành', 'Đợi duyệt', 'Đợi xét'])('%s is completed', (status) => {
    expect(isCompletedStatus(status)).toBe(true);
    expect(isOpenStatus(status)).toBe(false);
  });

  it('keeps rejected as rejected and open, as the legacy dashboards do', () => {
    expect(isRejectedStatus('Rejected (xét)')).toBe(true);
    expect(isCompletedStatus('Rejected (xét)')).toBe(false);
    expect(statusClassification('Rejected (xét)')).toEqual({
      completed: false,
      rejected: true,
      open: true,
      known: true,
    });
  });

  it('preserves unknown source statuses as open instead of coercing them', () => {
    expect(isCompletedStatus('New source status')).toBe(false);
    expect(isOpenStatus('New source status')).toBe(true);
    expect(statusClassification('New source status').known).toBe(false);
  });
});

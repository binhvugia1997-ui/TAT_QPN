import { describe, expect, it } from 'vitest';
import type { DefectRecord } from '../../models/defect-record';
import {
  getTatDueDate,
  getTatDaysRemaining,
  getPendingDays,
  getTatTier,
  isActionDueSoon,
  isActionOverdue,
  isTatOverdue,
  sortTatByPriority,
  sortRecordsByOperationalPriority,
} from './tat';

const today = '2026-10-12';
const record = (overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id: 'tat-test',
  recordSource: 'manual',
  mgmtNo: 'TAT-1',
  status: 'Đợi đối sách',
  registeredDate: '2026-10-02',
  dueDate: '2026-10-09',
  ...overrides,
});

describe('effective TAT deadline', () => {
  it('uses the TNP reply date instead of registeredDate + 7 when it is present', () => {
    const pending = record({ dueDate: '2026-10-18' });
    expect(getTatDueDate(pending)).toBe('2026-10-18');
    expect(getTatDaysRemaining(pending, today)).toBe(6);
    expect(getTatTier(pending, today)).toBe('on-track');
  });

  it('uses registeredDate + 7 only when the TNP deadline is blank', () => {
    const fallback = record({ registeredDate: '2026-10-05', dueDate: null });
    expect(getTatDueDate(fallback)).toBe('2026-10-12');
    expect(getTatDaysRemaining(fallback, today)).toBe(0);
    expect(getTatTier(fallback, today)).toBe('due-today');
  });

  it('treats an invalid source date as unavailable and uses the explicit fallback', () => {
    const invalid = record({ registeredDate: '2026-10-05', dueDate: '2026-02-31' });
    expect(getTatDueDate(invalid)).toBe('2026-10-12');
    expect(getTatDaysRemaining(invalid, today)).toBe(0);
  });

  it('uses the fallback for an overdue record when no TNP deadline is available', () => {
    const overdue = record({ registeredDate: '2026-10-04', dueDate: null });
    expect(getTatDueDate(overdue)).toBe('2026-10-11');
    expect(getTatDaysRemaining(overdue, today)).toBe(-1);
    expect(getTatTier(overdue, today)).toBe('overdue');
    expect(isTatOverdue(overdue, today)).toBe(true);
  });

  it('uses the effective source deadline for Reject records', () => {
    const rejected = record({ status: 'Rejected (xét)', dueDate: '2026-10-17' });
    expect(getTatDueDate(rejected)).toBe('2026-10-17');
    expect(getTatDaysRemaining(rejected, today)).toBe(5);
    expect(isTatOverdue(rejected, today)).toBe(false);
  });

  it('uses the effective source deadline for another open status', () => {
    const otherOpenStatus = record({ status: 'Supplier Review', dueDate: '2026-10-17' });
    expect(getTatDueDate(otherOpenStatus)).toBe('2026-10-17');
    expect(getTatDaysRemaining(otherOpenStatus, today)).toBe(5);
    expect(isTatOverdue(otherOpenStatus, today)).toBe(false);
  });

  it('does not mark an open record overdue from stale +7 data when its current TNP deadline is later', () => {
    const extended = record({ dueDate: '2026-10-17' });
    expect(getTatDueDate(extended)).toBe('2026-10-17');
    expect(isTatOverdue(extended, today)).toBe(false);
  });

  it('excludes completed statuses from TAT tiers and overdue checks', () => {
    const closed = record({ status: 'Hoàn thành', dueDate: '2026-10-01' });
    expect(getTatTier(closed, today)).toBeNull();
    expect(isTatOverdue(closed, today)).toBe(false);
    expect(getTatTier(record({ status: 'Đợi duyệt' }), today)).toBeNull();
    expect(getTatTier(record({ status: 'Đợi xét' }), today)).toBeNull();
  });

  it('returns no TAT result when both source deadline and fallback date are missing', () => {
    const missing = record({ registeredDate: null, dueDate: null });
    expect(getTatDueDate(missing)).toBeNull();
    expect(getTatDaysRemaining(missing, today)).toBeNull();
    expect(getTatTier(missing, today)).toBeNull();
    expect(isTatOverdue(missing, today)).toBe(false);
  });

  it('keeps active work urgency-first and moves Completed below it; Rejected stays active', () => {
    const completedOlder = record({ id: 1, mgmtNo: 'DONE-OLD', status: 'Hoàn thành', completedDate: '2026-10-02', dueDate: '2026-10-18' });
    const rejected = record({ id: 2, mgmtNo: 'REJECTED', status: 'Rejected (xét)', dueDate: '2026-10-17' });
    const completedNewer = record({ id: 3, mgmtNo: 'DONE-NEW', status: 'Đợi duyệt', completedDate: '2026-10-11' });
    const overdue = record({ id: 4, mgmtNo: 'OVERDUE', dueDate: '2026-10-10' });

    expect(sortRecordsByOperationalPriority([completedOlder, rejected, completedNewer, overdue], today)
      .map((item) => item.mgmtNo)).toEqual(['OVERDUE', 'REJECTED', 'DONE-NEW', 'DONE-OLD']);
    expect(sortRecordsByOperationalPriority([
      { ...completedOlder, status: 'Đợi đối sách' }, rejected, completedNewer, overdue,
    ], today).map((item) => item.mgmtNo)).toEqual(['OVERDUE', 'REJECTED', 'DONE-OLD', 'DONE-NEW']);
  });

  it('sorts records by days remaining against the effective deadline, with undated records last', () => {
    const onTrack = record({ id: 1, mgmtNo: 'ON-TRACK', dueDate: '2026-10-18' });
    const noDeadline = record({ id: 2, mgmtNo: 'NO-DEADLINE', registeredDate: null, dueDate: null });
    const overdue = record({ id: 3, mgmtNo: 'OVERDUE', dueDate: '2026-10-10' });
    const dueToday = record({ id: 4, mgmtNo: 'DUE-TODAY', dueDate: today });
    const completed = record({ id: 5, mgmtNo: 'COMPLETED', status: 'Hoàn thành', dueDate: '2026-10-01' });

    expect(sortTatByPriority([onTrack, noDeadline, dueToday, overdue, completed], today).map((item) => item.mgmtNo))
      .toEqual(['OVERDUE', 'DUE-TODAY', 'ON-TRACK', 'NO-DEADLINE']);
  });
});

describe('pending-day window (Ngày Pending)', () => {
  it('counts 7 calendar days from registeredDate and goes negative past the window', () => {
    // today is 2026-10-12 in this suite.
    expect(getPendingDays(record({ registeredDate: '2026-10-05' }), today)).toBe(0);
    expect(getPendingDays(record({ registeredDate: '2026-10-12' }), today)).toBe(7);
    expect(getPendingDays(record({ registeredDate: '2026-10-13' }), today)).toBe(8);
    expect(getPendingDays(record({ registeredDate: '2026-10-01' }), today)).toBe(-4);
  });

  it('stays independent of the TAT deadline: the agreed example keeps both values apart', () => {
    // registeredDate = 2026-10-01, today = 2026-10-11, dueDate = 2026-10-15
    const example = record({ registeredDate: '2026-10-01', dueDate: '2026-10-15' });

    expect(getTatDueDate(example)).toBe('2026-10-15');
    expect(getPendingDays(example, '2026-10-11')).toBe(-3);
  });

  it('never reads dueDate, so the pending window is unchanged when only the deadline moves', () => {
    const base = record({ registeredDate: '2026-10-08' });
    // Typed as full records so the narrow `Pick<registeredDate>` parameter keeps proving
    // at compile time that the pending window cannot reach the TNP deadline.
    const withoutDeadline: DefectRecord = { ...base, dueDate: null };
    const farDeadline: DefectRecord = { ...base, dueDate: '2027-06-30' };

    expect(getPendingDays(base, today)).toBe(3);
    expect(getPendingDays(withoutDeadline, today)).toBe(3);
    expect(getPendingDays(farDeadline, today)).toBe(3);
  });

  it('counts calendar days across a month boundary without drifting', () => {
    expect(getPendingDays(record({ registeredDate: '2026-09-28' }), today)).toBe(-7);
  });

  it('has no pending window when registeredDate is missing or unparsable', () => {
    expect(getPendingDays(record({ registeredDate: null }), today)).toBeNull();
    expect(getPendingDays(record({ registeredDate: undefined }), today)).toBeNull();
    expect(getPendingDays({ ...record(), registeredDate: 'not-a-date' as never }, today)).toBeNull();
  });
});

describe('corrective-action deadline helpers', () => {
  it('continues to use the source dueDate for action overdue checks', () => {
    const action = record({ dueDate: '2026-10-11' });
    expect(isActionOverdue(action, today)).toBe(true);
  });

  it('includes today through three days ahead in action due-soon', () => {
    expect(isActionDueSoon(record({ dueDate: today }), today)).toBe(true);
    expect(isActionDueSoon(record({ dueDate: '2026-10-15' }), today)).toBe(true);
    expect(isActionDueSoon(record({ dueDate: '2026-10-16' }), today)).toBe(false);
  });
});

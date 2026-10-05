import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getRejectedRecords } from '../../business/rejected/rejected';
import { isCompletedStatus } from '../../business/status/status';
import { calculateTatDashboard, getTatMonitoringBucket } from '../../business/tat/dashboard';
import { getTatDaysRemaining, getTatDueDate, sortRecordsByOperationalPriority } from '../../business/tat/tat';
import { IndexedDbDatabase } from '../database/database';
import { RecordRepository } from '../database/recordRepository';
import { DuplicateRecordError, RecordService } from './recordService';

let nextDatabase = 0;
function makeService(): RecordService {
  const database = new IndexedDbDatabase({
    name: `tnp-record-service-test-${++nextDatabase}`,
    factory: globalThis.indexedDB,
  });
  return new RecordService(new RecordRepository(database));
}

describe('record service', () => {
  it('applies the legacy manual-entry defaults and stores normalized data', async () => {
    const service = makeService();
    const record = await service.addRecord({
      mgmtNo: '  ',
      plant: ' SEV ',
      registeredDate: '2026-10-02',
      sampleQty: '250',
      defectQty: '',
    });
    expect(record.mgmtNo).toMatch(/^NEW-/);
    expect(record.status).toBe('Đợi đối sách');
    expect(record.title).toBe('(untitled defect)');
    expect(record.plant).toBe('SEV');
    expect(record.locatedCorp).toBe('SEV');
    expect(record.sampleQty).toBe(250);
    expect(record.defectQty).toBeNull();
  });

  it('rejects a manually created record with a matching identity instead of duplicating it', async () => {
    const service = makeService();
    await service.addRecord({ mgmtNo: 'TNP-600', title: 'One defect' });
    await expect(service.addRecord({ mgmtNo: 'tnp-600', title: 'Another title' })).rejects.toBeInstanceOf(DuplicateRecordError);
  });

  it('updates and reloads app-managed corrective fields through the existing service path', async () => {
    const service = makeService();
    const current = await service.addRecord({ mgmtNo: 'TNP-CA-1', title: 'Follow-up defect' });

    await service.updateRecord(current.id, {
      pic: 'Lan Anh',
      notes: 'Request evidence from supplier',
      caFileLink: 'file:///local/ca/countermeasure.xlsx',
    });

    await expect(service.getRecord(current.id)).resolves.toMatchObject({
      id: current.id,
      pic: 'Lan Anh',
      notes: 'Request evidence from supplier',
      caFileLink: 'file:///local/ca/countermeasure.xlsx',
    });
  });

  it('recomputes Active, Completed, Rejected, TAT buckets and operational urgency after saved status/deadline changes', async () => {
    const service = makeService();
    const today = '2026-10-12';
    const openRecord = await service.addRecord({
      mgmtNo: 'TNP-E2E-OPEN',
      registeredDate: '2026-10-01',
      status: 'Đợi đối sách',
      dueDate: '2026-10-10',
    });
    const rejectedRecord = await service.addRecord({
      mgmtNo: 'TNP-E2E-REJECTED',
      registeredDate: '2026-10-01',
      status: 'Rejected (xét)',
      dueDate: '2026-10-13',
    });

    let records = await service.getAllRecords();
    expect(calculateTatDashboard(records, today).buckets).toMatchObject({ overdue: 1, 'one-day': 1 });
    expect(getRejectedRecords(records, today).map((record) => record.id)).toEqual([rejectedRecord.id]);
    expect(sortRecordsByOperationalPriority(records, today).map((record) => record.id))
      .toEqual([openRecord.id, rejectedRecord.id]);

    await service.updateRecord(openRecord.id, { status: 'Hoàn thành' });
    records = await service.getAllRecords();
    const completed = records.find((record) => record.id === openRecord.id)!;
    expect(isCompletedStatus(completed.status)).toBe(true);
    expect(getTatMonitoringBucket(completed, today)).toBeNull();
    expect(calculateTatDashboard(records, today)).toMatchObject({
      active: 1,
      buckets: { overdue: 0, 'one-day': 1 },
    });
    expect(sortRecordsByOperationalPriority(records, today).map((record) => record.id))
      .toEqual([rejectedRecord.id, openRecord.id]);

    await service.updateRecord(openRecord.id, { status: 'Rejected (xét)' });
    records = await service.getAllRecords();
    expect(getRejectedRecords(records, today).map((record) => record.id))
      .toEqual([openRecord.id, rejectedRecord.id]);
    expect(calculateTatDashboard(records, today)).toMatchObject({
      active: 2,
      buckets: { overdue: 1, 'one-day': 1 },
    });

    await service.updateRecord(openRecord.id, { dueDate: '2026-10-17' });
    records = await service.getAllRecords();
    const revised = records.find((record) => record.id === openRecord.id)!;
    expect(revised.dueDate).toBe('2026-10-17');
    expect(getTatDueDate(revised)).toBe('2026-10-17');
    expect(getTatDaysRemaining(revised, today)).toBe(5);
    expect(getTatMonitoringBucket(revised, today)).toBe('later');
    expect(calculateTatDashboard(records, today)).toMatchObject({
      active: 2,
      buckets: { overdue: 0, 'one-day': 1, later: 1 },
    });
    expect(getRejectedRecords(records, today).map((record) => record.id))
      .toEqual([rejectedRecord.id, openRecord.id]);
  });

  it('prevents an update from changing a record into another record identity', async () => {
    const service = makeService();
    const first = await service.addRecord({ mgmtNo: 'TNP-601', title: 'First defect' });
    const second = await service.addRecord({ mgmtNo: 'TNP-602', title: 'Second defect' });
    await expect(service.updateRecord(second.id, { mgmtNo: 'tnp-601' })).rejects.toBeInstanceOf(DuplicateRecordError);
    await expect(service.getRecord(second.id)).resolves.toMatchObject({ mgmtNo: 'TNP-602' });
    await expect(service.getRecord(first.id)).resolves.toMatchObject({ mgmtNo: 'TNP-601' });
  });
});

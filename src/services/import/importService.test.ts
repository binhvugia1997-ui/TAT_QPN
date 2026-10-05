import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getTatDaysRemaining, getTatDueDate, isTatOverdue, sortTatByPriority } from '../../business/tat/tat';
import type { DefectRecord } from '../../models/defect-record';
import { IndexedDbDatabase } from '../database/database';
import { RecordRepository } from '../database/recordRepository';
import { buildTnpSyncPatch, ImportService } from './importService';

let databaseNumber = 0;

const makeRepository = () => {
  const database = new IndexedDbDatabase({
    name: `tnp-import-sync-test-${++databaseNumber}`,
    factory: globalThis.indexedDB,
  });
  return { database, repository: new RecordRepository(database) };
};

const existingRecord = (overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id: 41,
  recordSource: 'legacy-seed',
  mgmtNo: 'TNP-REJECT-1',
  registeredDate: '2026-10-01',
  status: 'Đợi đối sách',
  dueDate: '2026-10-08',
  title: 'Original source title',
  pic: 'Local PIC',
  caFileLink: 'file:///local/ca-action.xlsx',
  notes: 'Local follow-up note',
  mqisCode: 'LOCAL-MQIS',
  completedDate: '2026-10-06',
  initialDueDate: '2026-10-07',
  initialCompletedDate: '2026-10-08',
  initialTatCompliance: 'Y',
  vendorApprovalDate: '2026-10-09',
  reason2: 'Local corrective detail',
  plmCountermeasure: 'Local countermeasure note',
  userCorrectiveInfo: 'Operator-entered containment information',
  sourceExtras: { 'Unknown TNP export column': 'Original extra value' },
  legacySourceExtension: 'Original extension value',
  ...overrides,
});

describe('TNP existing-record synchronization', () => {
  it('previews add/update counts without writing records or history', async () => {
    const { repository } = makeRepository();
    const current = existingRecord({ status: 'Đợi đối sách', dueDate: '2026-10-15' });
    await repository.addRecord(current);
    const importer = new ImportService(repository);

    const preview = await importer.previewCanonicalRows([
      { mgmtNo: current.mgmtNo, status: 'Rejected (xét)', dueDate: current.dueDate, registeredDate: '2026-10-09' },
      { mgmtNo: 'TNP-PREVIEW-NEW', status: 'Đợi đối sách', dueDate: '2026-10-20', registeredDate: '2026-10-01' },
    ], 'preview.xlsx');

    expect(preview).toEqual({ added: 1, updated: 1, unchanged: 0, total: 2 });
    expect((await repository.getAllRecords()).map((record) => record.id)).toEqual([current.id]);
    expect(await repository.getImportHistory()).toHaveLength(0);
  });

  it('inserts a full normalized canonical source row for a new record', async () => {
    const { repository } = makeRepository();
    const importer = new ImportService(repository);

    const result = await importer.importCanonicalRows([{
      mgmtNo: 'TNP-NEW-1',
      registeredDate: '2026-10-01',
      plant: 'SEV',
      status: 'Đợi đối sách',
      dueDate: '2026-10-17',
      title: 'New imported defect',
      defectQty: '2',
      tatDays: '6',
      sourceRemarks: 'TNP source remark',
      sourceExtras: Object.assign(Object.create(null) as Record<string, unknown>, {
        'Unknown TNP export column': 'preserved source value',
      }),
    }], { fileName: 'new-source-record.xlsx' });

    const [saved] = await repository.getAllRecords();
    expect(result).toMatchObject({ added: 1, updated: 0, unchanged: 0 });
    expect(saved).toMatchObject({
      recordSource: 'import',
      mgmtNo: 'TNP-NEW-1',
      registeredDate: '2026-10-01',
      status: 'Đợi đối sách',
      dueDate: '2026-10-17',
      title: 'New imported defect',
      defectQty: 2,
      tatDays: 6,
      sourceRemarks: 'TNP source remark',
      sourceExtras: { 'Unknown TNP export column': 'preserved source value' },
    });
  });

  it('builds an explicit status and effective-deadline patch only', () => {
    const current = existingRecord();
    const patch = buildTnpSyncPatch(current, {
      status: 'Rejected (xét)',
      registeredDate: '2026-10-02',
      dueDate: '2026-10-18',
      title: 'TNP title must not overwrite local/source detail',
      pic: 'Imported PIC must be ignored',
      notes: 'Imported remark must be ignored',
      caFileLink: 'file:///imported.xlsx',
      completedDate: '2026-10-07',
      initialDueDate: '2026-10-20',
      initialCompletedDate: '2026-10-21',
      initialTatCompliance: 'N',
      vendorApprovalDate: '2026-10-22',
      mqisCode: 'IMPORTED-MQIS',
      userCorrectiveInfo: 'Imported corrective information',
    });

    expect(patch).toEqual({
      status: 'Rejected (xét)',
      dueDate: '2026-10-18',
    });
  });

  it('updates Reject status and the effective TAT deadline while retaining the existing ID and PIC', async () => {
    const { repository } = makeRepository();
    const current = existingRecord();
    await repository.addRecord(current);
    const importer = new ImportService(repository);

    const result = await importer.importCanonicalRows([{
      mgmtNo: current.mgmtNo,
      status: 'Rejected (xét)',
      registeredDate: current.registeredDate,
      dueDate: '2026-10-15',
    }], { fileName: 'reject-update.xlsx', importedAt: '2026-10-12T08:00:00.000Z' });

    const saved = (await repository.getRecord(current.id))!;
    expect(result).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(saved).toMatchObject({
      id: current.id,
      status: 'Rejected (xét)',
      dueDate: '2026-10-15',
      pic: 'Local PIC',
    });
    expect(getTatDueDate(saved)).toBe('2026-10-15');
  });

  it('clears a blank imported dueDate and immediately uses registeredDate plus seven days', async () => {
    const { repository } = makeRepository();
    const current = existingRecord({
      status: 'Rejected (xét)',
      registeredDate: '2026-10-01',
      dueDate: '2026-10-20',
    });
    await repository.addRecord(current);
    const importer = new ImportService(repository);

    const result = await importer.importCanonicalRows([{
      mgmtNo: current.mgmtNo,
      registeredDate: '2026-10-09',
      dueDate: null,
      status: current.status,
    }], { fileName: 'blank-deadline.xlsx' });

    const saved = (await repository.getRecord(current.id))!;
    expect(result).toMatchObject({ updated: 1, unchanged: 0 });
    expect(saved.registeredDate).toBe('2026-10-01');
    expect(saved.dueDate).toBeNull();
    expect(getTatDueDate(saved)).toBe('2026-10-08');
  });

  it('counts a revised deadline as UPDATED when status remains Reject', async () => {
    const { repository } = makeRepository();
    const current = existingRecord({ status: 'Rejected (xét)', dueDate: '2026-10-15' });
    await repository.addRecord(current);
    const importer = new ImportService(repository);

    const result = await importer.importCanonicalRows([{
      mgmtNo: current.mgmtNo,
      dueDate: '2026-10-18',
    }], { fileName: 'revised-reject-deadline.xlsx' });

    const saved = (await repository.getRecord(current.id))!;
    expect(result).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(saved.id).toBe(current.id);
    expect(saved.status).toBe('Rejected (xét)');
    expect(saved.dueDate).toBe('2026-10-18');
    expect(getTatDueDate(saved)).toBe('2026-10-18');
  });

  it('immediately reorders and recalculates overdue/days remaining after a deadline-only import', async () => {
    const { repository } = makeRepository();
    const current = existingRecord({ status: 'Rejected (xét)', dueDate: '2026-10-10' });
    const other = existingRecord({
      id: 42,
      mgmtNo: 'TNP-REJECT-2',
      status: 'Đợi đối sách',
      dueDate: '2026-10-12',
    });
    await repository.addRecord(current);
    await repository.addRecord(other);
    const importer = new ImportService(repository);
    const today = '2026-10-12';

    expect(isTatOverdue(current, today)).toBe(true);
    expect(getTatDaysRemaining(current, today)).toBe(-2);
    expect(sortTatByPriority([other, current], today).map((item) => item.mgmtNo))
      .toEqual([current.mgmtNo, other.mgmtNo]);

    await importer.importCanonicalRows([{
      mgmtNo: current.mgmtNo,
      dueDate: '2026-10-17',
    }], { fileName: 'deadline-extension.xlsx' });

    const revised = (await repository.getRecord(current.id))!;
    expect(revised.dueDate).toBe('2026-10-17');
    expect(isTatOverdue(revised, today)).toBe(false);
    expect(getTatDaysRemaining(revised, today)).toBe(5);
    expect(sortTatByPriority([other, revised], today).map((item) => item.mgmtNo))
      .toEqual([other.mgmtNo, current.mgmtNo]);
  });

  it('counts a status-only change as UPDATED without changing the TAT deadline', async () => {
    const { repository } = makeRepository();
    const current = existingRecord({ status: 'Đợi đối sách', dueDate: '2026-10-15' });
    await repository.addRecord(current);
    const importer = new ImportService(repository);

    const result = await importer.importCanonicalRows([{
      mgmtNo: current.mgmtNo,
      status: 'Rejected (xét)',
    }], { fileName: 'status-only.xlsx' });

    const saved = (await repository.getRecord(current.id))!;
    expect(result).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(saved.status).toBe('Rejected (xét)');
    expect(saved.dueDate).toBe('2026-10-15');
  });

  it('ignores registeredDate-only changes on existing records and counts them as UNCHANGED', async () => {
    const { repository } = makeRepository();
    const current = existingRecord({ status: 'Rejected (xét)', dueDate: '2026-10-15' });
    await repository.addRecord(current);
    const importer = new ImportService(repository);

    const result = await importer.importCanonicalRows([{
      mgmtNo: current.mgmtNo,
      registeredDate: '2026-10-05',
      status: current.status,
      dueDate: current.dueDate,
    }], { fileName: 'historical-date-change.xlsx' });

    const saved = (await repository.getRecord(current.id))!;
    expect(result).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect(saved.registeredDate).toBe(current.registeredDate);
    expect(saved.status).toBe(current.status);
    expect(saved.dueDate).toBe(current.dueDate);
  });

  it('counts equal TNP fields as UNCHANGED even if an import row differs in app-managed fields', async () => {
    const { repository } = makeRepository();
    const current = existingRecord({ status: 'Rejected (xét)', dueDate: '2026-10-15' });
    await repository.addRecord(current);
    const importer = new ImportService(repository);

    const result = await importer.importCanonicalRows([{
      mgmtNo: current.mgmtNo,
      status: current.status,
      registeredDate: current.registeredDate,
      dueDate: current.dueDate,
      title: 'Unrelated imported title',
      pic: 'Different PIC',
      notes: 'Different note',
      caFileLink: 'file:///different.xlsx',
      userCorrectiveInfo: 'Different corrective information',
    }], { fileName: 'same-tnp-fields.xlsx' });

    const saved = (await repository.getRecord(current.id))!;
    expect(result).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect(saved).toMatchObject({
      title: current.title,
      pic: current.pic,
      notes: current.notes,
      caFileLink: current.caFileLink,
      userCorrectiveInfo: current.userCorrectiveInfo,
    });
  });

  it('preserves user-entered corrective and app-managed fields during a Reject update', async () => {
    const { repository } = makeRepository();
    const current = existingRecord();
    const originalNonSyncValues = Object.fromEntries(
      Object.entries(current).filter(([field]) => field !== 'status' && field !== 'dueDate'),
    );
    await repository.addRecord(current);
    const importer = new ImportService(repository);

    await importer.importCanonicalRows([{
      mgmtNo: current.mgmtNo,
      status: 'Rejected (xét)',
      registeredDate: '2026-10-09',
      dueDate: '2026-10-15',
      title: 'Imported title',
      pic: 'Imported PIC',
      caFileLink: 'file:///imported/ca-action.xlsx',
      notes: 'Imported remark',
      mqisCode: 'IMPORTED-MQIS',
      completedDate: '2026-10-07',
      initialDueDate: '2026-10-20',
      initialCompletedDate: '2026-10-21',
      initialTatCompliance: 'N',
      vendorApprovalDate: '2026-10-22',
      reason2: 'Imported corrective detail',
      plmCountermeasure: 'Imported countermeasure note',
      userCorrectiveInfo: 'Imported corrective information',
      sourceExtras: { 'Unknown TNP export column': 'Imported overwrite' },
      legacySourceExtension: 'Imported extension value',
    }], { fileName: 'protected-fields.xlsx' });

    const saved = (await repository.getRecord(current.id))!;
    expect(saved).toMatchObject({
      status: 'Rejected (xét)',
      dueDate: '2026-10-15',
      title: current.title,
      pic: current.pic,
      caFileLink: current.caFileLink,
      notes: current.notes,
      mqisCode: current.mqisCode,
      completedDate: current.completedDate,
      reason2: current.reason2,
      plmCountermeasure: current.plmCountermeasure,
      userCorrectiveInfo: current.userCorrectiveInfo,
    });
    for (const [field, value] of Object.entries(originalNonSyncValues)) {
      expect((saved as Record<string, unknown>)[field], `non-whitelisted field ${field} must be preserved`).toEqual(value);
    }
    expect(saved.id).toBe(current.id);
    expect(saved.registeredDate).toBe(current.registeredDate);
  });
});

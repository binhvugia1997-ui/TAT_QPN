import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DefectRecord } from '../../models/defect-record';
import { ImportService } from '../import/importService';
import { DestructiveConfirmationRequiredError, RecordService } from '../records/recordService';
import { IndexedDbDatabase } from './database';
import { RecordAlreadyExistsError, RecordRepository } from './recordRepository';

let databaseNumber = 0;
const makeRepository = (name = `tnp-test-${++databaseNumber}`) => {
  const database = new IndexedDbDatabase({ name, factory: globalThis.indexedDB });
  return { database, repository: new RecordRepository(database), name };
};

const record = (id: string | number, overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id,
  recordSource: 'manual',
  mgmtNo: `MANUAL-${String(id)}`,
  registeredDate: '2026-10-01',
  status: 'Đợi đối sách',
  title: 'Sample defect',
  ...overrides,
});

afterEach(() => {
  databaseNumber += 1;
});

describe('IndexedDB record repository', () => {
  it('adds a record and rejects an ID collision rather than overwriting', async () => {
    const { repository } = makeRepository();
    const first = record('manual-1');
    await repository.addRecord(first);
    await expect(repository.addRecord({ ...first, title: 'Changed' })).rejects.toBeInstanceOf(RecordAlreadyExistsError);
    expect((await repository.getRecord(first.id))?.title).toBe('Sample defect');
  });

  it('updates a record without changing its original id and reloads from another repository instance', async () => {
    const { database, repository, name } = makeRepository();
    const saved = record(21, { recordSource: 'legacy-seed' });
    await repository.addRecord(saved);
    const updated = { ...saved, notes: 'follow-up', recordSource: 'legacy-seed' as const };
    await repository.updateRecord(saved.id, updated);

    const reloaded = new RecordRepository(new IndexedDbDatabase({ name, factory: globalThis.indexedDB }));
    await expect(reloaded.getRecord(21)).resolves.toMatchObject({ id: 21, notes: 'follow-up' });
    await expect(repository.updateRecord(21, { ...updated, id: 'changed-id' } as unknown as DefectRecord)).rejects.toThrow(/identity/);
    await database.close();
  });

  it('bulk inserts in one transaction', async () => {
    const { repository } = makeRepository();
    await repository.bulkUpsert([
      { kind: 'insert', record: record('bulk-1') },
      { kind: 'insert', record: record('bulk-2') },
    ]);
    expect((await repository.getAllRecords()).map((item) => item.id)).toEqual(['bulk-1', 'bulk-2']);
  });

  it('rolls back record writes when the atomic import-history write fails', async () => {
    const { repository } = makeRepository();
    const history = {
      id: 'history-collision',
      importedAt: '2026-10-01T00:00:00.000Z',
      files: [{ fileName: 'first.xlsx', added: 0, updated: 0, unchanged: 0, total: 0 }],
      added: 0,
      updated: 0,
      unchanged: 0,
      total: 0,
    };
    await repository.commitImport([], history);

    await expect(repository.commitImport([
      { kind: 'insert', record: record('must-rollback') },
    ], history)).rejects.toThrow(/history-collision/);
    await expect(repository.getRecord('must-rollback')).resolves.toBeUndefined();
    await expect(repository.getImportHistory()).resolves.toHaveLength(1);
  });

  it('seeds only once and never overwrites an existing record with the same id', async () => {
    const { repository } = makeRepository();
    await repository.addRecord(record(1, { title: 'Existing user record' }));
    const seed = [record(1, { recordSource: 'legacy-seed', title: 'Seed title' }), record(2, { recordSource: 'legacy-seed' })];
    await expect(repository.initializeFromSeed(seed)).resolves.toEqual({
      seeded: 1,
      skippedExistingIds: 1,
      alreadyInitialized: false,
    });
    await expect(repository.getRecord(1)).resolves.toMatchObject({ title: 'Existing user record' });
    await expect(repository.initializeFromSeed(seed)).resolves.toMatchObject({ alreadyInitialized: true, seeded: 0 });
  });

  it('imports the same file twice without duplicate rows and persists audit history', async () => {
    const { repository } = makeRepository();
    const importer = new ImportService(repository);
    const first = await importer.importCanonicalRows([
      { mgmtNo: 'TNP-500', registeredDate: '2026-10-01', plant: 'SEV', title: 'Original title', status: 'Đợi đối sách' },
      { mgmtNo: '', registeredDate: '2026-10-02', plant: 'SEV', partCode: 'P-1', title: 'No management no', defectQty: 2 },
    ], { fileName: 'daily.csv', importedAt: '2026-10-02T09:00:00.000Z' });
    const initialRecords = await repository.getAllRecords();
    const firstManagementRecord = initialRecords.find((item) => item.mgmtNo === 'TNP-500')!;
    const firstFallbackRecord = initialRecords.find((item) => item.title === 'No management no')!;

    const second = await importer.importCanonicalRows([
      { mgmtNo: 'tnp-500', title: 'Latest title', status: 'Hoàn thành' },
      { mgmtNo: '', registeredDate: '2026-10-02', plant: 'SEV', partCode: 'P-1', title: 'No management no', defectQty: 2 },
    ], { fileName: 'daily.csv', importedAt: '2026-10-02T10:00:00.000Z' });

    const records = await repository.getAllRecords();
    expect(records).toHaveLength(2);
    expect(second).toMatchObject({ added: 0, updated: 1, unchanged: 1, total: 2 });
    expect(records.find((item) => item.id === firstManagementRecord.id)).toMatchObject({
      id: firstManagementRecord.id,
      mgmtNo: 'TNP-500',
      title: 'Original title',
      status: 'Hoàn thành',
    });
    expect(records.find((item) => item.id === firstFallbackRecord.id)).toBeDefined();
    expect(await repository.getImportHistory()).toHaveLength(2);
    expect(first.history.files[0].fileName).toBe('daily.csv');
  });

  it('reloads an imported record and its audit history from a fresh repository instance', async () => {
    const { repository, name } = makeRepository();
    const importer = new ImportService(repository);
    await importer.importCanonicalRows([{
      mgmtNo: 'RELOAD-1',
      status: 'Đợi đối sách',
      registeredDate: '2026-10-01',
      dueDate: '2026-10-18',
      title: 'Persisted import row',
    }], { fileName: 'reload.xlsx', importedAt: '2026-10-01T12:00:00.000Z' });

    const reloaded = new RecordRepository(new IndexedDbDatabase({ name, factory: globalThis.indexedDB }));
    await expect(reloaded.getAllRecords()).resolves.toHaveLength(1);
    await expect(reloaded.getAllRecords()).resolves.toMatchObject([
      { mgmtNo: 'RELOAD-1', dueDate: '2026-10-18', title: 'Persisted import row' },
    ]);
    await expect(reloaded.getImportHistory()).resolves.toMatchObject([
      { files: [{ fileName: 'reload.xlsx' }], added: 1, total: 1 },
    ]);
  });

  it('serializes concurrent imports through one service instance to avoid a duplicate identity', async () => {
    const { repository } = makeRepository();
    const importer = new ImportService(repository);
    const rows = [{ mgmtNo: 'TNP-CONCURRENT', registeredDate: '2026-10-02', plant: 'SEV', title: 'One defect' }];
    const [left, right] = await Promise.all([
      importer.importCanonicalRows(rows, { fileName: 'same.csv', importedAt: '2026-10-02T11:00:00.000Z' }),
      importer.importCanonicalRows(rows, { fileName: 'same.csv', importedAt: '2026-10-02T11:00:01.000Z' }),
    ]);

    expect([left.added, right.added].sort()).toEqual([0, 1]);
    expect(await repository.getAllRecords()).toHaveLength(1);
  });

  it('requires explicit confirmation before deleting or clearing data', async () => {
    const { repository } = makeRepository();
    const service = new RecordService(repository);
    await expect(service.deleteRecord('missing', { confirmed: false })).rejects.toBeInstanceOf(DestructiveConfirmationRequiredError);
    await expect(service.clearImportedData([], { confirmed: false })).rejects.toBeInstanceOf(DestructiveConfirmationRequiredError);
  });
});

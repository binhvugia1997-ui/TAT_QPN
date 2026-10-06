import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbDatabase } from '../../src/services/database/database';
import { RecordRepository } from '../../src/services/database/recordRepository';
import { RecordService } from '../../src/services/records/recordService';
import { ImportService, TNP_SYNC_FIELDS } from '../../src/services/import/importService';
import { readSeedRecords } from '../../server/context';
import { api, seedRow, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

let environment: TestEnvironment | undefined;
const openDatabases: IndexedDbDatabase[] = [];

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  await environment?.close();
  environment = undefined;
});

interface ImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  total: number;
}

async function importRows(
  env: TestEnvironment,
  rows: Record<string, unknown>[],
  fileName = 'tnp.xlsx',
): Promise<ImportSummary> {
  const { status, body } = await api<ImportSummary>(env.baseUrl, 'POST', '/api/import/commit', { rows, fileName });
  expect(status).toBe(200);
  return body;
}

describe('the locked import whitelist', () => {
  it('exposes exactly status and dueDate as the sync whitelist', () => {
    expect([...TNP_SYNC_FIELDS]).toEqual(['status', 'dueDate']);
  });

  it('synchronizes only status and dueDate on a matched record', async () => {
    environment = await startTestServer();
    const target = await api<{ record: Record<string, unknown> }>(environment.baseUrl, 'GET', '/api/records/1');
    const mgmtNo = target.body.record.mgmtNo as string;

    const summary = await importRows(environment, [
      {
        mgmtNo,
        status: 'Hoàn thành',
        dueDate: '2026-12-31',
        registeredDate: '2020-01-01',
        pic: 'IMPORT-OVERWRITE',
        notes: 'IMPORT-OVERWRITE',
        caFileLink: 'IMPORT-OVERWRITE',
        title: 'IMPORT-OVERWRITE',
        plant: 'IMPORT-OVERWRITE',
        partCode: 'IMPORT-OVERWRITE',
        defectQty: 9999,
        supplier: 'IMPORT-OVERWRITE',
        mqisCode: 'IMPORT-OVERWRITE',
        completedDate: '2020-01-01',
      },
    ]);

    expect(summary).toMatchObject({ added: 0, updated: 1, unchanged: 0, total: 1 });

    const after = await api<{ record: Record<string, unknown> }>(environment.baseUrl, 'GET', '/api/records/1');
    const record = after.body.record;
    const before = target.body.record;

    // Whitelisted fields changed.
    expect(record.status).toBe('Hoàn thành');
    expect(record.dueDate).toBe('2026-12-31');

    // Everything else is byte-for-byte the local value.
    for (const field of [
      'id',
      'mgmtNo',
      'registeredDate',
      'pic',
      'notes',
      'caFileLink',
      'title',
      'plant',
      'partCode',
      'defectQty',
      'supplier',
      'mqisCode',
      'completedDate',
      'recordSource',
    ]) {
      expect(record[field], field).toStrictEqual(before[field]);
    }
  });

  it('counts a record as UNCHANGED when only protected fields differ', async () => {
    environment = await startTestServer();
    const target = await api<{ record: Record<string, unknown> }>(environment.baseUrl, 'GET', '/api/records/1');
    const mgmtNo = target.body.record.mgmtNo as string;

    const summary = await importRows(environment, [
      {
        mgmtNo,
        status: target.body.record.status,
        dueDate: target.body.record.dueDate,
        pic: 'DIFFERENT',
        title: 'DIFFERENT',
        plant: 'DIFFERENT',
        registeredDate: '2020-01-01',
      },
    ]);

    expect(summary).toMatchObject({ added: 0, updated: 0, unchanged: 1, total: 1 });

    const after = await api<{ record: Record<string, unknown> }>(environment.baseUrl, 'GET', '/api/records/1');
    expect(after.body.record.pic).toStrictEqual(target.body.record.pic);
    expect(after.body.record.version).toBe(target.body.record.version);
  });

  it('never synchronizes registeredDate on a matched record', async () => {
    environment = await startTestServer();
    const target = await api<{ record: Record<string, unknown> }>(environment.baseUrl, 'GET', '/api/records/8');
    const mgmtNo = target.body.record.mgmtNo as string;

    await importRows(environment, [{ mgmtNo, status: 'Đợi xét', registeredDate: '1999-12-31' }]);

    const after = await api<{ record: Record<string, unknown> }>(environment.baseUrl, 'GET', '/api/records/8');
    expect(after.body.record.registeredDate).toBe(target.body.record.registeredDate);
    expect(after.body.record.registeredDate).not.toBe('1999-12-31');
    expect(after.body.record.status).toBe('Đợi xét');
  });

  it('allows reverse status transitions', async () => {
    environment = await startTestServer();
    const target = await api<{ record: Record<string, unknown> }>(environment.baseUrl, 'GET', '/api/records/9');
    const mgmtNo = target.body.record.mgmtNo as string;

    const forward = await importRows(environment, [{ mgmtNo, status: 'Hoàn thành' }]);
    expect(forward.updated).toBe(1);

    const reverse = await importRows(environment, [{ mgmtNo, status: 'Đợi đối sách' }]);
    expect(reverse.updated).toBe(1);

    const after = await api<{ record: Record<string, unknown> }>(environment.baseUrl, 'GET', '/api/records/9');
    expect(after.body.record.status).toBe('Đợi đối sách');
  });

  it('inserts a new record with the full source row including sourceExtras', async () => {
    environment = await startTestServer();
    const summary = await importRows(environment, [
      seedRow({
        mgmtNo: 'IMPORT-NEW-0001',
        supplier: 'Vendor X',
        reason1: 'Material',
        sourceExtras: { 'Unknown TNP column': 'kept verbatim', 'Another unknown': 42 },
      }),
    ]);

    expect(summary).toMatchObject({ added: 1, updated: 0, unchanged: 0, total: 1 });

    const records = await api<{ records: Record<string, unknown>[] }>(environment.baseUrl, 'GET', '/api/records');
    const inserted = records.body.records.find((record) => record.mgmtNo === 'IMPORT-NEW-0001');

    expect(inserted).toBeDefined();
    expect(inserted?.recordSource).toBe('import');
    expect(inserted?.supplier).toBe('Vendor X');
    expect(inserted?.reason1).toBe('Material');
    expect(inserted?.sourceExtras).toStrictEqual({ 'Unknown TNP column': 'kept verbatim', 'Another unknown': 42 });
  });

  it('preserves sourceExtras on a matched record', async () => {
    environment = await startTestServer();
    await importRows(environment, [
      seedRow({ mgmtNo: 'IMPORT-NEW-0002', sourceExtras: { 'Unknown TNP column': 'original' } }),
    ]);

    await importRows(environment, [
      { mgmtNo: 'IMPORT-NEW-0002', status: 'Hoàn thành', sourceExtras: { 'Unknown TNP column': 'CLOBBERED' } },
    ]);

    const records = await api<{ records: Record<string, unknown>[] }>(environment.baseUrl, 'GET', '/api/records');
    const matched = records.body.records.find((record) => record.mgmtNo === 'IMPORT-NEW-0002');

    expect(matched?.status).toBe('Hoàn thành');
    expect(matched?.sourceExtras).toStrictEqual({ 'Unknown TNP column': 'original' });
  });
});

describe('import transactions and side effects', () => {
  it('creates a pre-import backup before applying changes', async () => {
    environment = await startTestServer();
    const before = await api<{ backups: { kind: string }[] }>(environment.baseUrl, 'GET', '/api/backups');
    await importRows(environment, [seedRow({ mgmtNo: 'TX-0001' })]);
    const after = await api<{ backups: { kind: string; fileName: string }[] }>(environment.baseUrl, 'GET', '/api/backups');

    expect(after.body.backups.length).toBe(before.body.backups.length + 1);
    expect(after.body.backups[0].kind).toBe('pre-import');
    expect(after.body.backups[0].fileName).toContain('pre-import');
  });

  it('writes one import history entry and audit events for the batch', async () => {
    environment = await startTestServer();
    await importRows(environment, [seedRow({ mgmtNo: 'AUD-0001' }), seedRow({ mgmtNo: 'AUD-0002' })]);

    const history = await api<{ history: { added: number; total: number; id: string }[] }>(
      environment.baseUrl,
      'GET',
      '/api/import-history',
    );
    expect(history.body.history).toHaveLength(1);
    expect(history.body.history[0]).toMatchObject({ added: 2, total: 2 });

    const audit = await api<{ events: { operation: string; importBatchId: string | null }[] }>(
      environment.baseUrl,
      'GET',
      '/api/audit',
    );
    const commit = audit.body.events.find((event) => event.operation === 'import.commit');
    expect(commit).toBeDefined();

    const creates = audit.body.events.filter((event) => event.operation === 'record.create');
    expect(creates).toHaveLength(2);
    for (const event of creates) {
      expect(event.importBatchId).toBe(commit?.importBatchId);
    }
  });

  it('rolls the whole import back when a row cannot be normalized', async () => {
    environment = await startTestServer();
    const before = await api<{ records: unknown[] }>(environment.baseUrl, 'GET', '/api/records');
    const historyBefore = await api<{ history: unknown[] }>(environment.baseUrl, 'GET', '/api/import-history');

    const { status } = await api(environment.baseUrl, 'POST', '/api/import/commit', {
      fileName: 'broken.xlsx',
      rows: [
        seedRow({ mgmtNo: 'ROLLBACK-OK' }),
        // An invalid numeric value makes normalization throw after the first row was planned.
        seedRow({ mgmtNo: 'ROLLBACK-BAD', sampleQty: 'not-a-number' }),
      ],
    });

    // An invalid numeric value is a client data problem, and nothing is written.
    expect(status).toBe(400);

    const after = await api<{ records: Record<string, unknown>[] }>(environment.baseUrl, 'GET', '/api/records');
    const historyAfter = await api<{ history: unknown[] }>(environment.baseUrl, 'GET', '/api/import-history');

    expect(after.body.records).toHaveLength(before.body.records.length);
    expect(after.body.records.some((record) => record.mgmtNo === 'ROLLBACK-OK')).toBe(false);
    expect(historyAfter.body.history).toHaveLength(historyBefore.body.history.length);
  });

  it('produces the same result as the approved browser-side import service', async () => {
    environment = await startTestServer();

    // Build the equivalent browser-side stack over an isolated IndexedDB.
    const database = new IndexedDbDatabase({ name: `parity-${Date.now()}` });
    openDatabases.push(database);
    const repository = new RecordRepository(database);
    const recordService = new RecordService(repository);
    const importService = new ImportService(repository);
    await recordService.seedLegacyBase(readSeedRecords(environment.paths.seedFile).map((record) => ({ ...record })));

    const rows = [
      { mgmtNo: '260702006-VOC', status: 'Hoàn thành', dueDate: '2026-11-11', pic: 'NOPE', title: 'NOPE' },
      { mgmtNo: 'BRAND-NEW-0001', registeredDate: '2026-09-01', plant: 'SIEL', title: 'Brand new', defectQty: 4, status: 'Đợi đối sách' },
      { mgmtNo: 'BRAND-NEW-0001', registeredDate: '2026-09-01', plant: 'SIEL', title: 'Brand new', defectQty: 4, status: 'Hoàn thành' },
    ];

    const browserResult = await importService.importCanonicalRows(rows, { fileName: 'parity.xlsx' });
    const serverResult = await importRows(environment, rows, 'parity.xlsx');

    expect(serverResult.added).toBe(browserResult.added);
    expect(serverResult.updated).toBe(browserResult.updated);
    expect(serverResult.unchanged).toBe(browserResult.unchanged);
    expect(serverResult.total).toBe(browserResult.total);

    // The matched seed record ends up identical in both stores.
    const browserRecord = (await recordService.getAllRecords()).find((record) => record.mgmtNo === '260702006-VOC');
    const serverRecord = (
      await api<{ records: Record<string, unknown>[] }>(environment.baseUrl, 'GET', '/api/records')
    ).body.records.find((record) => record.mgmtNo === '260702006-VOC');

    expect(serverRecord?.status).toBe(browserRecord?.status);
    expect(serverRecord?.dueDate).toBe(browserRecord?.dueDate);
    expect(serverRecord?.pic).toBe(browserRecord?.pic);
    expect(serverRecord?.title).toBe(browserRecord?.title);
  });
});

describe('import request validation', () => {
  it('rejects a non-array row list', async () => {
    environment = await startTestServer();
    const { status, body } = await api<{ error: string }>(environment.baseUrl, 'POST', '/api/import/commit', {
      fileName: 'bad.xlsx',
      rows: { not: 'an array' },
    });

    expect(status).toBe(400);
    expect(body.error).toBe('validation-failed');
  });

  it('rejects an import without a file name', async () => {
    environment = await startTestServer();
    const { status } = await api(environment.baseUrl, 'POST', '/api/import/commit', { rows: [] });
    expect(status).toBe(400);
  });

  it('previews without writing anything', async () => {
    environment = await startTestServer();
    const before = await api<{ records: unknown[] }>(environment.baseUrl, 'GET', '/api/records');
    const preview = await api<ImportSummary>(environment.baseUrl, 'POST', '/api/import/preview', {
      fileName: 'preview.xlsx',
      rows: [seedRow({ mgmtNo: 'PREVIEW-0001' }), seedRow({ mgmtNo: 'PREVIEW-0002' })],
    });
    const after = await api<{ records: unknown[] }>(environment.baseUrl, 'GET', '/api/records');

    expect(preview.body).toMatchObject({ added: 2, updated: 0, unchanged: 0, total: 2 });
    expect(after.body.records).toHaveLength(before.body.records.length);
  });
});

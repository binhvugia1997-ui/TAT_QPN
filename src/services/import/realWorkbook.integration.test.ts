import 'fake-indexeddb/auto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecordFingerprint } from '../../business/duplicate/identity';
import type { DefectRecord } from '../../models/defect-record';
import { IndexedDbDatabase } from '../database/database';
import { RecordRepository } from '../database/recordRepository';
import { RecordService } from '../records/recordService';
import { ImportService } from './importService';
import { parseTnpFile } from './tnpFileParser';
import seedData from '../../data/legacy-base-data.json';

const workbookName = 'EXCEL_EXPORT_FILE_20261002181424.xlsx';
const workbookPath = resolve(process.cwd(), workbookName);
const realWorkbookTest = existsSync(workbookPath) ? it : it.skip;
let databaseNumber = 0;
const openDatabases: IndexedDbDatabase[] = [];

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('real TNP workbook acceptance flow', () => {
  afterEach(async () => {
    await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  });

  realWorkbookTest('parses the known workbook, imports against the seed, and is idempotent without overwriting app-managed fields', async () => {
    expect(seedData).toHaveLength(191);
    expect(new Set((seedData as unknown as Record<string, unknown>[]).flatMap((record) => Object.keys(record))).size).toBe(34);

    const bytes = await readFile(workbookPath);
    const parsed = await parseTnpFile({
      name: workbookName,
      size: bytes.byteLength,
      arrayBuffer: async () => arrayBuffer(bytes),
    });

    expect(parsed.sheetCount).toBe(1);
    expect(parsed.rowsScanned).toBe(110);
    expect(parsed.invalidRows).toBe(0);
    expect(parsed.rows).toHaveLength(110);
    expect(parsed.recognizedHeaders).toHaveLength(50);
    expect(parsed.unknownHeaders).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.canImport).toBe(true);
    expect(parsed.rows.every(({ record }) => Boolean(String(record.status ?? '').trim()))).toBe(true);
    expect(parsed.rows.every(({ record }) => Boolean(String(record.dueDate ?? '').trim()))).toBe(true);

    const identities = parsed.rows.map(({ record }) => getRecordFingerprint(record));
    expect(new Set(identities).size).toBe(110);

    const database = new IndexedDbDatabase({
      name: `tnp-real-workbook-acceptance-${++databaseNumber}`,
      factory: globalThis.indexedDB,
    });
    openDatabases.push(database);
    const repository = new RecordRepository(database);
    const records = new RecordService(repository);
    const importer = new ImportService(repository);

    await records.seedLegacyBase(seedData as unknown as Record<string, unknown>[]);
    const seededCount = (await repository.getAllRecords()).length;
    expect(seededCount).toBe(191);

    const rows = parsed.rows.map(({ record }) => record as Record<string, unknown>);
    const preview = await importer.previewCanonicalRows(rows, workbookName);
    expect(preview.total).toBe(110);
    expect(preview.added + preview.updated + preview.unchanged).toBe(110);
    expect(await repository.getImportHistory()).toHaveLength(0);

    const firstImport = await importer.importCanonicalRows(rows, {
      fileName: workbookName,
      importedAt: '2026-10-05T01:00:00.000Z',
    });
    expect(firstImport).toMatchObject({ added: 110, updated: 0, unchanged: 0, total: 110 });
    expect((await repository.getAllRecords()).length).toBe(seededCount + firstImport.added);
    expect(await repository.getImportHistory()).toHaveLength(1);

    const firstSourceRow = parsed.rows[0].record;
    const savedRecord = (await repository.getAllRecords()).find((record) => record.mgmtNo === firstSourceRow.mgmtNo);
    expect(savedRecord).toBeDefined();
    const originalId = savedRecord!.id;
    const originalRegisteredDate = savedRecord!.registeredDate;

    await records.updateRecord(originalId, {
      pic: 'Phase 4 acceptance PIC',
      notes: 'Acceptance note must survive TNP synchronization.',
      caFileLink: 'file:///acceptance/corrective-action.xlsx',
    });

    const secondImport = await importer.importCanonicalRows(rows, {
      fileName: workbookName,
      importedAt: '2026-10-05T02:00:00.000Z',
    });
    expect(secondImport).toMatchObject({ added: 0, updated: 0, unchanged: 110, total: 110 });
    expect((await repository.getAllRecords()).length).toBe(seededCount + firstImport.added);
    expect(await repository.getImportHistory()).toHaveLength(2);

    const reloaded = await records.getRecord(originalId) as DefectRecord;
    expect(reloaded).toMatchObject({
      id: originalId,
      registeredDate: originalRegisteredDate,
      pic: 'Phase 4 acceptance PIC',
      notes: 'Acceptance note must survive TNP synchronization.',
      caFileLink: 'file:///acceptance/corrective-action.xlsx',
    });
    expect(reloaded.recordSource).toBe(savedRecord!.recordSource);
  });
});

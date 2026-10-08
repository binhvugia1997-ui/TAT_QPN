import { afterEach, describe, expect, it } from 'vitest';
import { api, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

/**
 * What happens to a record's identity when its Management Number changes.
 *
 * `mgmtNo` is not a label: `getRecordFingerprint` makes it the key the import matches on. These
 * tests pin the two guarantees the app already has, and pin the one it does not have — which is
 * exactly why the detail drawer shows the number read-only instead of offering an input for it.
 * The import rules themselves are untouched by this change and are not what these tests negotiate.
 */

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

interface StoredRecord {
  id: number | string;
  mgmtNo: string;
  status: string;
  notes: string | null;
  recordSource: string;
  version: number;
}

interface ImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  total: number;
}

async function readRecord(id: number | string): Promise<StoredRecord> {
  const { status, body } = await api<{ record: StoredRecord }>(environment!.baseUrl, 'GET', `/api/records/${String(id)}`);
  expect(status).toBe(200);
  return body.record;
}

async function patchRecord(
  id: number | string,
  patch: Record<string, unknown>,
  expectedVersion: number,
): Promise<{ status: number; body: unknown }> {
  const { status, body } = await api<{ record?: StoredRecord; message?: string }>(
    environment!.baseUrl,
    'PATCH',
    `/api/records/${String(id)}`,
    { patch, expectedVersion },
  );
  return { status, body };
}

async function importRows(rows: Record<string, unknown>[]): Promise<ImportSummary> {
  const { status, body } = await api<ImportSummary>(environment!.baseUrl, 'POST', '/api/import/commit', {
    rows,
    fileName: 'identity.xlsx',
  });
  expect(status).toBe(200);
  return body;
}

describe('the management number as an identity key', () => {
  it('refuses to move a record onto a number another record already holds', async () => {
    environment = await startTestServer();
    const first = await readRecord(1);
    const second = await readRecord(2);
    expect(second.mgmtNo).not.toBe(first.mgmtNo);

    const attempt = await patchRecord(1, { mgmtNo: second.mgmtNo }, first.version);

    // 409 rather than two records sharing one identity.
    expect(attempt.status).toBe(409);
    expect(JSON.stringify(attempt.body)).toContain('duplicate');

    expect((await readRecord(1)).mgmtNo).toBe(first.mgmtNo);
  });

  it('keeps the internal id and the provenance when the number itself changes', async () => {
    environment = await startTestServer();
    const before = await readRecord(3);

    const result = await patchRecord(3, { mgmtNo: 'RENAMED-0003' }, before.version);
    expect(result.status).toBe(200);

    const after = await readRecord(3);
    // The internal id is the storage key and never follows the number.
    expect(after.id).toBe(before.id);
    expect(after.mgmtNo).toBe('RENAMED-0003');
    expect(after.version).toBe(before.version + 1);
    expect(after.recordSource).toBe(before.recordSource);
  });

  it('orphan a renamed record from its own import row, which is the hazard the drawer locks against', async () => {
    environment = await startTestServer();
    const target = await readRecord(4);
    const originalNumber = target.mgmtNo;

    const correction = await patchRecord(4, { notes: 'verified on line 3' }, target.version);
    expect(correction.status).toBe(200);

    // Rename to a number nobody holds, so the duplicate check has nothing to object to.
    const renamed = await patchRecord(4, { mgmtNo: 'RENAMED-0004' }, (await readRecord(4)).version);
    expect(renamed.status).toBe(200);

    // The source system still publishes the original number. Matching is by that number, so the row
    // no longer finds the record it came from and is inserted as a second record.
    const summary = await importRows([{ mgmtNo: originalNumber, status: 'Hoàn thành', notes: 'from import' }]);
    expect(summary).toMatchObject({ added: 1, updated: 0, total: 1 });

    // The correction stays on the renamed record, stranded away from the imported one. Nothing was
    // lost, but the record count grew by a phantom. This is what the read-only field pays to avoid;
    // the app cannot currently detect or repair it, so the UI must not offer the edit.
    const stillRenamed = await readRecord(4);
    expect(stillRenamed.notes).toBe('verified on line 3');
    // Its status is untouched by the import, because the import never found it.
    expect(stillRenamed.status).toBe(target.status);
  });

  it('updates in place, with no insert, while the number is left alone', async () => {
    environment = await startTestServer();
    const target = await readRecord(5);

    const summary = await importRows([{ mgmtNo: target.mgmtNo, status: 'Hoàn thành' }]);

    expect(summary).toMatchObject({ added: 0, updated: 1, total: 1 });
    const after = await readRecord(5);
    expect(after.status).toBe('Hoàn thành');
    expect(after.mgmtNo).toBe(target.mgmtNo);
  });

  it('still matches on the legacy composite fingerprint when the number is blank', async () => {
    environment = await startTestServer();
    const rows = [{
      mgmtNo: '',
      registeredDate: '2020-01-02',
      plant: 'SIEL',
      partCode: 'PART-9',
      title: 'Composite identity defect',
      defectQty: 3,
      status: 'Đợi đối sách',
    }];

    expect((await importRows(rows)).added).toBe(1);

    // No number means the composite key takes over, and that key is stable, so no duplicate.
    expect(await importRows(rows)).toMatchObject({ added: 0, unchanged: 1, total: 1 });
  });
});

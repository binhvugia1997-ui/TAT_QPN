import { afterEach, describe, expect, it } from 'vitest';
import { api, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

/**
 * The manual "Tên lỗi" value is edited inline in the Records table and must behave like any
 * other app-managed field: it goes through the ordinary record update route, so it inherits
 * that route's optimistic-concurrency check and its audit trail, and it survives a later
 * Excel import because the import whitelist cannot reach it.
 */

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

interface RecordPayload {
  id: number | string;
  mgmtNo: string;
  status: string;
  dueDate: string | null;
  defectDetails: string | null;
  manualDefectName: string | null;
  version: number;
}

interface AuditEvent {
  operation: string;
  changes: { field: string; oldValue: unknown; newValue: unknown }[];
}

interface ImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  total: number;
}

async function getRecord(env: TestEnvironment, id: number): Promise<RecordPayload> {
  const { status, body } = await api<{ record: RecordPayload }>(env.baseUrl, 'GET', `/api/records/${id}`);
  expect(status).toBe(200);
  return body.record;
}

describe('the inline manual defect name', () => {
  it('starts blank on a record that already carries imported defect details', async () => {
    environment = await startTestServer();
    const record = await getRecord(environment, 7);

    // Non-vacuous: this record really does carry an imported source value...
    expect(record.defectDetails).toBe('Loang');
    // ...and the manual field is simply absent — the API omits a key that was never set,
    // rather than inventing a value — so the column renders blank instead of falling back.
    expect(record.manualDefectName).toBeUndefined();
    expect(record.version).toBe(1);
  });

  it('saves through the ordinary update route without touching the imported value', async () => {
    environment = await startTestServer();
    const before = await getRecord(environment, 7);

    const { status, body } = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/7', {
      patch: { manualDefectName: 'Bracket cracked at the weld' },
      expectedVersion: before.version,
    });

    expect(status).toBe(200);
    expect(body.record.manualDefectName).toBe('Bracket cracked at the weld');
    expect(body.record.defectDetails).toBe(before.defectDetails);
    expect(body.record.version).toBe(before.version + 1);

    // Re-reading proves the write reached SQLite rather than a client-side cache.
    expect((await getRecord(environment, 7)).manualDefectName).toBe('Bracket cracked at the weld');
  });

  it('records the edit in the audit trail under the manual field name', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/8', {
      patch: { manualDefectName: 'Paint peel on the flange' },
      expectedVersion: 1,
    });

    const { body } = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/records/8/history');

    expect(body.events).toHaveLength(1);
    expect(body.events[0].operation).toBe('record.update');
    expect(body.events[0].changes).toEqual([
      { field: 'manualDefectName', oldValue: null, newValue: 'Paint peel on the flange' },
    ]);
  });

  it('rejects a stale revision, so two operators cannot silently overwrite each other', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/9', {
      patch: { manualDefectName: 'First operator' },
      expectedVersion: 1,
    });

    // The second operator still holds revision 1.
    const stale = await api(environment.baseUrl, 'PATCH', '/api/records/9', {
      patch: { manualDefectName: 'Second operator' },
      expectedVersion: 1,
    });

    expect(stale.status).toBe(409);
    expect((await getRecord(environment, 9)).manualDefectName).toBe('First operator');
  });

  it('survives a later Excel import of the same record', async () => {
    environment = await startTestServer();
    const before = await getRecord(environment, 7);
    await api(environment.baseUrl, 'PATCH', '/api/records/7', {
      patch: { manualDefectName: 'Typed by the operator' },
      expectedVersion: before.version,
    });

    const { status, body } = await api<ImportSummary>(environment.baseUrl, 'POST', '/api/import/commit', {
      rows: [{
        mgmtNo: before.mgmtNo,
        status: 'Hoàn thành',
        dueDate: '2026-12-31',
        // Neither of these may reach the record.
        manualDefectName: 'IMPORT-OVERWRITE',
        defectDetails: 'IMPORT-OVERWRITE',
      }],
      fileName: 'tnp.xlsx',
    });

    expect(status).toBe(200);
    expect(body.updated).toBe(1);

    const after = await getRecord(environment, 7);
    expect(after.manualDefectName).toBe('Typed by the operator');
    expect(after.defectDetails).not.toBe('IMPORT-OVERWRITE');
    // The whitelisted fields still synchronize normally.
    expect(after.status).toBe('Hoàn thành');
    expect(after.dueDate).toBe('2026-12-31');
  });
});

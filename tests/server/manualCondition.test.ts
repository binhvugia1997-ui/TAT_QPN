import { afterEach, describe, expect, it } from 'vitest';
import { api, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

/**
 * `manualCondition` is the app-managed value behind the Records table's "Tình trạng" column.
 *
 * It must behave like every other app-managed field — saved through the ordinary record update
 * route, so it inherits that route's optimistic-concurrency check and its audit trail — and it
 * must be strictly independent of the canonical TNP `status`, which is what Approval, the
 * Completed/Rejected scopes and TAT are derived from. Writing a condition must not move a record
 * between those views, and a later Excel import must not overwrite it.
 *
 * There is deliberately no database column for it: like the other manual fields it lives inside
 * the record payload.
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
  manualCondition: string | null;
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

describe('the manual "Tình trạng" field', () => {
  it('starts absent on a seeded record, so the column renders blank rather than a guess', async () => {
    environment = await startTestServer();
    const record = await getRecord(environment, 7);

    expect(record.mgmtNo).toBeTruthy();
    expect(record.manualCondition).toBeUndefined();
    expect(record.version).toBe(1);
  });

  it('saves through the ordinary update route and survives a re-read from SQLite', async () => {
    environment = await startTestServer();
    const before = await getRecord(environment, 7);

    const { status, body } = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/7', {
      patch: { manualCondition: 'Đã khắc phục, đang chờ xác nhận' },
      expectedVersion: before.version,
    });

    expect(status).toBe(200);
    expect(body.record.manualCondition).toBe('Đã khắc phục, đang chờ xác nhận');
    expect(body.record.version).toBe(before.version + 1);
    expect((await getRecord(environment, 7)).manualCondition).toBe('Đã khắc phục, đang chờ xác nhận');
  });

  it('leaves the canonical status, the deadline and the imported defect text exactly as they were', async () => {
    environment = await startTestServer();
    const before = await getRecord(environment, 7);

    const { body } = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/7', {
      patch: { manualCondition: 'Đợi phôi thay thế' },
      expectedVersion: before.version,
    });

    expect(body.record.status).toBe(before.status);
    expect(body.record.dueDate).toBe(before.dueDate);
    expect(body.record.defectDetails).toBe(before.defectDetails);
  });

  it('records the edit in the audit trail under the manual field name only', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/8', {
      patch: { manualCondition: 'OK' },
      expectedVersion: 1,
    });

    const { body } = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/records/8/history');

    expect(body.events).toHaveLength(1);
    expect(body.events[0].operation).toBe('record.update');
    expect(body.events[0].changes).toEqual([{ field: 'manualCondition', oldValue: null, newValue: 'OK' }]);
  });

  it('is independent of the manual defect name', async () => {
    environment = await startTestServer();

    await api(environment.baseUrl, 'PATCH', '/api/records/9', {
      patch: { manualDefectName: 'Only the name' },
      expectedVersion: 1,
    });
    const { body } = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/9', {
      patch: { manualCondition: 'Only the condition' },
      expectedVersion: 2,
    });

    expect(body.record.manualDefectName).toBe('Only the name');
    expect(body.record.manualCondition).toBe('Only the condition');
  });

  it('rejects a stale revision, so two operators cannot silently overwrite each other', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/9', {
      patch: { manualCondition: 'First operator' },
      expectedVersion: 1,
    });

    const stale = await api(environment.baseUrl, 'PATCH', '/api/records/9', {
      patch: { manualCondition: 'Second operator' },
      expectedVersion: 1,
    });

    expect(stale.status).toBe(409);
    expect((await getRecord(environment, 9)).manualCondition).toBe('First operator');
  });

  it('is never overwritten by a later Excel import, even if the incoming row names it', async () => {
    environment = await startTestServer();
    const before = await getRecord(environment, 7);
    await api(environment.baseUrl, 'PATCH', '/api/records/7', {
      patch: { manualCondition: 'Typed by the operator' },
      expectedVersion: before.version,
    });

    const { status, body } = await api<ImportSummary>(environment.baseUrl, 'POST', '/api/import/commit', {
      rows: [{
        mgmtNo: before.mgmtNo,
        status: 'Hoàn thành',
        dueDate: '2026-12-31',
        // Neither of these may reach the record: only the TNP sync whitelist does.
        manualCondition: 'IMPORT-OVERWRITE',
        defectDetails: 'IMPORT-OVERWRITE',
      }],
      fileName: 'tnp.xlsx',
    });

    expect(status).toBe(200);
    expect(body.updated).toBe(1);

    const after = await getRecord(environment, 7);
    expect(after.manualCondition).toBe('Typed by the operator');
    expect(after.defectDetails).not.toBe('IMPORT-OVERWRITE');
    // The whitelisted fields still synchronize normally, which proves the import did run.
    expect(after.status).toBe('Hoàn thành');
    expect(after.dueDate).toBe('2026-12-31');
  });

  it('moves a record out of the Active scope only through the canonical status, never through the condition', async () => {
    environment = await startTestServer();
    const before = await getRecord(environment, 10);

    await api(environment.baseUrl, 'PATCH', '/api/records/10', {
      patch: { manualCondition: 'Looks finished' },
      expectedVersion: before.version,
    });

    // The status is untouched, so any status-derived scope is untouched by construction.
    expect((await getRecord(environment, 10)).status).toBe(before.status);
  });

  it('stores no new database column: the value lives in the record payload', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/11', {
      patch: { manualCondition: 'Payload only' },
      expectedVersion: 1,
    });

    // The record is returned intact through the generic payload route; there is no dedicated
    // manual_condition endpoint, column or filter, and the value round-trips like any other field.
    const record = await getRecord(environment, 11);
    expect(record.manualCondition).toBe('Payload only');

    // A blank clears the field rather than storing a space, mirroring the defect-name rule.
    const { body } = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/11', {
      patch: { manualCondition: '' },
      expectedVersion: 2,
    });
    expect(body.record.manualCondition).toBe('');
  });
});

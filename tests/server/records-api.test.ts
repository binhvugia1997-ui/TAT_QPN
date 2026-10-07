import { afterEach, describe, expect, it } from 'vitest';
import { getTatDueDate, isTatOverdue, LEGACY_TAT_WINDOW_DAYS } from '../../src/business/tat/tat';
import { addCalendarDays, todayDateOnly } from '../../src/utils/date';
import { api, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

interface RecordPayload {
  id: number | string;
  mgmtNo: string;
  status: string;
  pic: string | null;
  notes: string | null;
  caFileLink: string | null;
  registeredDate: string | null;
  dueDate: string | null;
  completedDate: string | null;
  version: number;
  recordSource: string;
}

describe('record CRUD through the server API', () => {
  it('lists every record with a revision number', async () => {
    environment = await startTestServer();
    const { status, body } = await api<{ records: RecordPayload[] }>(environment.baseUrl, 'GET', '/api/records');

    expect(status).toBe(200);
    expect(body.records).toHaveLength(191);
    expect(body.records.every((record) => typeof record.version === 'number')).toBe(true);
  });

  it('reads a single record by numeric id', async () => {
    environment = await startTestServer();
    const { status, body } = await api<{ record: RecordPayload }>(environment.baseUrl, 'GET', '/api/records/7');

    expect(status).toBe(200);
    expect(body.record.id).toBe(7);
    expect(body.record.version).toBe(1);
  });

  it('creates a manual record and rejects a duplicate identity', async () => {
    environment = await startTestServer();
    const created = await api<{ record: RecordPayload }>(environment.baseUrl, 'POST', '/api/records', {
      record: { mgmtNo: 'NEW-0001', title: 'New defect', plant: 'SIEL', status: 'Đợi đối sách', registeredDate: '2026-08-01' },
    });

    expect(created.status).toBe(201);
    expect(created.body.record.recordSource).toBe('manual');
    expect(created.body.record.version).toBe(1);
    expect(typeof created.body.record.id).toBe('string');

    const duplicate = await api(environment.baseUrl, 'POST', '/api/records', {
      record: { mgmtNo: 'NEW-0001', title: 'Same management number', plant: 'SIEL' },
    });
    expect(duplicate.status).toBe(409);
  });

  it('updates only the submitted fields and bumps the revision', async () => {
    environment = await startTestServer();
    const before = await api<{ record: RecordPayload }>(environment.baseUrl, 'GET', '/api/records/3');
    const { status, body } = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/3', {
      patch: { pic: 'Nguyen Van A', notes: 'Follow up with vendor' },
      expectedVersion: before.body.record.version,
    });

    expect(status).toBe(200);
    expect(body.record.pic).toBe('Nguyen Van A');
    expect(body.record.notes).toBe('Follow up with vendor');
    expect(body.record.title).toBe(before.body.record.title);
    expect(body.record.version).toBe(before.body.record.version + 1);
  });

  it('refuses to change record identity or provenance', async () => {
    environment = await startTestServer();
    const changedId = await api(environment.baseUrl, 'PATCH', '/api/records/4', {
      patch: { id: 999 },
      expectedVersion: 1,
    });
    expect(changedId.status).toBe(400);

    const changedSource = await api(environment.baseUrl, 'PATCH', '/api/records/4', {
      patch: { recordSource: 'import' },
      expectedVersion: 1,
    });
    expect(changedSource.status).toBe(400);
  });

  it('returns 404 for a record that does not exist', async () => {
    environment = await startTestServer();
    const { status } = await api(environment.baseUrl, 'GET', '/api/records/999999');
    expect(status).toBe(404);
  });

  it('deletes a record and records the deletion', async () => {
    environment = await startTestServer();
    const created = await api<{ record: RecordPayload }>(environment.baseUrl, 'POST', '/api/records', {
      record: { mgmtNo: 'DEL-0001', title: 'To delete', plant: 'SIEL' },
    });
    const id = created.body.record.id;

    const removed = await api(environment.baseUrl, 'DELETE', `/api/records/${encodeURIComponent(`string:${id}`)}`);
    expect(removed.status).toBe(200);

    const after = await api(environment.baseUrl, 'GET', `/api/records/${encodeURIComponent(`string:${id}`)}`);
    expect(after.status).toBe(404);

    const history = await api<{ events: { operation: string }[] }>(
      environment.baseUrl,
      'GET',
      `/api/records/${encodeURIComponent(`string:${id}`)}/history`,
    );
    expect(history.body.events.map((event) => event.operation)).toContain('record.delete');
  });
});

describe('optimistic concurrency', () => {
  it('returns HTTP 409 when a stale revision is submitted', async () => {
    environment = await startTestServer();

    // Both clients read revision 1.
    const readerA = await api<{ record: RecordPayload }>(environment.baseUrl, 'GET', '/api/records/10');
    const readerB = await api<{ record: RecordPayload }>(environment.baseUrl, 'GET', '/api/records/10');
    expect(readerA.body.record.version).toBe(readerB.body.record.version);

    // Client B saves first and succeeds.
    const saveB = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/10', {
      patch: { pic: 'Client B' },
      expectedVersion: readerB.body.record.version,
    });
    expect(saveB.status).toBe(200);
    expect(saveB.body.record.version).toBe(readerB.body.record.version + 1);

    // Client A now submits the same stale revision and must be refused.
    const saveA = await api<{
      error: string;
      expectedVersion: number;
      currentVersion: number;
    }>(environment.baseUrl, 'PATCH', '/api/records/10', {
      patch: { pic: 'Client A' },
      expectedVersion: readerA.body.record.version,
    });

    expect(saveA.status).toBe(409);
    expect(saveA.body.error).toBe('conflict');
    expect(saveA.body.expectedVersion).toBe(readerA.body.record.version);
    expect(saveA.body.currentVersion).toBe(saveB.body.record.version);

    // The first save was not silently overwritten.
    const current = await api<{ record: RecordPayload }>(environment.baseUrl, 'GET', '/api/records/10');
    expect(current.body.record.pic).toBe('Client B');
  });

  it('requires an expected revision on every update', async () => {
    environment = await startTestServer();
    const { status, body } = await api<{ error: string }>(environment.baseUrl, 'PATCH', '/api/records/11', {
      patch: { pic: 'No version' },
    });

    expect(status).toBe(400);
    expect(body.error).toBe('validation-failed');
  });

  it('allows a retry once the client has refetched the current revision', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/12', { patch: { pic: 'First' }, expectedVersion: 1 });
    const stale = await api(environment.baseUrl, 'PATCH', '/api/records/12', { patch: { pic: 'Stale' }, expectedVersion: 1 });
    expect(stale.status).toBe(409);

    const refreshed = await api<{ record: RecordPayload }>(environment.baseUrl, 'GET', '/api/records/12');
    const retry = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/12', {
      patch: { pic: 'After review' },
      expectedVersion: refreshed.body.record.version,
    });

    expect(retry.status).toBe(200);
    expect(retry.body.record.pic).toBe('After review');
  });
});

describe('status transitions', () => {
  it('moves Open → Completed → Rejected and back without special-casing', async () => {
    environment = await startTestServer();
    let version = 1;

    const toCompleted = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/20', {
      patch: { status: 'Hoàn thành', completedDate: '2026-08-15' },
      expectedVersion: version,
    });
    expect(toCompleted.status).toBe(200);
    expect(toCompleted.body.record.status).toBe('Hoàn thành');
    version = toCompleted.body.record.version;

    const toRejected = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/20', {
      patch: { status: 'Rejected (xét)', completedDate: null },
      expectedVersion: version,
    });
    expect(toRejected.status).toBe(200);
    expect(toRejected.body.record.status).toBe('Rejected (xét)');
    version = toRejected.body.record.version;

    const backToOpen = await api<{ record: RecordPayload }>(environment.baseUrl, 'PATCH', '/api/records/20', {
      patch: { status: 'Đợi đối sách' },
      expectedVersion: version,
    });
    expect(backToOpen.status).toBe(200);
    expect(backToOpen.body.record.status).toBe('Đợi đối sách');
  });
});

describe('effective TAT semantics are preserved', () => {
  it('uses a valid dueDate when present', async () => {
    environment = await startTestServer();
    const { body } = await api<{ record: { registeredDate: string; dueDate: string } }>(
      environment.baseUrl,
      'GET',
      '/api/records/1',
    );

    expect(getTatDueDate(body.record)).toBe(body.record.dueDate);
    expect(body.record.dueDate).not.toBe(addCalendarDays(body.record.registeredDate, LEGACY_TAT_WINDOW_DAYS));
  });

  it('falls back to registeredDate + 7 calendar days when dueDate is blank', async () => {
    environment = await startTestServer();
    const cleared = await api<{ record: { registeredDate: string; dueDate: string | null } }>(
      environment.baseUrl,
      'PATCH',
      '/api/records/2',
      { patch: { dueDate: null }, expectedVersion: 1 },
    );

    expect(cleared.body.record.dueDate).toBeNull();
    expect(getTatDueDate(cleared.body.record)).toBe(
      addCalendarDays(cleared.body.record.registeredDate, LEGACY_TAT_WINDOW_DAYS),
    );
  });

  it('keeps a completed record out of the active overdue set', async () => {
    environment = await startTestServer();
    const today = todayDateOnly();
    const completed = await api<{ record: { status: string; dueDate: string | null; registeredDate: string } }>(
      environment.baseUrl,
      'PATCH',
      '/api/records/5',
      { patch: { status: 'Hoàn thành', dueDate: '2020-01-01' }, expectedVersion: 1 },
    );

    expect(isTatOverdue(completed.body.record, today)).toBe(false);
  });

  it('keeps a Rejected record active on the same effective deadline', async () => {
    environment = await startTestServer();
    const today = todayDateOnly();
    const rejected = await api<{ record: { status: string; dueDate: string | null; registeredDate: string } }>(
      environment.baseUrl,
      'PATCH',
      '/api/records/6',
      { patch: { status: 'Rejected (xét)', dueDate: '2020-01-01' }, expectedVersion: 1 },
    );

    expect(isTatOverdue(rejected.body.record, today)).toBe(true);
  });
});

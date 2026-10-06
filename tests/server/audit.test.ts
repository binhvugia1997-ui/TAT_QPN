import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from '../../server/db/connection';
import { redactPathLike } from '../../server/db/audit';
import { api, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

interface AuditEvent {
  seq: number;
  occurredAt: string;
  operation: string;
  recordIdKey: string | null;
  mgmtNo: string | null;
  importBatchId: string | null;
  clientIp: string | null;
  clientLabel: string | null;
  changes: { field: string; oldValue: unknown; newValue: unknown }[];
  details: Record<string, unknown>;
}

describe('append-only audit history', () => {
  it('captures timestamp, operation, record id, management number and client info', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/30', { patch: { pic: 'Auditor' }, expectedVersion: 1 }, {
      'X-TNP-Client-Label': 'WORKSTATION-07',
    });

    const { body } = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/records/30/history');
    const event = body.events[0];

    expect(event.operation).toBe('record.update');
    expect(event.recordIdKey).toBe('number:30');
    expect(event.mgmtNo).toBeTruthy();
    expect(Date.parse(event.occurredAt)).not.toBeNaN();
    expect(event.clientLabel).toBe('WORKSTATION-07');
    // A loopback connection has an address; it identifies a connection, not a person.
    expect(typeof event.clientIp).toBe('string');
  });

  it('groups every field changed by one save under a single operation', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/31', {
      patch: { pic: 'PIC', notes: 'NOTES', caFileLink: 'http://ca/link', status: 'Đợi xét', mqisCode: 'MQ-1' },
      expectedVersion: 1,
    });

    const { body } = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/records/31/history');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].changes.map((change) => change.field).sort()).toEqual(
      ['caFileLink', 'mqisCode', 'notes', 'pic', 'status'],
    );
  });

  it('records old and new values for each changed field', async () => {
    environment = await startTestServer();
    const before = await api<{ record: { pic: string | null } }>(environment.baseUrl, 'GET', '/api/records/32');
    await api(environment.baseUrl, 'PATCH', '/api/records/32', { patch: { pic: 'Second owner' }, expectedVersion: 1 });

    const { body } = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/records/32/history');
    const change = body.events[0].changes.find((entry) => entry.field === 'pic');

    expect(change?.oldValue ?? null).toBe(before.body.record.pic ?? null);
    expect(change?.newValue).toBe('Second owner');
  });

  it('records no change entries when a save changes nothing', async () => {
    environment = await startTestServer();
    const before = await api<{ record: { pic: string | null } }>(environment.baseUrl, 'GET', '/api/records/33');
    await api(environment.baseUrl, 'PATCH', '/api/records/33', { patch: { pic: before.body.record.pic }, expectedVersion: 1 });

    const { body } = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/records/33/history');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].changes).toHaveLength(0);
  });

  it('refuses UPDATE and DELETE against the audit table', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/34', { patch: { pic: 'X' }, expectedVersion: 1 });
    const database = environment.context.database;

    expect(() => database.exec("UPDATE audit_events SET operation = 'tampered'")).toThrow(/append-only/u);
    expect(() => database.exec('DELETE FROM audit_events')).toThrow(/append-only/u);

    const remaining = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/records/34/history');
    expect(remaining.body.events).toHaveLength(1);
    expect(remaining.body.events[0].operation).toBe('record.update');
  });

  it('never exposes an absolute host path through the history API', () => {
    expect(redactPathLike('C:\\Users\\owner\\Documents\\report.pdf')).toBe('report.pdf');
    expect(redactPathLike('/home/owner/reports/report.pdf')).toBe('report.pdf');
    expect(redactPathLike('\\\\server\\share\\report.pdf')).toBe('report.pdf');
    expect(redactPathLike('plain-file.pdf')).toBe('plain-file.pdf');
    expect(redactPathLike(42)).toBe(42);
  });

  it('supports global recent history with filtering', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/35', { patch: { pic: 'A' }, expectedVersion: 1 });
    await api(environment.baseUrl, 'POST', '/api/backups', { note: 'filtered' });

    const all = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/audit');
    expect(all.body.events.length).toBeGreaterThan(1);

    const onlyBackups = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/audit?operation=backup.manual');
    expect(onlyBackups.body.events.length).toBeGreaterThan(0);
    expect(onlyBackups.body.events.every((event) => event.operation === 'backup.manual')).toBe(true);

    const limited = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/audit?limit=1');
    expect(limited.body.events).toHaveLength(1);

    const futureOnly = await api<{ events: AuditEvent[] }>(environment.baseUrl, 'GET', '/api/audit?from=2999-01-01T00:00:00Z');
    expect(futureOnly.body.events).toHaveLength(0);
  });

  it('keeps history read-only: no endpoint can rewrite it', async () => {
    environment = await startTestServer();
    const patch = await api(environment.baseUrl, 'PATCH', '/api/audit', { operation: 'x' });
    const del = await api(environment.baseUrl, 'DELETE', '/api/audit');

    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
  });
});

describe('audit storage integrity', () => {
  it('stores the event count reported by the status endpoint', async () => {
    environment = await startTestServer();
    await api(environment.baseUrl, 'PATCH', '/api/records/36', { patch: { pic: 'Y' }, expectedVersion: 1 });

    const direct = SqliteDatabase.open(environment.paths.databaseFile);
    try {
      const count = direct.get<{ total: number }>('SELECT COUNT(*) AS total FROM audit_events')?.total ?? 0;
      const status = await api<{ database: { auditEventCount: number } }>(environment.baseUrl, 'GET', '/api/status');
      expect(status.body.database.auditEventCount).toBe(count);
      expect(count).toBeGreaterThan(0);
    } finally {
      direct.close();
    }
  });
});

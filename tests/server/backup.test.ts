import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '../../server/db/connection';
import { DEFAULT_RETENTION } from '../../server/services/backup';
import { api, seedRow, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

interface Backup {
  id: string;
  createdAt: string;
  kind: string;
  fileName: string;
  sizeBytes: number;
  note: string | null;
}

function readBackupRecordCount(backupsDir: string, fileName: string): number {
  const handle = new DatabaseSync(path.join(backupsDir, fileName), { readOnly: true });
  try {
    const row = handle.prepare('SELECT COUNT(*) AS total FROM records').get() as { total: number };
    return row.total;
  } finally {
    handle.close();
  }
}

describe('SQLite backups', () => {
  it('produces a snapshot that is a valid, readable SQLite database', async () => {
    environment = await startTestServer({ runDailyBackup: false });
    const { status, body } = await api<Backup>(environment.baseUrl, 'POST', '/api/backups', { note: 'validity check' });

    expect(status).toBe(201);
    expect(body.kind).toBe('manual');
    expect(existsSync(path.join(environment.paths.backupsDir, body.fileName))).toBe(true);
    expect(readBackupRecordCount(environment.paths.backupsDir, body.fileName)).toBe(191);
  });

  it('keeps backups outside the disposable build output', async () => {
    environment = await startTestServer({ runDailyBackup: false });
    await api(environment.baseUrl, 'POST', '/api/backups', {});

    const backupsDir = environment.context.backups.directory;
    expect(backupsDir).toBe(environment.paths.backupsDir);
    expect(backupsDir).not.toContain(`${path.sep}dist${path.sep}`);
    expect(backupsDir).not.toContain(`${path.sep}dist-server${path.sep}`);
    expect(readdirSync(backupsDir).some((name) => name.endsWith('.db'))).toBe(true);
  });

  it('creates the automatic daily snapshot on the first write of the day', async () => {
    environment = await startTestServer();
    const { body } = await api<{ backups: Backup[] }>(environment.baseUrl, 'GET', '/api/backups');

    expect(body.backups).toHaveLength(1);
    expect(body.backups[0].kind).toBe('daily');
  });

  it('creates the daily snapshot only once per calendar day', async () => {
    environment = await startTestServer();
    const first = await environment.context.backups.createDailyIfDue();
    const second = await environment.context.backups.createDailyIfDue();
    const third = await environment.context.backups.createDailyIfDue();

    expect(first).toBeNull(); // already created during startup
    expect(second).toBeNull();
    expect(third).toBeNull();

    const { body } = await api<{ backups: Backup[] }>(environment.baseUrl, 'GET', '/api/backups');
    expect(body.backups.filter((backup) => backup.kind === 'daily')).toHaveLength(1);
  });

  it('takes a pre-import backup automatically', async () => {
    environment = await startTestServer({ runDailyBackup: false });
    await api(environment.baseUrl, 'POST', '/api/import/commit', {
      fileName: 'snapshot.xlsx',
      rows: [seedRow({ mgmtNo: 'SNAP-0001' })],
    });

    const { body } = await api<{ backups: Backup[] }>(environment.baseUrl, 'GET', '/api/backups');
    expect(body.backups.map((backup) => backup.kind)).toContain('pre-import');
  });

  it('creates a manual backup on request', async () => {
    environment = await startTestServer({ runDailyBackup: false });
    const created = await api<Backup>(environment.baseUrl, 'POST', '/api/backups', { note: 'operator' });
    const listed = await api<{ backups: Backup[] }>(environment.baseUrl, 'GET', '/api/backups');

    expect(created.status).toBe(201);
    expect(listed.body.backups.map((backup) => backup.id)).toContain(created.body.id);
    expect(listed.body.backups[0].note).toBe('operator');
  });

  it('bounds retention so the folder cannot grow forever', async () => {
    environment = await startTestServer({ runDailyBackup: false });
    for (let index = 0; index < DEFAULT_RETENTION + 6; index += 1) {
      await environment.context.backups.create('manual', `snapshot ${index}`);
    }

    const { body } = await api<{ backups: Backup[] }>(environment.baseUrl, 'GET', '/api/backups');
    expect(body.backups).toHaveLength(DEFAULT_RETENTION);

    const filesOnDisk = readdirSync(environment.paths.backupsDir).filter((name) => name.endsWith('.db'));
    expect(filesOnDisk).toHaveLength(DEFAULT_RETENTION);
  });

  it('reports the backup directory without exposing an absolute path', async () => {
    environment = await startTestServer({ runDailyBackup: false });
    const { body } = await api<{ directory: string }>(environment.baseUrl, 'GET', '/api/backups');
    expect(path.isAbsolute(body.directory)).toBe(false);
  });

  it('exposes no destructive restore endpoint', async () => {
    environment = await startTestServer({ runDailyBackup: false });
    const created = await api<Backup>(environment.baseUrl, 'POST', '/api/backups', {});

    for (const route of ['/api/restore', `/api/backups/${created.body.fileName}/restore`, '/api/restore/confirm']) {
      const posted = await api(environment.baseUrl, 'POST', route, {});
      expect(posted.status).toBe(404);
    }
  });

  it('leaves the live database usable after a snapshot', async () => {
    environment = await startTestServer({ runDailyBackup: false });
    await api(environment.baseUrl, 'POST', '/api/backups', {});
    const updated = await api<{ record: { pic: string | null; version: number } }>(
      environment.baseUrl,
      'PATCH',
      '/api/records/40',
      { patch: { pic: 'Still writable' }, expectedVersion: 1 },
    );

    expect(updated.status).toBe(200);
    expect(updated.body.record.pic).toBe('Still writable');

    // The snapshot was taken before that write, so it must not contain it.
    const listed = await api<{ backups: Backup[] }>(environment.baseUrl, 'GET', '/api/backups');
    const database = SqliteDatabase.open(environment.paths.databaseFile);
    try {
      expect(database.get<{ pic: string }>("SELECT json_extract(payload,'$.pic') AS pic FROM records WHERE id_key = 'number:40'")?.pic)
        .toBe('Still writable');
    } finally {
      database.close();
    }
    expect(listed.body.backups).toHaveLength(1);
  });
});

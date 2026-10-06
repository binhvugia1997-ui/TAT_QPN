import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATIONS, SCHEMA_VERSION } from '../../server/db/schema';
import { RecordStore } from '../../server/db/records';
import { SqliteDatabase } from '../../server/db/connection';
import { SEED_MARKER_KEY, SEED_RECORD_COUNT, readSeedRecords } from '../../server/context';
import { resolveRuntimePaths } from '../../server/paths';
import { api, startTestServer } from './helpers';
import type { TestEnvironment } from './helpers';

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

describe('SQLite initialization', () => {
  it('creates the database file and applies schema version 1', async () => {
    environment = await startTestServer();

    expect(existsSync(environment.paths.databaseFile)).toBe(true);
    expect(environment.context.database.userVersion).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1]);
  });

  it('creates every table and index the runtime depends on', async () => {
    environment = await startTestServer();
    const tables = environment.context.database
      .all<{ name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name",
      )
      .map((row) => row.name);

    for (const expected of [
      'records',
      'audit_events',
      'import_history',
      'reports',
      'report_files',
      'backups',
      'metadata',
      'audit_events_no_update',
      'audit_events_no_delete',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('runs in WAL mode so readers never block the single writer', async () => {
    environment = await startTestServer();
    const mode = environment.context.database.pragmaValue<string>('journal_mode');
    expect(mode).toBe('wal');
  });

  it('is idempotent: reopening applies no migrations and does not reseed', async () => {
    environment = await startTestServer();
    const paths = environment.paths;
    const firstCount = environment.context.records.count();
    const firstMigrations = environment.context.migrations;
    await environment.close({ keepFiles: true });
    environment = undefined;

    // Reopen the same database file through a fresh context.
    const database = SqliteDatabase.open(paths.databaseFile);
    const migrations = applyMigrations(database);
    const records = new RecordStore(database);
    const seed = records.seedIfEmpty(readSeedRecords(paths.seedFile), SEED_MARKER_KEY);

    expect(firstMigrations.applied).toHaveLength(1);
    expect(migrations.applied).toHaveLength(0);
    expect(migrations.from).toBe(SCHEMA_VERSION);
    expect(seed.alreadyInitialized).toBe(true);
    expect(seed.seeded).toBe(0);
    expect(records.count()).toBe(firstCount);
    database.close();
  });

  it('applies only migrations newer than the stored version', () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      database.userVersion = 1;
      const result = applyMigrations(database, MIGRATIONS);
      expect(result.applied).toEqual([]);
      expect(result.to).toBe(1);
      expect(database.userVersion).toBe(1);
    } finally {
      database.close();
    }
  });

  it('refuses to run an older schema backwards', () => {
    const database = SqliteDatabase.open(':memory:');
    try {
      database.userVersion = 5;
      const result = applyMigrations(database, MIGRATIONS);
      expect(result.applied).toEqual([]);
      expect(database.userVersion).toBe(5);
    } finally {
      database.close();
    }
  });
});

describe('canonical seed data', () => {
  it('seeds exactly 191 records into a fresh database', async () => {
    environment = await startTestServer();

    expect(environment.context.seed.seeded).toBe(SEED_RECORD_COUNT);
    expect(environment.context.seed.alreadyInitialized).toBe(false);
    expect(environment.context.records.count()).toBe(SEED_RECORD_COUNT);
    expect(readSeedRecords(environment.paths.seedFile)).toHaveLength(191);
  });

  it('preserves numeric canonical ids, management numbers and provenance', async () => {
    environment = await startTestServer();
    const records = environment.context.records.list();

    expect(records[0].record.id).toBe(1);
    expect(typeof records[0].record.id).toBe('number');
    expect(records[0].record.recordSource).toBe('legacy-seed');
    expect(records[0].record.mgmtNo).toMatch(/-VOC$/u);
    expect(records.every((stored) => stored.version === 1)).toBe(true);
    expect(new Set(records.map((stored) => stored.idKey)).size).toBe(191);
  });

  it('keeps all 34 original source fields for every seed record', async () => {
    environment = await startTestServer();
    const rawFile = JSON.parse(readFileSync(environment.paths.seedFile, 'utf8')) as Record<string, unknown>[];
    const sourceFields = new Set(rawFile.flatMap((record) => Object.keys(record)));
    expect(sourceFields.size).toBe(34);

    const stored = environment.context.records.listRecords();
    expect(stored).toHaveLength(191);
    for (const record of stored) {
      for (const field of sourceFields) {
        expect(Object.prototype.hasOwnProperty.call(record, field)).toBe(true);
      }
      // Provenance is the only field the app adds on top of the 34 source fields.
      expect(record.recordSource).toBe('legacy-seed');
    }
  });

  it('reports the seed outcome through the status endpoint', async () => {
    environment = await startTestServer();
    const { status, body } = await api<{
      seed: { seeded: number; alreadyInitialized: boolean };
      database: { recordCount: number; schemaVersion: number; path: string };
    }>(environment.baseUrl, 'GET', '/api/status');

    expect(status).toBe(200);
    expect(body.seed.seeded).toBe(191);
    expect(body.database.recordCount).toBe(191);
    expect(body.database.schemaVersion).toBe(1);
    // Absolute host paths are never exposed; the path stays project-relative.
    expect(path.isAbsolute(body.database.path)).toBe(false);
  });

  it('never overwrites an existing database', async () => {
    environment = await startTestServer();
    const { body } = await api<{ record: { id: number; pic: string | null; version: number } }>(
      environment.baseUrl,
      'PATCH',
      '/api/records/1',
      { patch: { pic: 'Owner edit' }, expectedVersion: 1 },
    );
    expect(body.record.version).toBe(2);
    const paths = environment.paths;
    const root = environment.root;
    await environment.close({ keepFiles: true });
    environment = undefined;

    const database = SqliteDatabase.open(paths.databaseFile);
    const records = new RecordStore(database);
    const seed = records.seedIfEmpty(readSeedRecords(paths.seedFile), SEED_MARKER_KEY);

    expect(seed.alreadyInitialized).toBe(true);
    expect(seed.seeded).toBe(0);
    expect(records.getStored('number:1')?.record.pic).toBe('Owner edit');
    expect(records.getStored('number:1')?.version).toBe(2);
    expect(records.count()).toBe(191);
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the persistent data, backup and report directories', async () => {
    environment = await startTestServer();
    for (const directory of [environment.paths.dataDir, environment.paths.backupsDir, environment.paths.reportsDir]) {
      expect(readdirSync(directory)).toBeDefined();
    }
  });

  it('resolves runtime directories inside the project root by default', () => {
    const paths = resolveRuntimePaths({ env: {} });
    expect(paths.dataDir).toBe(path.join(paths.root, 'data'));
    expect(paths.backupsDir).toBe(path.join(paths.root, 'backups'));
    expect(paths.reportsDir).toBe(path.join(paths.root, 'reports'));
    expect(paths.databaseFile).toBe(path.join(paths.root, 'data', 'tnp.db'));
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext, closeContext } from '../../server/context';
import { runMigration, readExportFile, MigrationExportError } from '../../server/migrateIndexedDb';
import { resolveRuntimePaths } from '../../server/paths';
import type { RuntimePaths } from '../../server/paths';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedPaths(): RuntimePaths {
  const root = mkdtempSync(path.join(tmpdir(), 'tnp-migrate-'));
  roots.push(root);
  return resolveRuntimePaths({
    env: {
      TNP_DATA_DIR: path.join(root, 'data'),
      TNP_BACKUPS_DIR: path.join(root, 'backups'),
      TNP_REPORTS_DIR: path.join(root, 'reports'),
      TNP_DB_FILE: path.join(root, 'data', 'tnp.db'),
      TNP_LOCK_FILE: path.join(root, 'data', 'tnp.lock'),
      TNP_CONFIG_FILE: path.join(root, 'data', 'server.json'),
    },
  });
}

function writeExport(paths: RuntimePaths, payload: unknown, name = 'indexeddb-export.json'): string {
  // paths.root is the project root (the seed file lives there), so scratch files go into
  // the isolated temporary data directory instead.
  mkdirSync(paths.dataDir, { recursive: true });
  const file = path.join(paths.dataDir, name);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

/** A realistic browser export: an edited seed record plus an imported and a manual record. */
function browserExport() {
  return {
    exportedAt: '2026-09-30T10:00:00.000Z',
    source: 'indexeddb',
    databaseName: 'tnp-defect-management-dev',
    records: [
      {
        id: 1,
        recordSource: 'legacy-seed',
        mgmtNo: '260702006-VOC',
        registeredDate: '2026-07-02',
        status: 'Hoàn thành',
        pic: 'Browser owner',
        notes: 'Edited in the browser',
        caFileLink: 'C:\\Users\\owner\\Documents\\countermeasure.pdf',
        sourceExtras: { 'Unknown column': 'kept' },
      },
      {
        id: 'i-imported-1',
        recordSource: 'import',
        mgmtNo: 'IMPORTED-0001',
        registeredDate: '2026-08-01',
        status: 'Đợi đối sách',
        plant: 'SIEL',
        title: 'Imported in the browser',
        defectQty: 5,
        sourceExtras: { 'Extra column': 7 },
      },
      {
        id: 'n-manual-1',
        recordSource: 'manual',
        mgmtNo: 'NEW-000001',
        registeredDate: '2026-08-02',
        status: 'Đợi đối sách',
        title: 'Created manually in the browser',
      },
    ],
    importHistory: [
      {
        id: 'import-log-1',
        importedAt: '2026-09-29T08:00:00.000Z',
        files: [{ fileName: 'tnp.xlsx', added: 1, updated: 0, unchanged: 0, total: 1 }],
        added: 1,
        updated: 0,
        unchanged: 0,
        total: 1,
      },
    ],
  };
}

describe('explicit IndexedDB migration', () => {
  it('does nothing on a dry run and reports what would change', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, browserExport());

    const outcome = await runMigration({ exportFile: file, apply: false, paths });

    expect(outcome.applied).toBe(false);
    expect(outcome.backupFileName).toBeNull();
    expect(outcome.totalRecords).toBe(3);
    expect(outcome.updates).toBe(1); // seed record 1 was edited in the browser
    expect(outcome.inserts).toBe(2); // the imported and the manual record
    expect(outcome.unchanged).toBe(0);
    expect(outcome.importHistoryEntries).toBe(1);

    const context = await createContext({ paths, runDailyBackup: false });
    try {
      expect(context.records.getStored('number:1')?.record.pic ?? null).toBeNull();
      expect(context.records.getStored('string:i-imported-1')).toBeUndefined();
      expect(context.records.count()).toBe(191);
      expect(context.importHistory.list()).toHaveLength(0);
    } finally {
      closeContext(context);
    }
  });

  it('creates a backup before a confirmed migration', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, browserExport());

    const outcome = await runMigration({ exportFile: file, apply: true, paths });
    expect(outcome.applied).toBe(true);
    expect(outcome.backupFileName).toBeTruthy();

    const context = await createContext({ paths, runDailyBackup: false });
    try {
      const backups = context.backups.list();
      expect(backups.map((backup) => backup.fileName)).toContain(outcome.backupFileName);
    } finally {
      closeContext(context);
    }
  });

  it('applies the migration, preserving canonical ids and app-managed values', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, browserExport());
    await runMigration({ exportFile: file, apply: true, paths });

    const context = await createContext({ paths, runDailyBackup: false });
    try {
      expect(context.records.count()).toBe(193);

      const seed = context.records.getStored('number:1');
      expect(seed?.record.id).toBe(1);
      expect(typeof seed?.record.id).toBe('number');
      expect(seed?.record.pic).toBe('Browser owner');
      expect(seed?.record.notes).toBe('Edited in the browser');
      expect(seed?.record.status).toBe('Hoàn thành');
      expect(seed?.record.recordSource).toBe('legacy-seed');

      const imported = context.records.getStored('string:i-imported-1');
      expect(imported?.record.id).toBe('i-imported-1');
      expect(imported?.record.recordSource).toBe('import');
      expect(imported?.record.defectQty).toBe(5);

      const manual = context.records.getStored('string:n-manual-1');
      expect(manual?.record.id).toBe('n-manual-1');
      expect(manual?.record.recordSource).toBe('manual');
    } finally {
      closeContext(context);
    }
  });

  it('preserves sourceExtras through the migration', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, browserExport());
    await runMigration({ exportFile: file, apply: true, paths });

    const context = await createContext({ paths, runDailyBackup: false });
    try {
      expect(context.records.getStored('number:1')?.record.sourceExtras).toStrictEqual({ 'Unknown column': 'kept' });
      expect(context.records.getStored('string:i-imported-1')?.record.sourceExtras).toStrictEqual({ 'Extra column': 7 });
    } finally {
      closeContext(context);
    }
  });

  it('does not make an unmanaged local path streamable as a report', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, browserExport());
    await runMigration({ exportFile: file, apply: true, paths });

    const context = await createContext({ paths, runDailyBackup: false });
    try {
      // The legacy link is preserved as data only; nothing is registered as a managed report.
      expect(context.records.getStored('number:1')?.record.caFileLink).toContain('countermeasure.pdf');
      expect(context.reportCatalog.get('number:1')).toBeUndefined();
      expect(context.reportStorage.inspect('number:1').state).toBe('no-report');
    } finally {
      closeContext(context);
    }
  });

  it('migrates import history without duplicating it on a second run', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, browserExport());
    await runMigration({ exportFile: file, apply: true, paths });
    const second = await runMigration({ exportFile: file, apply: true, paths });

    const context = await createContext({ paths, runDailyBackup: false });
    try {
      expect(context.importHistory.list()).toHaveLength(1);
      expect(context.importHistory.list()[0].id).toBe('import-log-1');
      expect(second.unchanged).toBe(3);
      expect(second.updates).toBe(0);
      expect(second.inserts).toBe(0);
    } finally {
      closeContext(context);
    }
  });

  it('audits the migration', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, browserExport());
    await runMigration({ exportFile: file, apply: true, paths });

    const context = await createContext({ paths, runDailyBackup: false });
    try {
      const operations = context.audit.list({ limit: 500 }).map((event) => event.operation);
      expect(operations).toContain('migration.apply');
      expect(operations).toContain('record.create');
      expect(operations).toContain('record.update');
    } finally {
      closeContext(context);
    }
  });

  it('reports invalid rows instead of importing garbage', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, {
      records: [{ id: 'ok-1', mgmtNo: 'OK-1' }, { not: 'a record' }, null, { id: 'ok-2', mgmtNo: 'OK-2' }],
    });

    const outcome = await runMigration({ exportFile: file, apply: false, paths });
    expect(outcome.totalRecords).toBe(4);
    expect(outcome.invalid).toBe(2);
    expect(outcome.inserts).toBe(2);
  });

  it('rejects a missing or malformed export file', async () => {
    const paths = isolatedPaths();
    await expect(runMigration({ exportFile: path.join(paths.dataDir, 'nope.json'), apply: false, paths }))
      .rejects.toThrow(MigrationExportError);

    const broken = writeExport(paths, {}, 'broken.json');
    writeFileSync(broken, '{ not json');
    await expect(runMigration({ exportFile: broken, apply: false, paths })).rejects.toThrow(MigrationExportError);
  });

  it('reads an export file without mutating it', async () => {
    const paths = isolatedPaths();
    const file = writeExport(paths, browserExport());
    const parsed = readExportFile(file);

    expect(parsed.records).toHaveLength(3);
    expect(parsed.source).toBe('indexeddb');
  });
});

import fs from 'node:fs';
import { normalizeDefectRecord } from '../src/models/defect-record';
import type { DefectRecord } from '../src/models/defect-record';
import type { ServerConfig } from './config';
import { loadServerConfig, type ConfigOverrides } from './config';
import { AuditStore } from './db/audit';
import { SqliteDatabase } from './db/connection';
import { ImportHistoryStore } from './db/importHistory';
import { MetadataStore } from './db/metadata';
import { RecordStore, type SeedOutcome } from './db/records';
import { ReportCatalog } from './db/reportCatalog';
import { applyMigrations, type MigrationResult } from './db/schema';
import { BackupService } from './services/backup';
import { ImportPipeline } from './services/importPipeline';
import { ReportStorage } from './services/reportStorage';
import { ensureRuntimeDirectories, type RuntimePaths } from './paths';

export const SEED_MARKER_KEY = 'legacy-base-data-v1';
export const SEED_RECORD_COUNT = 191;

export interface AppContext {
  paths: RuntimePaths;
  config: ServerConfig;
  database: SqliteDatabase;
  metadata: MetadataStore;
  records: RecordStore;
  audit: AuditStore;
  importHistory: ImportHistoryStore;
  reportCatalog: ReportCatalog;
  backups: BackupService;
  reportStorage: ReportStorage;
  imports: ImportPipeline;
  seed: SeedOutcome;
  migrations: MigrationResult;
  startedAt: string;
}

export interface ContextOptions {
  paths: RuntimePaths;
  env?: NodeJS.ProcessEnv;
  configOverrides?: ConfigOverrides;
  /** Tests and the migration CLI can start without taking a daily snapshot. */
  runDailyBackup?: boolean;
}

export function readSeedRecords(seedFile: string): DefectRecord[] {
  if (!fs.existsSync(seedFile)) {
    throw new Error(`The canonical seed file "${seedFile}" is missing.`);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`The canonical seed file "${seedFile}" must contain an array of records.`);
  }
  return parsed.map((record) => normalizeDefectRecord(record as Record<string, unknown>, 'legacy-seed'));
}

/**
 * Opens (or creates) the authoritative database, applies migrations, seeds a fresh
 * database exactly once, and wires the services together.
 */
export async function createContext(options: ContextOptions): Promise<AppContext> {
  const { paths } = options;
  const env = options.env ?? process.env;
  ensureRuntimeDirectories(paths);

  const config = loadServerConfig(paths, env, options.configOverrides);
  const database = SqliteDatabase.open(paths.databaseFile);
  const migrations = applyMigrations(database);

  const metadata = new MetadataStore(database);
  const records = new RecordStore(database);
  const audit = new AuditStore(database);
  const importHistory = new ImportHistoryStore(database);
  const reportCatalog = new ReportCatalog(database);
  const backups = new BackupService(database, paths.databaseFile, paths.backupsDir, metadata);
  const reportStorage = new ReportStorage(reportCatalog, paths.reportsDir);
  const imports = new ImportPipeline(database, records, audit, importHistory, backups);

  const seedRecords = readSeedRecords(paths.seedFile);
  const seed = records.seedIfEmpty(seedRecords, SEED_MARKER_KEY);

  if (migrations.applied.length > 0) {
    audit.append({
      operation: 'migration.apply',
      details: { from: migrations.from, to: migrations.to, applied: migrations.applied },
    });
  }

  if (options.runDailyBackup !== false) {
    const daily = await backups.createDailyIfDue();
    if (daily) {
      audit.append({ operation: 'backup.daily', details: { fileName: daily.fileName } });
    }
  }

  return {
    paths,
    config,
    database,
    metadata,
    records,
    audit,
    importHistory,
    reportCatalog,
    backups,
    reportStorage,
    imports,
    seed,
    migrations,
    startedAt: new Date().toISOString(),
  };
}

export function closeContext(context: AppContext): void {
  context.database.close();
}

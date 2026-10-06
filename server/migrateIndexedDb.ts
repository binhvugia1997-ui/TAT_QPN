import fs from 'node:fs';
import { getRecordIdKey } from '../src/business/records/recordKey';
import { normalizeDefectRecord } from '../src/models/defect-record';
import type { DefectRecord, RecordSource } from '../src/models/defect-record';
import type { ImportHistoryEntry } from '../src/models/import-history';
import { createContext, closeContext } from './context';
import { diffRecords } from './db/records';
import { resolveRuntimePaths } from './paths';

/**
 * Explicit, one-way migration from the legacy browser IndexedDB store into the
 * authoritative SQLite database.
 *
 * The browser export is produced by the operator from the app (read-only) and written to a
 * JSON file. Nothing here reads a browser database, and nothing is applied without
 * `--confirm`; the default run is a dry-run report.
 */

export interface IndexedDbExport {
  exportedAt?: string;
  source?: string;
  databaseName?: string;
  records?: unknown[];
  importHistory?: unknown[];
}

export interface MigrationPlanEntry {
  idKey: string;
  mgmtNo: string;
  action: 'insert' | 'update' | 'unchanged';
  changes: { field: string; oldValue: unknown; newValue: unknown }[];
}

export interface MigrationPlan {
  exportFile: string;
  exportedAt: string | null;
  totalRecords: number;
  inserts: number;
  updates: number;
  unchanged: number;
  invalid: number;
  importHistoryEntries: number;
  entries: MigrationPlanEntry[];
}

export class MigrationExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationExportError';
  }
}

export function readExportFile(file: string): IndexedDbExport {
  if (!fs.existsSync(file)) throw new MigrationExportError(`The export file "${file}" does not exist.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new MigrationExportError(`The export file "${file}" is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new MigrationExportError('The export file must contain a JSON object.');
  }
  return parsed as IndexedDbExport;
}

function isRecordSource(value: unknown): value is RecordSource {
  return value === 'legacy-seed' || value === 'import' || value === 'manual';
}

export function planMigration(
  context: Awaited<ReturnType<typeof createContext>>,
  exported: IndexedDbExport,
  exportFile: string,
): MigrationPlan {
  const rawRecords = Array.isArray(exported.records) ? exported.records : [];
  const existing = new Map(context.records.list().map((stored) => [stored.idKey, stored]));
  const entries: MigrationPlanEntry[] = [];
  let inserts = 0;
  let updates = 0;
  let unchanged = 0;
  let invalid = 0;

  for (const raw of rawRecords) {
    if (!raw || typeof raw !== 'object') {
      invalid += 1;
      continue;
    }
    let record: DefectRecord;
    try {
      const candidate = raw as Record<string, unknown>;
      record = normalizeDefectRecord(candidate, isRecordSource(candidate.recordSource) ? candidate.recordSource : 'manual');
    } catch {
      invalid += 1;
      continue;
    }

    const idKey = getRecordIdKey(record.id);
    const stored = existing.get(idKey);

    if (!stored) {
      inserts += 1;
      entries.push({
        idKey,
        mgmtNo: String(record.mgmtNo ?? ''),
        action: 'insert',
        changes: [{ field: '(new record)', oldValue: null, newValue: record.mgmtNo ?? null }],
      });
      continue;
    }

    const changes = diffRecords(stored.record, record);
    if (changes.length === 0) {
      unchanged += 1;
      entries.push({ idKey, mgmtNo: String(record.mgmtNo ?? ''), action: 'unchanged', changes: [] });
      continue;
    }

    updates += 1;
    entries.push({ idKey, mgmtNo: String(record.mgmtNo ?? ''), action: 'update', changes });
  }

  const importHistoryEntries = Array.isArray(exported.importHistory) ? exported.importHistory.length : 0;

  return {
    exportFile,
    exportedAt: typeof exported.exportedAt === 'string' ? exported.exportedAt : null,
    totalRecords: rawRecords.length,
    inserts,
    updates,
    unchanged,
    invalid,
    importHistoryEntries,
    entries,
  };
}

export interface MigrationOutcome extends MigrationPlan {
  applied: boolean;
  backupFileName: string | null;
}

export async function runMigration(options: {
  exportFile: string;
  apply: boolean;
  paths?: ReturnType<typeof resolveRuntimePaths>;
}): Promise<MigrationOutcome> {
  const paths = options.paths ?? resolveRuntimePaths();
  const exported = readExportFile(options.exportFile);
  const context = await createContext({ paths, runDailyBackup: false });

  try {
    const plan = planMigration(context, exported, options.exportFile);

    if (!options.apply) {
      return { ...plan, applied: false, backupFileName: null };
    }

    // A confirmed migration always leaves a restore point first.
    const backup = await context.backups.create('manual', `Before IndexedDB migration from ${options.exportFile}`);

    context.database.transaction(() => {
      for (const entry of plan.entries) {
        if (entry.action === 'unchanged') continue;
        const raw = (exported.records ?? []).find((candidate) => {
          if (!candidate || typeof candidate !== 'object') return false;
          const record = candidate as Record<string, unknown>;
          return getRecordIdKey(record.id as never) === entry.idKey;
        }) as Record<string, unknown> | undefined;
        if (!raw) continue;

        const candidate = raw;
        const record = normalizeDefectRecord(
          candidate,
          isRecordSource(candidate.recordSource) ? candidate.recordSource : 'manual',
        );

        if (entry.action === 'insert') {
          const stored = context.records.insertNormalized(record);
          context.audit.append({
            operation: 'record.create',
            recordIdKey: stored.idKey,
            mgmtNo: String(record.mgmtNo ?? ''),
            changes: entry.changes,
            details: { origin: 'indexeddb-migration' },
          });
          continue;
        }

        const stored = context.records.getStored(entry.idKey);
        if (!stored) continue;
        const updated = context.records.update(entry.idKey, record, stored.version);
        context.audit.append({
          operation: 'record.update',
          recordIdKey: entry.idKey,
          mgmtNo: String(record.mgmtNo ?? ''),
          changes: entry.changes,
          details: { origin: 'indexeddb-migration', version: updated.version },
        });
      }

      for (const raw of Array.isArray(exported.importHistory) ? exported.importHistory : []) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as ImportHistoryEntry;
        if (typeof entry.id !== 'string' || typeof entry.importedAt !== 'string') continue;
        context.database.run(
          `INSERT INTO import_history (id, imported_at, files_json, added, updated, unchanged, total)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(id) DO NOTHING`,
          [
            entry.id,
            entry.importedAt,
            JSON.stringify(Array.isArray(entry.files) ? entry.files : []),
            Number(entry.added) || 0,
            Number(entry.updated) || 0,
            Number(entry.unchanged) || 0,
            Number(entry.total) || 0,
          ],
        );
      }

      context.audit.append({
        operation: 'migration.apply',
        details: {
          origin: 'indexeddb-migration',
          exportFile: options.exportFile,
          inserts: plan.inserts,
          updates: plan.updates,
          unchanged: plan.unchanged,
          backupFileName: backup.fileName,
        },
      });
    });

    return { ...plan, applied: true, backupFileName: backup.fileName };
  } finally {
    closeContext(context);
  }
}

function parseCli(argv: readonly string[]): { exportFile: string; apply: boolean; dryRun: boolean } {
  let exportFile: string | undefined;
  let apply = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--file' || argument === '--export') {
      exportFile = argv[index + 1];
      index += 1;
    } else if (argument === '--confirm' || argument === '--apply') {
      apply = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    }
  }

  if (!exportFile) {
    throw new MigrationExportError('Usage: migrate-indexeddb --file <export.json> [--dry-run] [--confirm]');
  }
  return { exportFile, apply: apply && !dryRun, dryRun };
}

const isMain = typeof require !== 'undefined' && require.main === module;

if (isMain) {
  const { exportFile, apply, dryRun } = parseCli(process.argv.slice(2));
  runMigration({ exportFile, apply })
    .then((outcome) => {
      const lines = [
        '',
        `  IndexedDB migration ${outcome.applied ? 'APPLIED' : 'DRY RUN'}`,
        `  Export file     ${outcome.exportFile}`,
        `  Exported at     ${outcome.exportedAt ?? 'unknown'}`,
        `  Records         ${outcome.totalRecords}`,
        `  To insert       ${outcome.inserts}`,
        `  To update       ${outcome.updates}`,
        `  Unchanged       ${outcome.unchanged}`,
        `  Invalid rows    ${outcome.invalid}`,
        `  Import history  ${outcome.importHistoryEntries}`,
        outcome.applied ? `  Backup          ${outcome.backupFileName}` : '',
        outcome.applied ? '' : '  Nothing was written. Re-run with --confirm to apply.',
        '',
      ].filter(Boolean);
      process.stdout.write(`${lines.join('\n')}\n`);
      if (!outcome.applied && outcome.inserts + outcome.updates > 0) {
        const preview = outcome.entries
          .filter((entry) => entry.action !== 'unchanged')
          .slice(0, 10)
          .map((entry) => `    ${entry.action.toUpperCase()} ${entry.idKey} ${entry.mgmtNo}`);
        if (preview.length > 0) process.stdout.write(`${preview.join('\n')}\n`);
      }
      if (dryRun) process.stdout.write('\n  --dry-run was requested, so no changes were applied.\n');
    })
    .catch((error: unknown) => {
      process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

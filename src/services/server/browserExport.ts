import type { DefectRecord } from '../../models/defect-record';
import type { ImportHistoryEntry } from '../../models/import-history';
import { DATABASE_NAME, IndexedDbDatabase } from '../database/database';
import { RecordRepository } from '../database/recordRepository';

export interface IndexedDbExportFile {
  exportedAt: string;
  source: 'indexeddb';
  databaseName: string;
  records: DefectRecord[];
  importHistory: ImportHistoryEntry[];
}

/**
 * Read-only export of the legacy browser store, used for the explicit migration into
 * SQLite. This is the only remaining runtime use of the isolated IndexedDB implementation:
 * it opens the old store, copies it out, and never writes to it.
 */
export async function exportIndexedDbData(): Promise<IndexedDbExportFile> {
  const database = new IndexedDbDatabase();
  try {
    const repository = new RecordRepository(database);
    const [records, importHistory] = await Promise.all([
      repository.getAllRecords(),
      repository.getImportHistory(),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      source: 'indexeddb',
      databaseName: DATABASE_NAME,
      records,
      importHistory,
    };
  } finally {
    await database.close();
  }
}

export function downloadExport(exported: IndexedDbExportFile): string {
  const stamp = exported.exportedAt.replace(/[:.]/gu, '-');
  const fileName = `tnp-indexeddb-export-${stamp}.json`;
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fileName;
}

import type { ImportFileSummary, ImportHistoryEntry } from '../../models/import-history';
import { apiClient } from './apiClient';

export interface ServerImportOptions {
  fileName: string;
}

export interface ServerImportResult extends ImportFileSummary {
  history: ImportHistoryEntry;
  /** Name of the automatic snapshot taken before this import was applied. */
  backupFileName: string | null;
}

export type ServerImportPreview = Omit<ImportFileSummary, 'fileName' | 'error'>;

/**
 * Import orchestration for the server runtime. Parsing and preview stay in the browser;
 * matching, the strict `status` + `dueDate` whitelist, the transaction, the pre-import
 * backup and the audit all happen on the server.
 */
export class ServerImportService {
  previewCanonicalRows(
    rows: readonly Record<string, unknown>[],
    fileName: string,
  ): Promise<ServerImportPreview> {
    return apiClient.post<ServerImportPreview>('/api/import/preview', { rows, fileName });
  }

  importCanonicalRows(
    rows: readonly Record<string, unknown>[],
    options: ServerImportOptions,
  ): Promise<ServerImportResult> {
    return apiClient.post<ServerImportResult>('/api/import/commit', { rows, fileName: options.fileName });
  }
}

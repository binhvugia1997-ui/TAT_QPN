import { getRecordIdKey } from '../../business/records/recordKey';
import type { DefectRecord, RecordId } from '../../models/defect-record';
import type { ImportHistoryEntry } from '../../models/import-history';
import type { RecordStore, SeedResult } from '../database/recordRepository';
import { apiClient, ServerUnavailableError } from './apiClient';

export interface ServerRecord extends DefectRecord {
  version: number;
}

export interface ServerStatus {
  app: string;
  phase: number;
  storage: string;
  server: {
    bindAddress: string;
    configuredBindHost: string;
    actualPort: number;
    lanEnabled: boolean;
    lanEnabledNote: string;
    lanAddresses: { address: string; family: string; interface: string; url: string }[];
    localhostUrl: string;
    configSources: { port: string; lan: string };
  };
  database: {
    path: string;
    schemaVersion: number;
    recordCount: number;
    auditEventCount: number;
  };
  directories: { data: string; backups: string; reports: string };
  seed: SeedResult;
  security: { authentication: boolean; tls: boolean; warning: string };
  startedAt: string;
}

export interface BackupSummary {
  id: string;
  createdAt: string;
  kind: string;
  fileName: string;
  sizeBytes: number;
  note: string | null;
}

export interface AuditSummary {
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

export interface ReportSummary {
  originalName: string;
  sizeBytes: number;
  contentType: string | null;
  attachedAt: string;
  updatedAt: string;
}

/** Fields that are managed by the server and must never be sent back as an edit. */
const SERVER_OWNED_FIELDS = new Set(['id', 'recordSource', 'version']);

function recordPath(id: RecordId): string {
  return `/api/records/${encodeURIComponent(getRecordIdKey(id))}`;
}

/**
 * Record persistence through the server API. SQLite stays authoritative: the browser never
 * opens the database file, and every write carries the revision it read so a concurrent
 * edit surfaces as a 409 instead of being overwritten silently.
 */
export class ServerRecordRepository implements RecordStore {
  async getAllRecords(): Promise<DefectRecord[]> {
    const { records } = await apiClient.get<{ records: DefectRecord[] }>('/api/records');
    return records;
  }

  async getRecord(id: RecordId): Promise<DefectRecord | undefined> {
    try {
      const { record } = await apiClient.get<{ record: DefectRecord }>(recordPath(id));
      return record;
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error as { status: number }).status === 404) return undefined;
      throw error;
    }
  }

  async addRecord(record: DefectRecord): Promise<void> {
    await apiClient.post<{ record: DefectRecord }>('/api/records', { record });
  }

  async updateRecord(id: RecordId, record: DefectRecord): Promise<DefectRecord> {
    const expectedVersion = Number((record as ServerRecord).version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error('This record has no server revision. Reload it before saving.');
    }

    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(record)) {
      if (SERVER_OWNED_FIELDS.has(field)) continue;
      patch[field] = value;
    }

    const response = await apiClient.patch<{ record: DefectRecord }>(recordPath(id), { patch, expectedVersion });
    return response.record;
  }

  async deleteRecord(id: RecordId): Promise<void> {
    await apiClient.delete(recordPath(id));
  }

  async getImportHistory(): Promise<ImportHistoryEntry[]> {
    const { history } = await apiClient.get<{ history: ImportHistoryEntry[] }>('/api/import-history');
    return history;
  }

  /** The server seeds its own database at startup; this only reports what it did. */
  async initializeFromSeed(): Promise<SeedResult> {
    const { seed } = await apiClient.get<{ seed: SeedResult }>('/api/bootstrap');
    return seed;
  }

  /**
   * Imports are transactional on the server, so they go through `ServerImportService`
   * rather than a client-side change list.
   */
  async commitImport(): Promise<void> {
    throw new ServerUnavailableError('Imports run inside a server transaction; use the import service.');
  }

  async bulkUpsert(): Promise<void> {
    throw new ServerUnavailableError('Bulk writes are only performed by the server import pipeline.');
  }

  /**
   * Phase 5 deliberately exposes no destructive one-click reset or restore, so the legacy
   * clear operation is not reachable from the server runtime.
   */
  async clearImportedData(): Promise<{ removed: number }> {
    throw new ServerUnavailableError('Destructive data clearing is not available in the Phase 5 server runtime.');
  }
}

export const serverApi = {
  status: () => apiClient.get<ServerStatus>('/api/status'),
  bootstrap: () => apiClient.get<{ seed: SeedResult; schemaVersion: number; recordCount: number; status: ServerStatus }>('/api/bootstrap'),
  backups: () => apiClient.get<{ backups: BackupSummary[]; directory: string }>('/api/backups'),
  createBackup: (note?: string) => apiClient.post<BackupSummary>('/api/backups', { note }),
  audit: (params: { limit?: number; operation?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.operation) query.set('operation', params.operation);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return apiClient.get<{ events: AuditSummary[] }>(`/api/audit${suffix}`);
  },
  recordHistory: (id: RecordId, limit = 50) =>
    apiClient.get<{ events: AuditSummary[] }>(`${recordPath(id)}/history?limit=${limit}`),
  reportInfo: (id: RecordId) =>
    apiClient.get<{ state: 'attached' | 'no-report' | 'unavailable'; report: ReportSummary | null }>(
      `${recordPath(id)}/report-info`,
    ),
  reportUrl: (id: RecordId) => `${recordPath(id)}/report`,
  attachReport: (id: RecordId, file: File) =>
    apiClient.upload<{ report: ReportSummary }>(`${recordPath(id)}/report`, file.name, file),
  unlinkReport: (id: RecordId) => apiClient.delete<{ unlinked: boolean; retainedFileName: string }>(`${recordPath(id)}/report`),
};

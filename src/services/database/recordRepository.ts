import type { DefectRecord, RecordId } from '../../models/defect-record';
import type { ImportHistoryEntry } from '../../models/import-history';
import { DatabaseOperationError, type DatabaseStoreName, IndexedDbDatabase } from './database';

export type RecordChange =
  | { kind: 'insert'; record: DefectRecord }
  | { kind: 'update'; record: DefectRecord };

export class RecordAlreadyExistsError extends Error {
  constructor(id: RecordId) {
    super(`A record with id "${String(id)}" already exists.`);
    this.name = 'RecordAlreadyExistsError';
  }
}

export class RecordNotFoundError extends Error {
  constructor(id: RecordId) {
    super(`Record "${String(id)}" was not found.`);
    this.name = 'RecordNotFoundError';
  }
}

export interface SeedResult {
  seeded: number;
  skippedExistingIds: number;
  alreadyInitialized: boolean;
}

interface MetadataEntry {
  key: string;
  value: unknown;
  updatedAt: string;
}

const SEED_MARKER_KEY = 'legacy-base-data-v1';

function requestFailure(error: DOMException | null, operation: string): DatabaseOperationError {
  return new DatabaseOperationError(`${operation} failed.`, { cause: error ?? undefined });
}

/**
 * The persistence surface the record and import services depend on. The authoritative
 * Node/SQLite server implements the same shape, so the approved business behavior is
 * shared by both runtimes.
 */
export interface RecordStore {
  getAllRecords(): Promise<DefectRecord[]>;
  getRecord(id: RecordId): Promise<DefectRecord | undefined>;
  addRecord(record: DefectRecord): Promise<void>;
  updateRecord(id: RecordId, record: DefectRecord): Promise<DefectRecord>;
  deleteRecord(id: RecordId): Promise<void>;
  bulkUpsert(changes: readonly RecordChange[]): Promise<void>;
  commitImport(changes: readonly RecordChange[], history: ImportHistoryEntry): Promise<void>;
  getImportHistory(): Promise<ImportHistoryEntry[]>;
  initializeFromSeed(seedRecords: readonly DefectRecord[]): Promise<SeedResult>;
  clearImportedData(seedRecords: readonly DefectRecord[]): Promise<{ removed: number }>;
}

export class RecordRepository implements RecordStore {
  constructor(private readonly database: IndexedDbDatabase) {}

  async getAllRecords(): Promise<DefectRecord[]> {
    return this.database.transaction('records', 'readonly', (transaction, setResult, fail) => {
      const request = transaction.objectStore('records').getAll();
      request.onsuccess = () => setResult(request.result as DefectRecord[]);
      request.onerror = () => fail(requestFailure(request.error, 'Reading all records'));
    });
  }

  async getRecord(id: RecordId): Promise<DefectRecord | undefined> {
    return this.database.transaction('records', 'readonly', (transaction, setResult, fail) => {
      const request = transaction.objectStore('records').get(id);
      request.onsuccess = () => setResult(request.result as DefectRecord | undefined);
      request.onerror = () => fail(requestFailure(request.error, `Reading record ${String(id)}`));
    });
  }

  async addRecord(record: DefectRecord): Promise<void> {
    await this.database.transaction('records', 'readwrite', (transaction, setResult, fail) => {
      const request = transaction.objectStore('records').add(record);
      request.onsuccess = () => setResult(undefined);
      request.onerror = () => {
        if (request.error?.name === 'ConstraintError') fail(new RecordAlreadyExistsError(record.id));
        else fail(requestFailure(request.error, `Adding record ${String(record.id)}`));
      };
    });
  }

  async updateRecord(id: RecordId, record: DefectRecord): Promise<DefectRecord> {
    if (record.id !== id) throw new DatabaseOperationError('Record identity cannot be changed during update.');
    return this.database.transaction('records', 'readwrite', (transaction, setResult, fail) => {
      const store = transaction.objectStore('records');
      const read = store.get(id);
      read.onsuccess = () => {
        if (!read.result) {
          fail(new RecordNotFoundError(id));
          return;
        }
        const write = store.put(record);
        write.onsuccess = () => setResult(record);
        write.onerror = () => fail(requestFailure(write.error, `Updating record ${String(id)}`));
      };
      read.onerror = () => fail(requestFailure(read.error, `Reading record ${String(id)} for update`));
    });
  }

  async deleteRecord(id: RecordId): Promise<void> {
    await this.database.transaction('records', 'readwrite', (transaction, setResult, fail) => {
      const store = transaction.objectStore('records');
      const read = store.get(id);
      read.onsuccess = () => {
        if (!read.result) {
          fail(new RecordNotFoundError(id));
          return;
        }
        const deletion = store.delete(id);
        deletion.onsuccess = () => setResult(undefined);
        deletion.onerror = () => fail(requestFailure(deletion.error, `Deleting record ${String(id)}`));
      };
      read.onerror = () => fail(requestFailure(read.error, `Reading record ${String(id)} before delete`));
    });
  }

  async bulkUpsert(changes: readonly RecordChange[]): Promise<void> {
    await this.commitChanges(changes);
  }

  /** Atomically writes record changes and the matching import audit entry. */
  async commitImport(
    changes: readonly RecordChange[],
    history: ImportHistoryEntry,
  ): Promise<void> {
    await this.commitChanges(changes, history);
  }

  async getImportHistory(): Promise<ImportHistoryEntry[]> {
    return this.database.transaction('importHistory', 'readonly', (transaction, setResult, fail) => {
      const request = transaction.objectStore('importHistory').getAll();
      request.onsuccess = () => {
        const entries = request.result as ImportHistoryEntry[];
        setResult(entries.sort((left, right) => right.importedAt.localeCompare(left.importedAt)));
      };
      request.onerror = () => fail(requestFailure(request.error, 'Reading import history'));
    });
  }

  async initializeFromSeed(seedRecords: readonly DefectRecord[]): Promise<SeedResult> {
    const marker: MetadataEntry = {
      key: SEED_MARKER_KEY,
      value: 1,
      updatedAt: new Date().toISOString(),
    };
    const stores: readonly DatabaseStoreName[] = ['records', 'metadata'];

    return this.database.transaction(stores, 'readwrite', (transaction, setResult, fail) => {
      const recordStore = transaction.objectStore('records');
      const metadataStore = transaction.objectStore('metadata');
      const markerRequest = metadataStore.get(SEED_MARKER_KEY);
      const recordsRequest = recordStore.getAll();
      let markerReady = false;
      let recordsReady = false;
      let markerValue: MetadataEntry | undefined;
      let currentRecords: DefectRecord[] = [];
      let finished = false;

      const seedWhenReady = () => {
        if (!markerReady || !recordsReady || finished) return;
        finished = true;
        if (markerValue) {
          setResult({ seeded: 0, skippedExistingIds: 0, alreadyInitialized: true });
          return;
        }

        const existingIds = new Set(currentRecords.map((record) => `${typeof record.id}:${String(record.id)}`));
        let seeded = 0;
        let skippedExistingIds = 0;
        for (const record of seedRecords) {
          const idKey = `${typeof record.id}:${String(record.id)}`;
          if (existingIds.has(idKey)) {
            skippedExistingIds += 1;
            continue;
          }
          recordStore.add(record);
          existingIds.add(idKey);
          seeded += 1;
        }
        metadataStore.put(marker);
        setResult({ seeded, skippedExistingIds, alreadyInitialized: false });
      };

      markerRequest.onsuccess = () => {
        markerValue = markerRequest.result as MetadataEntry | undefined;
        markerReady = true;
        seedWhenReady();
      };
      markerRequest.onerror = () => fail(requestFailure(markerRequest.error, 'Reading legacy seed marker'));
      recordsRequest.onsuccess = () => {
        currentRecords = recordsRequest.result as DefectRecord[];
        recordsReady = true;
        seedWhenReady();
      };
      recordsRequest.onerror = () => fail(requestFailure(recordsRequest.error, 'Checking existing records before seed'));
    });
  }

  /** Explicitly restores the immutable seed and removes local records/history in one transaction. */
  async clearImportedData(seedRecords: readonly DefectRecord[]): Promise<{ removed: number }> {
    const stores: readonly DatabaseStoreName[] = ['records', 'importHistory'];
    return this.database.transaction(stores, 'readwrite', (transaction, setResult, fail) => {
      const recordStore = transaction.objectStore('records');
      const historyStore = transaction.objectStore('importHistory');
      const request = recordStore.getAll();
      request.onsuccess = () => {
        const current = request.result as DefectRecord[];
        const seedById = new Map(seedRecords.map((record) => [`${typeof record.id}:${String(record.id)}`, record]));
        let removed = 0;

        for (const record of current) {
          const key = `${typeof record.id}:${String(record.id)}`;
          if (record.recordSource === 'legacy-seed' && seedById.has(key)) {
            recordStore.put(seedById.get(key)!);
            seedById.delete(key);
          } else {
            recordStore.delete(record.id);
            removed += 1;
          }
        }
        for (const seed of seedById.values()) recordStore.add(seed);
        historyStore.clear();
        setResult({ removed });
      };
      request.onerror = () => fail(requestFailure(request.error, 'Reading records before clearing imported data'));
    });
  }

  private async commitChanges(
    changes: readonly RecordChange[],
    history?: ImportHistoryEntry,
  ): Promise<void> {
    const stores: readonly DatabaseStoreName[] = history
      ? ['records', 'importHistory']
      : ['records'];

    await this.database.transaction(stores, 'readwrite', (transaction, setResult, fail) => {
      const recordStore = transaction.objectStore('records');
      const currentRequest = recordStore.getAll();
      currentRequest.onsuccess = () => {
        const existing = new Map(
          (currentRequest.result as DefectRecord[]).map((record) => [
            `${typeof record.id}:${String(record.id)}`,
            record,
          ]),
        );
        const touched = new Set<string>();

        for (const change of changes) {
          const key = `${typeof change.record.id}:${String(change.record.id)}`;
          if (touched.has(key)) {
            fail(new DatabaseOperationError(`A batch contains more than one write for record id "${String(change.record.id)}".`));
            return;
          }
          touched.add(key);

          if (change.kind === 'insert') {
            if (existing.has(key)) {
              fail(new RecordAlreadyExistsError(change.record.id));
              return;
            }
            existing.set(key, change.record);
            recordStore.add(change.record);
          } else {
            if (!existing.has(key)) {
              fail(new RecordNotFoundError(change.record.id));
              return;
            }
            existing.set(key, change.record);
            recordStore.put(change.record);
          }
        }

        if (history) {
          const historyStore = transaction.objectStore('importHistory');
          const historyWrite = historyStore.add(history);
          historyWrite.onerror = () => {
            if (historyWrite.error?.name === 'ConstraintError') {
              fail(new DatabaseOperationError(`Import history id "${history.id}" already exists.`));
            } else {
              fail(requestFailure(historyWrite.error, 'Writing import history'));
            }
          };
        }
        setResult(undefined);
      };
      currentRequest.onerror = () => fail(requestFailure(currentRequest.error, 'Reading records before bulk upsert'));
    });
  }
}

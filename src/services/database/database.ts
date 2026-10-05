export const DATABASE_NAME = 'tnp-defect-management-dev';
export const DATABASE_VERSION = 1;

export const DATABASE_STORES = ['records', 'importHistory', 'metadata'] as const;
export type DatabaseStoreName = (typeof DATABASE_STORES)[number];
export type TransactionMode = IDBTransactionMode;

type TransactionSetup<T> = (
  transaction: IDBTransaction,
  setResult: (value: T) => void,
  fail: (reason: unknown) => void,
) => void;

export class DatabaseOperationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseOperationError';
  }
}

export class IndexedDbDatabase {
  private opening: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly options: {
      name?: string;
      version?: number;
      factory?: IDBFactory;
    } = {},
  ) {}

  open(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;

    const factory = this.options.factory ?? globalThis.indexedDB;
    if (!factory) {
      return Promise.reject(new DatabaseOperationError('IndexedDB is unavailable in this browser.'));
    }

    const name = this.options.name ?? DATABASE_NAME;
    const version = this.options.version ?? DATABASE_VERSION;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(name, version);
      } catch (error) {
        reject(new DatabaseOperationError(`Could not open database "${name}".`, { cause: error }));
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: 'id' });
          store.createIndex('byRecordSource', 'recordSource', { unique: false });
          store.createIndex('byManagementNumber', 'mgmtNo', { unique: false });
        }
        if (!db.objectStoreNames.contains('importHistory')) {
          const store = db.createObjectStore('importHistory', { keyPath: 'id' });
          store.createIndex('byImportedAt', 'importedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
        }
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(new DatabaseOperationError(`Opening database "${name}" is blocked by another open version.`));
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(new DatabaseOperationError(`Could not open database "${name}".`, { cause: request.error }));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        db.onversionchange = () => {
          db.close();
          this.opening = null;
        };
        resolve(db);
      };
    });

    this.opening = opening;
    void opening.catch(() => {
      if (this.opening === opening) this.opening = null;
    });
    return opening;
  }

  async transaction<T>(
    stores: DatabaseStoreName | readonly DatabaseStoreName[],
    mode: TransactionMode,
    setup: TransactionSetup<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(typeof stores === 'string' ? [stores] : [...stores], mode);
      } catch (error) {
        reject(new DatabaseOperationError('Could not start the IndexedDB transaction.', { cause: error }));
        return;
      }

      let settled = false;
      let hasResult = false;
      let result: T;
      const rejectOnce = (reason: unknown) => {
        if (settled) return;
        settled = true;
        reject(reason instanceof Error ? reason : new DatabaseOperationError('IndexedDB transaction failed.', { cause: reason }));
      };

      transaction.oncomplete = () => {
        if (settled) return;
        if (!hasResult) {
          rejectOnce(new DatabaseOperationError('IndexedDB transaction completed without a result.'));
          return;
        }
        settled = true;
        resolve(result);
      };
      transaction.onerror = () => {
        rejectOnce(new DatabaseOperationError('IndexedDB transaction failed.', { cause: transaction.error }));
      };
      transaction.onabort = () => {
        rejectOnce(new DatabaseOperationError('IndexedDB transaction was aborted.', { cause: transaction.error }));
      };

      const setResult = (value: T) => {
        result = value;
        hasResult = true;
      };
      const fail = (reason: unknown) => {
        rejectOnce(reason instanceof Error ? reason : new DatabaseOperationError('IndexedDB request failed.', { cause: reason }));
        try {
          transaction.abort();
        } catch {
          // The transaction can already be completing after the original rejection.
        }
      };

      try {
        setup(transaction, setResult, fail);
      } catch (error) {
        fail(new DatabaseOperationError('Could not schedule IndexedDB requests.', { cause: error }));
      }
    });
  }

  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = null;
    if (opening) {
      const db = await opening.catch(() => null);
      db?.close();
    }
  }
}

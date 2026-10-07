import { RecordService } from '../services/records/recordService';
import { serverApi, ServerRecordRepository } from '../services/server/serverRecordRepository';
import type { ServerStatus } from '../services/server/serverRecordRepository';
import { ServerImportService } from '../services/server/serverImportService';
import type { SeedResult } from '../services/database/recordRepository';
import type { DefectRecord } from '../models/defect-record';

/**
 * Authoritative runtime wiring: React → API data service → local Node server → SQLite.
 *
 * The browser no longer opens IndexedDB for normal operation. The old IndexedDB modules
 * stay in the tree, isolated, for the explicit one-way migration in
 * `services/server/browserExport`.
 */
export const recordRepository = new ServerRecordRepository();
export const recordService = new RecordService(recordRepository);
export const importService = new ServerImportService();

export interface InitialData {
  seed: SeedResult;
  records: DefectRecord[];
  status: ServerStatus;
}

let initializationPromise: Promise<InitialData> | null = null;

async function loadInitialData(): Promise<InitialData> {
  // The server seeds and migrates its own database at startup, so the browser only reads
  // the result. A fresh database receives exactly the canonical 191 records there.
  const bootstrap = await serverApi.bootstrap();
  const records = await recordService.getAllRecords();
  return { seed: bootstrap.seed, records, status: bootstrap.status };
}

export function initializeDevelopmentData(): Promise<InitialData> {
  // React StrictMode may run effects twice in development; share one bootstrap request.
  initializationPromise ??= loadInitialData();
  return initializationPromise;
}

export { serverApi };

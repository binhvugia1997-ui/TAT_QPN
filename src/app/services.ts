import legacyBaseData from '../data/legacy-base-data.json';
import { IndexedDbDatabase } from '../services/database/database';
import { RecordRepository } from '../services/database/recordRepository';
import { ImportService } from '../services/import/importService';
import { RecordService } from '../services/records/recordService';

const database = new IndexedDbDatabase();
export const recordRepository = new RecordRepository(database);
export const recordService = new RecordService(recordRepository);
export const importService = new ImportService(recordRepository);

let initializationPromise: ReturnType<typeof loadInitialData> | null = null;

async function loadInitialData() {
  const seed = await recordService.seedLegacyBase(legacyBaseData as unknown as Record<string, unknown>[]);
  const records = await recordService.getAllRecords();
  return { seed, records };
}

export function initializeDevelopmentData() {
  // React StrictMode may run effects twice in development; share one idempotent DB bootstrap.
  initializationPromise ??= loadInitialData();
  return initializationPromise;
}

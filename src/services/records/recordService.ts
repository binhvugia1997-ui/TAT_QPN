import { findExistingRecord, getRecordFingerprint } from '../../business/duplicate/identity';
import { normalizeDefectRecord, normalizeDefectRecordPatch, assertRecordIdUnchanged } from '../../models/defect-record';
import type { DefectRecord, DefectRecordPatch, RecordId } from '../../models/defect-record';
import { todayDateOnly } from '../../utils/date';
import { createRecordId } from '../../utils/id';
import {
  RecordAlreadyExistsError,
  RecordNotFoundError,
  type RecordStore,
  type SeedResult,
} from '../database/recordRepository';

export class DuplicateRecordError extends Error {
  constructor(readonly existingId: RecordId, readonly fingerprint: string) {
    super(`A record with the same identity already exists (record ${String(existingId)}).`);
    this.name = 'DuplicateRecordError';
  }
}

export class DestructiveConfirmationRequiredError extends Error {
  constructor(operation: string) {
    super(`Explicit confirmation is required before ${operation}.`);
    this.name = 'DestructiveConfirmationRequiredError';
  }
}

function nullableInput(input: Record<string, unknown>, field: string): unknown {
  const value = input[field];
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

/**
 * Shared with the Node/SQLite server so a record created through the API gets exactly the
 * same defaults as one created in the browser.
 */
export function buildManualRecord(input: Record<string, unknown>): DefectRecord {
  const id = input.id ?? createRecordId('n');
  const rawManagementNumber = typeof input.mgmtNo === 'string' ? input.mgmtNo.trim() : '';
  const managementNumber = rawManagementNumber || `NEW-${String(id).slice(-6)}`;
  const plant = typeof input.plant === 'string' ? input.plant.trim() : '';
  const rawStatus = typeof input.status === 'string' ? input.status.trim() : '';
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '(untitled defect)';

  const legacyDefaults: Record<string, unknown> = {
    id,
    no: '',
    mgmtNo: managementNumber,
    registeredDate: input.registeredDate || todayDateOnly(),
    writtenBy: '',
    status: rawStatus || 'Đợi đối sách',
    plant,
    title,
    occurPlace: typeof input.occurPlace === 'string' ? input.occurPlace.trim() : '',
    supplier: '',
    vendorGroup: '',
    partCode: typeof input.partCode === 'string' ? input.partCode.trim() : '',
    partName: typeof input.partName === 'string' ? input.partName.trim() : '',
    partGroup: typeof input.partGroup === 'string' ? input.partGroup.trim() : '',
    project: typeof input.project === 'string' ? input.project.trim() : '',
    model: typeof input.model === 'string' ? input.model.trim() : '',
    defectDetails: typeof input.defectDetails === 'string' ? input.defectDetails.trim() : '',
    sampleQty: nullableInput(input, 'sampleQty'),
    defectQty: nullableInput(input, 'defectQty'),
    defectRate: null,
    reason1: nullableInput(input, 'reason1'),
    reason2: null,
    inspector: typeof input.inspector === 'string' ? input.inspector.trim() : '',
    approver: null,
    approvalDate: null,
    issueYN: null,
    claimYN: null,
    reoccur3M: null,
    dueDate: nullableInput(input, 'dueDate'),
    completedDate: null,
    tatDays: null,
    tatCompliance: null,
    transactionType: null,
    locatedCorp: plant,
    recordSource: 'manual',
  };

  return normalizeDefectRecord({ ...input, ...legacyDefaults, id, mgmtNo: managementNumber }, 'manual');
}

export class RecordService {
  constructor(private readonly repository: RecordStore) {}

  getAllRecords(): Promise<DefectRecord[]> {
    return this.repository.getAllRecords();
  }

  getRecord(id: RecordId): Promise<DefectRecord | undefined> {
    return this.repository.getRecord(id);
  }

  async seedLegacyBase(rawSeedRecords: readonly Record<string, unknown>[]): Promise<SeedResult> {
    const seedRecords = rawSeedRecords.map((record) => normalizeDefectRecord(record, 'legacy-seed'));
    return this.repository.initializeFromSeed(seedRecords);
  }

  async addRecord(input: Record<string, unknown>): Promise<DefectRecord> {
    const record = buildManualRecord(input);
    const existing = findExistingRecord(record, await this.repository.getAllRecords());
    if (existing) throw new DuplicateRecordError(existing.id, getRecordFingerprint(record));
    await this.repository.addRecord(record);
    return record;
  }

  async updateRecord(id: RecordId, rawPatch: Record<string, unknown>): Promise<DefectRecord> {
    assertRecordIdUnchanged(id, rawPatch);
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'recordSource')) {
      throw new TypeError('Record provenance cannot be changed by an edit.');
    }
    const existing = await this.repository.getRecord(id);
    if (!existing) throw new RecordNotFoundError(id);
    const patch = normalizeDefectRecordPatch(rawPatch) as DefectRecordPatch;
    const updated = normalizeDefectRecord(
      { ...existing, ...patch, id: existing.id, recordSource: existing.recordSource },
      existing.recordSource,
    );
    const collision = findExistingRecord(
      updated,
      (await this.repository.getAllRecords()).filter((record) => record.id !== existing.id),
    );
    if (collision) throw new DuplicateRecordError(collision.id, getRecordFingerprint(updated));
    return this.repository.updateRecord(id, updated);
  }

  async deleteRecord(id: RecordId, options: { confirmed: boolean }): Promise<void> {
    if (!options.confirmed) throw new DestructiveConfirmationRequiredError('deleting a defect record');
    await this.repository.deleteRecord(id);
  }

  async clearImportedData(
    rawSeedRecords: readonly Record<string, unknown>[],
    options: { confirmed: boolean },
  ): Promise<{ removed: number }> {
    if (!options.confirmed) throw new DestructiveConfirmationRequiredError('clearing imported and edited data');
    const seedRecords = rawSeedRecords.map((record) => normalizeDefectRecord(record, 'legacy-seed'));
    return this.repository.clearImportedData(seedRecords);
  }
}

export { RecordAlreadyExistsError, RecordNotFoundError };

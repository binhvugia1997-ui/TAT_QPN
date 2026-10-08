import { normalizeDateOnly, type DateOnly } from '../utils/date';

export type RecordId = string | number;
export type RecordSource = 'legacy-seed' | 'import' | 'manual';
export type NullableString = string | null;

/** Canonical record shape: all fields found in BASE_DATA, import mappings and legacy UI edits. */
export interface DefectRecord {
  id: RecordId;
  recordSource: RecordSource;
  no?: NullableString;
  mgmtNo: string;
  registeredDate?: DateOnly | null;
  writtenBy?: NullableString;
  status: string;
  plant?: NullableString;
  title?: NullableString;
  occurPlace?: NullableString;
  supplier?: NullableString;
  vendorGroup?: NullableString;
  vCode?: NullableString;
  vendorSub?: NullableString;
  partCode?: NullableString;
  partName?: NullableString;
  partGroup?: NullableString;
  mainCategory?: NullableString;
  project?: NullableString;
  model?: NullableString;
  defectDetails?: NullableString;
  /**
   * App-managed "Tên lỗi" shown and edited in the Records table.
   *
   * Deliberately separate from the imported `defectDetails`, which is the TNP source value
   * and stays untouched. This field is never produced by the header mapping and is not part
   * of the existing-record import whitelist, so an Excel re-import can never overwrite it.
   */
  manualDefectName?: NullableString;
  /**
   * App-managed "Tình trạng" shown and edited in the Records table.
   *
   * Deliberately separate from the canonical `status`, which is the TNP Approval value and
   * drives the Completed and Rejected scopes, TAT and import synchronisation. Editing this
   * field cannot move a record between those views. It is not produced by the header mapping
   * and is not part of the existing-record import whitelist, so an Excel re-import can never
   * overwrite it. No database column is added for it: like every app-managed value it lives
   * inside the record payload.
   */
  manualCondition?: NullableString;
  sampleQty?: number | null;
  defectQty?: number | null;
  defectRate?: number | null;
  reason1?: NullableString;
  reason2?: NullableString;
  inspector?: NullableString;
  approver?: NullableString;
  approvalDate?: DateOnly | null;
  auditDate?: DateOnly | null;
  issueYN?: NullableString;
  issueReason?: NullableString;
  claimYN?: NullableString;
  partsProblem?: NullableString;
  reoccur3M?: NullableString;
  systemQtr?: NullableString;
  inputStop?: NullableString;
  effectivenessVerification?: NullableString;
  sqciPlmNo?: NullableString;
  plmCountermeasure?: NullableString;
  sourceRemarks?: NullableString;
  initialDueDate?: DateOnly | null;
  initialCompletedDate?: DateOnly | null;
  initialTatCompliance?: NullableString;
  vendorApprovalDate?: DateOnly | null;
  usedMember?: NullableString;
  dueDate?: DateOnly | null;
  completedDate?: DateOnly | null;
  tatDays?: number | null;
  tatCompliance?: NullableString;
  transactionType?: NullableString;
  locatedCorp?: NullableString;
  mqisCode?: NullableString;
  pic?: NullableString;
  caFileLink?: NullableString;
  notes?: NullableString;
  /** Unknown import columns retained verbatim for new records instead of being discarded. */
  sourceExtras?: Record<string, unknown>;
  /** Keep additional source columns losslessly even before a screen uses them. */
  [extensionField: string]: unknown;
}

export type DefectRecordPatch = Partial<Omit<DefectRecord, 'id' | 'recordSource'>> & {
  [extensionField: string]: unknown;
};

const DATE_FIELDS = new Set([
  'registeredDate',
  'approvalDate',
  'auditDate',
  'initialDueDate',
  'initialCompletedDate',
  'vendorApprovalDate',
  'dueDate',
  'completedDate',
]);
const NUMERIC_FIELDS = new Set(['sampleQty', 'defectQty', 'defectRate', 'tatDays']);
const STRING_FIELDS = new Set([
  'no',
  'mgmtNo',
  'writtenBy',
  'status',
  'plant',
  'title',
  'occurPlace',
  'supplier',
  'vendorGroup',
  'vCode',
  'vendorSub',
  'partCode',
  'partName',
  'partGroup',
  'mainCategory',
  'project',
  'model',
  'defectDetails',
  'manualDefectName',
  'manualCondition',
  'reason1',
  'reason2',
  'inspector',
  'approver',
  'issueYN',
  'issueReason',
  'claimYN',
  'partsProblem',
  'reoccur3M',
  'systemQtr',
  'inputStop',
  'effectivenessVerification',
  'sqciPlmNo',
  'plmCountermeasure',
  'sourceRemarks',
  'initialTatCompliance',
  'tatCompliance',
  'transactionType',
  'locatedCorp',
  'mqisCode',
  'pic',
  'caFileLink',
  'notes',
]);

export class RecordNormalizationError extends Error {
  constructor(
    message: string,
    readonly field: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RecordNormalizationError';
  }
}

function normalizeString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new RecordNormalizationError(`Expected text for ${field}.`, field);
}

function normalizeNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RecordNormalizationError(`Expected a finite number for ${field}.`, field);
    return value;
  }

  let text = String(value).trim();
  if (!text) return null;
  if (text.endsWith('%')) text = text.slice(0, -1).trim();
  if (!text) return null;
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(text)) text = text.replaceAll(',', '');
  const number = Number(text);
  if (!Number.isFinite(number)) {
    throw new RecordNormalizationError(`Expected a finite number for ${field}.`, field);
  }
  return number;
}

/** Normalize only keys actually present; import patches must not invent blanks for absent columns. */
export function normalizeDefectRecordPatch(input: Record<string, unknown>): DefectRecordPatch {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === 'id' || field === 'recordSource' || value === undefined) continue;
    try {
      let normalizedValue: unknown;
      if (DATE_FIELDS.has(field)) normalizedValue = normalizeDateOnly(value, field);
      else if (NUMERIC_FIELDS.has(field)) normalizedValue = normalizeNumber(value, field);
      else if (STRING_FIELDS.has(field)) normalizedValue = normalizeString(value, field);
      else normalizedValue = value;
      Object.defineProperty(patch, field, {
        value: normalizedValue,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch (error) {
      if (error instanceof RecordNormalizationError) throw error;
      throw new RecordNormalizationError(`Could not normalize ${field}.`, field, { cause: error });
    }
  }
  return patch as DefectRecordPatch;
}

function isRecordSource(value: unknown): value is RecordSource {
  return value === 'legacy-seed' || value === 'import' || value === 'manual';
}

export function normalizeDefectRecord(
  input: Record<string, unknown>,
  sourceOverride?: RecordSource,
): DefectRecord {
  const id = input.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || id === '') {
    throw new RecordNormalizationError('A record must have a non-empty string or numeric id.', 'id');
  }
  if (typeof id === 'number' && !Number.isFinite(id)) {
    throw new RecordNormalizationError('A numeric id must be finite.', 'id');
  }

  const patch = normalizeDefectRecordPatch(input);
  const mgmtNo = normalizeString(input.mgmtNo, 'mgmtNo') ?? '';
  const status = normalizeString(input.status, 'status') ?? '';
  const recordSource = sourceOverride ?? (isRecordSource(input.recordSource) ? input.recordSource : 'manual');
  return {
    ...patch,
    id,
    mgmtNo,
    status,
    recordSource,
  } as DefectRecord;
}

export function assertRecordIdUnchanged(id: RecordId, patch: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== id) {
    throw new RecordNormalizationError('Record identity cannot be changed.', 'id');
  }
}

/**
 * The Management Number is the key a record is matched on when data is imported
 * (`getRecordFingerprint`), so for a record that already exists it is not an editable field.
 * Renaming it detaches the record from its own source row: the next import of that row no longer
 * finds it and is inserted as a second record, with the local corrections stranded behind.
 *
 * An update may still *carry* `mgmtNo`, because full-record writers (the repository layer, and any
 * older client) send every field on every save. A carried copy that matches what is stored is
 * therefore dropped from the patch rather than written: the stored bytes, including any leading
 * zero or spacing the source system produced, are never rewritten. Only a real change is refused,
 * so this cannot break a client that round-trips the whole record.
 *
 * Returns the patch to apply. Throwing `RecordNormalizationError` is deliberate: the HTTP layer
 * already maps that to 400 with the field name, so the rejection is machine-readable too.
 */
export function assertManagementNumberUnchanged(
  existing: { mgmtNo?: unknown },
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(patch, 'mgmtNo')) return patch;

  const incoming = (normalizeString(patch.mgmtNo, 'mgmtNo') ?? '').trim();
  const stored = (normalizeString(existing.mgmtNo, 'mgmtNo') ?? '').trim();
  if (incoming === stored) {
    const safe: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (field === 'mgmtNo') continue;
      safe[field] = value;
    }
    return safe;
  }

  throw new RecordNormalizationError(
    'The Management Number identifies this record to the import and cannot be changed. '
    + 'Editing it would leave the record unmatched, so the next import of the same row would create '
    + 'a duplicate; correct the number in the source system instead.',
    'mgmtNo',
  );
}

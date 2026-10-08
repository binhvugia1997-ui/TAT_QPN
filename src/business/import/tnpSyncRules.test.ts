import { describe, expect, it } from 'vitest';
import {
  buildTnpSyncPatch,
  getImportIdentityCandidate,
  IMPORT_IDENTITY_FIELDS,
  TNP_SYNC_FIELDS,
} from './tnpSyncRules';
import { TNP_IMPORT_HEADER_MAP } from '../../services/import/headerMapping';
import { getRecordFingerprint } from '../duplicate/identity';
import type { DefectRecord } from '../../models/defect-record';

/**
 * The manual "Tên lỗi" value is typed by an operator in the Records table. It has to survive
 * every later Excel import, so these tests pin the three places an import could otherwise
 * reach it: the existing-record whitelist, the header map that feeds new records, and the
 * duplicate-identity key.
 */

const existing = (overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id: 7,
  recordSource: 'import',
  mgmtNo: 'TNP-0007',
  status: 'Đợi đối sách',
  registeredDate: '2026-10-01',
  plant: 'TNP',
  title: 'Body scratch',
  dueDate: '2026-10-15',
  defectDetails: 'Scratch on left panel',
  manualDefectName: 'Typed by the operator',
  ...overrides,
});

describe('TNP import never touches the manual defect name', () => {
  it('keeps the existing-record whitelist at exactly status and dueDate', () => {
    expect([...TNP_SYNC_FIELDS]).toEqual(['status', 'dueDate']);
    expect(TNP_SYNC_FIELDS).not.toContain('manualDefectName');
    expect(TNP_SYNC_FIELDS).not.toContain('defectDetails');
  });

  it('drops a manual defect name carried in by the file', () => {
    const patch = buildTnpSyncPatch(existing(), {
      mgmtNo: 'TNP-0007',
      status: 'Hoàn thành',
      dueDate: '2026-10-20',
      manualDefectName: 'From the spreadsheet',
      defectDetails: 'Overwritten source text',
    });

    // Only the two whitelisted fields come through.
    expect(patch).toEqual({ status: 'Hoàn thành', dueDate: '2026-10-20' });
    expect(patch).not.toHaveProperty('manualDefectName');
    expect(patch).not.toHaveProperty('defectDetails');
  });

  it('reports no change at all when only the manual field differs', () => {
    const patch = buildTnpSyncPatch(existing(), {
      mgmtNo: 'TNP-0007',
      status: 'Đợi đối sách',
      dueDate: '2026-10-15',
      manualDefectName: 'Something else entirely',
    });

    // An unchanged whitelist means the record is not even counted as UPDATED.
    expect(patch).toEqual({});
  });

  it('has no Excel header that maps onto the manual field, so a new record starts blank', () => {
    const targets = Object.values(TNP_IMPORT_HEADER_MAP);

    expect(targets).not.toContain('manualDefectName');
    // The imported source column keeps going to defectDetails, a different field.
    expect(targets).toContain('defectDetails');
  });

  it('keeps the manual field out of the duplicate-identity key', () => {
    expect(IMPORT_IDENTITY_FIELDS).not.toContain('manualDefectName');
    expect(getImportIdentityCandidate({ manualDefectName: 'Typed' })).toEqual({});

    // Editing it cannot make a record look like a different record.
    const before = existing();
    expect(getRecordFingerprint({ ...before, manualDefectName: 'Edited' }))
      .toBe(getRecordFingerprint(before));
  });
});

import { describe, expect, it } from 'vitest';
import { findExistingRecord, getRecordFingerprint } from './identity';
import type { DefectRecord } from '../../models/defect-record';

const base = (overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id: 1,
  recordSource: 'legacy-seed',
  mgmtNo: 'TNP-100',
  status: 'Đợi đối sách',
  registeredDate: '2026-10-01',
  plant: 'SEV',
  partCode: 'PART-1',
  title: 'Surface scratch',
  defectQty: 2,
  ...overrides,
});

describe('legacy record identity', () => {
  it('matches by normalized management number first', () => {
    const existing = base({ mgmtNo: '  TNP-100 ' });
    const incoming = base({ id: 'imported', mgmtNo: 'tnp-100', title: 'Updated title' });
    expect(getRecordFingerprint(existing)).toBe('mn:tnp-100');
    expect(findExistingRecord(incoming, [existing])).toBe(existing);
  });

  it('does not match when non-empty management numbers differ, even if fallback fields match', () => {
    const existing = base({ mgmtNo: 'TNP-100' });
    const incoming = base({ id: 'other', mgmtNo: 'TNP-101' });
    expect(findExistingRecord(incoming, [existing])).toBeUndefined();
  });

  it('uses the same fallback fingerprint when management number is blank', () => {
    const existing = base({ mgmtNo: '' });
    const incoming = base({
      id: 'imported',
      mgmtNo: '   ',
      registeredDate: '2026-10-01',
      plant: 'sev',
      partCode: 'part-1',
      title: 'surface scratch',
      defectQty: 2,
    });
    expect(getRecordFingerprint(existing)).toBe('fp|2026-10-01|sev|part-1|surface scratch|2');
    expect(findExistingRecord(incoming, [existing])).toBe(existing);
  });

  it('does not match blank-management records with a different fallback field', () => {
    const existing = base({ mgmtNo: '' });
    const incoming = base({ id: 'other', mgmtNo: '', defectQty: 3 });
    expect(findExistingRecord(incoming, [existing])).toBeUndefined();
  });

  it('keeps legacy last-entry-wins behavior if the input set already contains a collision', () => {
    const earlier = base({ id: 1, mgmtNo: 'TNP-100' });
    const later = base({ id: 2, mgmtNo: 'tnp-100' });
    expect(findExistingRecord(base({ mgmtNo: 'TNP-100' }), [earlier, later])).toBe(later);
  });
});

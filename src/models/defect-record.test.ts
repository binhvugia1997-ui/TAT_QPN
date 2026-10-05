import { describe, expect, it } from 'vitest';
import legacyBaseData from '../data/legacy-base-data.json';
import { normalizeDefectRecord } from './defect-record';

describe('canonical legacy seed model', () => {
  it('retains every BASE_DATA field for all 191 records without mutating the read-only seed', () => {
    const original = JSON.stringify(legacyBaseData);
    const records = legacyBaseData.map((raw) => normalizeDefectRecord(raw, 'legacy-seed'));
    const expectedFields = Object.keys(legacyBaseData[0]);

    expect(records).toHaveLength(191);
    for (const record of records) {
      expect(record.recordSource).toBe('legacy-seed');
      for (const field of expectedFields) expect(record).toHaveProperty(field);
    }
    expect(new Set(records.map((record) => String(record.id))).size).toBe(191);
    expect(JSON.stringify(legacyBaseData)).toBe(original);
  });

  it('normalizes numeric legacy TAT values while preserving the raw string in the seed file', () => {
    const raw = legacyBaseData.find((row) => row.tatDays !== null);
    expect(raw).toBeDefined();
    const normalized = normalizeDefectRecord(raw!, 'legacy-seed');
    expect(typeof raw!.tatDays).toBe('string');
    expect(typeof normalized.tatDays).toBe('number');
  });

  it('normalizes year-first TNP dates and formatted numeric source values', () => {
    const normalized = normalizeDefectRecord({
      id: 'normalized-import',
      mgmtNo: 'NUM-1',
      status: 'Đợi đối sách',
      registeredDate: '2026/10/1',
      dueDate: '2026-10-17',
      defectQty: '1,234',
      defectRate: '2.5%',
    }, 'import');
    expect(normalized.registeredDate).toBe('2026-10-01');
    expect(normalized.defectQty).toBe(1234);
    expect(normalized.defectRate).toBe(2.5);
  });

  it('retains prototype-named extension fields as data without mutating object prototypes', () => {
    const input = JSON.parse('{"id":"proto-extension","mgmtNo":"PROTO-1","status":"Open","__proto__":{"polluted":"no"}}') as Record<string, unknown>;
    const normalized = normalizeDefectRecord(input, 'import');
    expect(Object.prototype.hasOwnProperty.call(normalized, '__proto__')).toBe(true);
    expect((normalized as Record<string, unknown>)['__proto__']).toEqual({ polluted: 'no' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('preserves source extension fields not yet rendered by the UI', () => {
    const normalized = normalizeDefectRecord({
      id: 'source-extension',
      mgmtNo: 'EXT-1',
      status: 'Unknown source status',
      sourceColumnThatHasNoScreen: 'retain this value',
    }, 'import');
    expect(normalized.sourceColumnThatHasNoScreen).toBe('retain this value');
  });
});

import { describe, expect, it } from 'vitest';
import legacyBaseData from '../data/legacy-base-data.json';
import { RecordNormalizationError, assertManagementNumberUnchanged, normalizeDefectRecord } from './defect-record';

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
describe('the management number guard on an existing record', () => {
  it('leaves a patch alone when it does not mention the number', () => {
    const patch = { status: 'Hoàn thành', notes: null };

    expect(assertManagementNumberUnchanged({ mgmtNo: 'A-1' }, patch)).toBe(patch);
  });

  it('drops a carried copy that matches the stored number', () => {
    // The repository layer saves whole records, so `mgmtNo` arrives on every legitimate edit.
    const safe = assertManagementNumberUnchanged({ mgmtNo: 'A-1' }, { mgmtNo: 'A-1', notes: 'x' });

    expect(Object.prototype.hasOwnProperty.call(safe, 'mgmtNo')).toBe(false);
    expect(safe).toEqual({ notes: 'x' });
  });

  it('treats surrounding spacing as the same number and still refuses to write it', () => {
    // The comparison is lenient precisely so the write is not: the padded value must never reach
    // storage, because `mgmtNo` is stored as source text and rendered as-is.
    const safe = assertManagementNumberUnchanged({ mgmtNo: 'A-1' }, { mgmtNo: '  A-1  ' });

    expect(safe).toEqual({});
  });

  it('returns a new object rather than mutating the caller patch', () => {
    const patch = { mgmtNo: 'A-1', notes: 'x' };
    const safe = assertManagementNumberUnchanged({ mgmtNo: 'A-1' }, patch);

    expect(safe).not.toBe(patch);
    expect(patch.mgmtNo).toBe('A-1');
  });

  it('refuses a real change, including a blanking or a case-only rewrite', () => {
    for (const value of ['A-2', '', null, 'a-1-x', undefined]) {
      expect(() => assertManagementNumberUnchanged({ mgmtNo: 'A-1' }, { mgmtNo: value })).toThrow(
        /cannot be changed/u,
      );
    }
  });

  it('reports the field so the HTTP layer can answer with a machine-readable 400', () => {
    let caught: unknown;
    try {
      assertManagementNumberUnchanged({ mgmtNo: 'A-1' }, { mgmtNo: 'A-2' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RecordNormalizationError);
    expect((caught as { field: string }).field).toBe('mgmtNo');
    // The message names the consequence, not just the rule, so an operator can act on it.
    expect((caught as { message: string }).message).toMatch(/duplicate|import/u);
  });

  it('rejects a non-text number the same way the normalizer would', () => {
    expect(() => assertManagementNumberUnchanged({ mgmtNo: 'A-1' }, { mgmtNo: { nested: 1 } })).toThrow(
      /Expected text for mgmtNo/u,
    );
  });

  it('compares against an empty stored number without inventing one', () => {
    // A legacy row can carry a blank number; echoing the blank is not a change.
    expect(assertManagementNumberUnchanged({ mgmtNo: '' }, { mgmtNo: null })).toEqual({});
    expect(assertManagementNumberUnchanged({ mgmtNo: null }, { mgmtNo: '' })).toEqual({});
    expect(() => assertManagementNumberUnchanged({ mgmtNo: undefined }, { mgmtNo: 'B-1' })).toThrow(
      /cannot be changed/u,
    );
  });
});

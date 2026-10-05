import { describe, expect, it } from 'vitest';
import {
  findTnpHeaderRowIndex,
  mapTnpGridToCanonicalRows,
  mapTnpHeader,
  normalizeTnpHeader,
} from './headerMapping';

describe('TNP source header mapping', () => {
  it('normalizes the exact legacy misspelling and maps it to the canonical current TAT field', () => {
    const sourceHeader = 'Reply expeced date for final countermeasure';
    expect(normalizeTnpHeader(`  ${sourceHeader.toUpperCase()}  `))
      .toBe('reply expeced date for final countermeasure');
    expect(mapTnpHeader(sourceHeader)).toBe('dueDate');
  });

  it('maps the exact source header into a normalized canonical TNP row', () => {
    const grid = [
      ['TNP daily export'],
      [
        'Management Number',
        'Approval▼',
        'Reply expeced date for final countermeasure',
        'Registered Date',
        'Plant',
        'Notes',
      ],
      ['TNP-100', 'Rejected (xét)', '2026-10-17', '2026-10-01', 'SEV', 'Local note must not map'],
      [],
    ];

    expect(findTnpHeaderRowIndex(grid)).toBe(1);
    expect(mapTnpGridToCanonicalRows(grid)).toEqual([{
      mgmtNo: 'TNP-100',
      status: 'Rejected (xét)',
      dueDate: '2026-10-17',
      registeredDate: '2026-10-01',
      plant: 'SEV',
    }]);
  });

  it('does not treat JavaScript object prototype keys as valid source headers', () => {
    expect(mapTnpHeader('__proto__')).toBeNull();
    expect(mapTnpHeader('constructor')).toBeNull();
  });

  it('maps first-countermeasure and vendor-approval headers to existing canonical fields', () => {
    expect(mapTnpHeader('Reply expeced date for first countermeasure')).toBe('initialDueDate');
    expect(mapTnpHeader('First Countermeasure input date')).toBe('initialCompletedDate');
    expect(mapTnpHeader('TAT Compliance Y/N')).toBe('initialTatCompliance');
    expect(mapTnpHeader('Vendor classification_approval date.')).toBe('vendorApprovalDate');
    expect(mapTnpHeader('최초대책예정일')).toBe('initialDueDate');
    expect(mapTnpHeader('최초 대책 입력일')).toBe('initialCompletedDate');
    expect(mapTnpHeader('최초tat 준수(y/n)')).toBe('initialTatCompliance');
    expect(mapTnpHeader('업체구분_승락일')).toBe('vendorApprovalDate');
  });

  it('keeps the corrected English spelling and Korean source alias mapped to the same canonical date', () => {
    expect(mapTnpHeader('Reply expected date for final countermeasure')).toBe('dueDate');
    expect(mapTnpHeader('최종대책회답예정일')).toBe('dueDate');
  });
});

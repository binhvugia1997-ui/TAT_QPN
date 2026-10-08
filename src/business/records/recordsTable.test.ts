import { describe, expect, it } from 'vitest';
import type { DefectRecord } from '../../models/defect-record';
import { translate } from '../../i18n';
import {
  canonicalCodeText,
  createReportIndex,
  findAttachedReport,
  getRecordCellSource,
  getVisibleRecordsColumns,
  hasSourceTatDeadline,
  isManualInlineField,
  MANUAL_CONDITION_COLUMN,
  MANUAL_CONDITION_FIELD,
  MANUAL_DEFECT_NAME_COLUMN,
  MANUAL_DEFECT_NAME_FIELD,
  MQIS_COLUMN,
  MQIS_DISPLAY_FIELD,
  REQUIRED_RECORDS_COLUMNS,
} from './recordsTable';
import { naturalTextCompare } from '../../utils/naturalCompare';

const today = '2026-10-11';

const record = (overrides: Partial<DefectRecord> = {}): DefectRecord => ({
  id: 7,
  recordSource: 'legacy-seed',
  mgmtNo: 'TNP-0007',
  status: 'Đợi đối sách',
  registeredDate: '2026-10-01',
  mqisCode: 'MQIS-8891',
  pic: 'Nguyen Van A',
  plant: 'TNP',
  title: 'Body scratch',
  occurPlace: 'Line 3',
  partGroup: 'Welding',
  defectDetails: 'Scratch on left panel',
  dueDate: '2026-10-15',
  ...overrides,
});

describe('approved Records table layout', () => {
  it('lists exactly the 14 approved columns, in the approved order', () => {
    expect(REQUIRED_RECORDS_COLUMNS.map(({ key }) => key)).toEqual([
      'no',
      'mqis',
      'registeredDate',
      'pic',
      'approval',
      'plant',
      'title',
      'occurPlace',
      'partGroup',
      'defectName',
      'condition',
      'qpn',
      'tatSystem',
      'pendingDays',
    ]);
  });

  it('shows the approved header text for every column', () => {
    expect(REQUIRED_RECORDS_COLUMNS.map(({ label }) => translate('en', label))).toEqual([
      'NO',
      'MQIS',
      'Registered Date',
      'PIC',
      'Approval',
      'PLANT',
      'Title',
      'Occur place',
      'Công đoạn quy trách',
      'Tên lỗi',
      'Tình trạng',
      'QPN',
      'TAT Hệ thống',
      'Ngày Pending',
    ]);
  });

  it('keeps the approved header wording identical in every locale', () => {
    for (const { label } of REQUIRED_RECORDS_COLUMNS) {
      expect(translate('vi', label)).toBe(translate('en', label));
      expect(translate('ko', label)).toBe(translate('en', label));
    }
  });

  it('appends the corrective-only CA column after the 14 approved columns', () => {
    expect(getVisibleRecordsColumns({ corrective: false }).map(({ key }) => key))
      .toEqual(REQUIRED_RECORDS_COLUMNS.map(({ key }) => key));
    expect(getVisibleRecordsColumns({ corrective: true }).map(({ key }) => key))
      .toEqual([...REQUIRED_RECORDS_COLUMNS.map(({ key }) => key), 'caLink']);
  });
});

describe('Records cell mappings', () => {
  it('maps each approved column to its confirmed source field', () => {
    expect(getRecordCellSource(record(), 'mqis', today)).toBe('TNP-0007');
    expect(getRecordCellSource(record(), 'registeredDate', today)).toBe('2026-10-01');
    expect(getRecordCellSource(record(), 'pic', today)).toBe('Nguyen Van A');
    expect(getRecordCellSource(record(), 'approval', today)).toBe('Đợi đối sách');
    expect(getRecordCellSource(record(), 'plant', today)).toBe('TNP');
    expect(getRecordCellSource(record(), 'title', today)).toBe('Body scratch');
    expect(getRecordCellSource(record(), 'occurPlace', today)).toBe('Line 3');
    expect(getRecordCellSource(record(), 'partGroup', today)).toBe('Welding');
    expect(getRecordCellSource(record(), 'defectName', today)).toBeNull();
  });

  it('keeps Approval on the original TNP status value, including the Reject state', () => {
    expect(getRecordCellSource(record({ status: 'Rejected (xét)' }), 'approval', today)).toBe('Rejected (xét)');
    expect(getRecordCellSource(record({ status: 'Hoàn thành' }), 'approval', today)).toBe('Hoàn thành');
  });

  it('never sources NO from record data', () => {
    expect(getRecordCellSource(record({ no: '99' }), 'no', today)).toBeNull();
  });

  it('has no source for Tình trạng, so the cell is always the em dash placeholder', () => {
    expect(getRecordCellSource(record(), 'condition', today)).toBeNull();
    // Even a record that carries a plausible-looking extra field must not fill this column.
    expect(getRecordCellSource({ ...record(), condition: 'OK' }, 'condition', today)).toBeNull();
    expect(getRecordCellSource({ ...record(), notes: 'OK' }, 'condition', today)).toBeNull();
  });

  it('renders TAT Hệ thống from the source dueDate and falls back to registeredDate + 7', () => {
    expect(getRecordCellSource(record(), 'tatSystem', today)).toBe('2026-10-15');
    expect(hasSourceTatDeadline(record())).toBe(true);

    const fallback = record({ dueDate: null });
    expect(getRecordCellSource(fallback, 'tatSystem', today)).toBe('2026-10-08');
    expect(hasSourceTatDeadline(fallback)).toBe(false);
  });

  it('renders Ngày Pending from registeredDate only, independent of the TAT deadline', () => {
    expect(getRecordCellSource(record(), 'pendingDays', today)).toBe(-3);
    expect(getRecordCellSource(record({ dueDate: null }), 'pendingDays', today)).toBe(-3);
    expect(getRecordCellSource(record({ dueDate: '2027-01-31' }), 'pendingDays', today)).toBe(-3);
  });

  it('shows the placeholder for blank source text instead of an empty cell', () => {
    expect(getRecordCellSource(record({ mgmtNo: '   ' }), 'mqis', today)).toBeNull();
    expect(getRecordCellSource(record({ manualCondition: '   ' }), 'condition', today)).toBeNull();
    expect(getRecordCellSource(record({ pic: null }), 'pic', today)).toBeNull();
    expect(getRecordCellSource(record({ registeredDate: null }), 'registeredDate', today)).toBeNull();
  });

  it('has no source for QPN, so the cell is answered by the report index instead', () => {
    expect(getRecordCellSource(record(), 'qpn', today)).toBeNull();
  });
});

describe('the MQIS column', () => {
  it('shows the canonical Management Number', () => {
    expect(MQIS_COLUMN).toBe('mqis');
    expect(MQIS_DISPLAY_FIELD).toBe('mgmtNo');
    expect(getRecordCellSource(record({ mgmtNo: '260702006-VOC' }), 'mqis', today)).toBe('260702006-VOC');
  });

  it('does not use mqisCode as the display source', () => {
    // The exact bug: a record with a management number showed "—" because the column read
    // the optional mqisCode extension, which is unpopulated on every seeded record.
    const withoutExtension = record({ mqisCode: null });
    expect(withoutExtension.mgmtNo).toBe('TNP-0007');
    expect(getRecordCellSource(withoutExtension, 'mqis', today)).toBe('TNP-0007');

    // And a present mqisCode must not win over the canonical number.
    expect(getRecordCellSource(record({ mqisCode: 'MQIS-9999' }), 'mqis', today)).toBe('TNP-0007');
  });

  it('shows the number for a record that has one, rather than the em dash', () => {
    for (const mgmtNo of ['1', '000123', '260702006-VOC', 'A1']) {
      expect(getRecordCellSource(record({ mgmtNo }), 'mqis', today)).toBe(mgmtNo);
    }
  });

  it('preserves leading zeros and the original formatting of the stored text', () => {
    expect(getRecordCellSource(record({ mgmtNo: '0007' }), 'mqis', today)).toBe('0007');
    expect(getRecordCellSource(record({ mgmtNo: '000042-01' }), 'mqis', today)).toBe('000042-01');
    // Inner spacing and casing are the operator's, not ours to normalise.
    expect(getRecordCellSource(record({ mgmtNo: ' 26 07 / A-a ' }), 'mqis', today)).toBe(' 26 07 / A-a ');
  });

  it('falls back to the placeholder only when there is genuinely no number', () => {
    for (const mgmtNo of ['', '   ', null, undefined]) {
      expect(getRecordCellSource(record({ mgmtNo: mgmtNo as string }), 'mqis', today)).toBeNull();
    }
    // A malformed value is treated as absent rather than stringified into the cell.
    expect(getRecordCellSource(record({ mgmtNo: { nested: 'x' } as unknown as string }), 'mqis', today)).toBeNull();
  });

  it('accepts a numeric value without losing information', () => {
    expect(canonicalCodeText(42)).toBe('42');
    expect(canonicalCodeText('0042')).toBe('0042');
    expect(canonicalCodeText(Number.NaN)).toBeNull();
    expect(canonicalCodeText(true)).toBeNull();
  });

  it('sorts management numbers the way an operator reads them', () => {
    const codes = ['MQIS-10', 'MQIS-2', 'MQIS-1', 'MQIS-20'];
    expect([...codes].sort(naturalTextCompare)).toEqual(['MQIS-1', 'MQIS-2', 'MQIS-10', 'MQIS-20']);
    // Zero-padded values still group correctly, and the padding is the tie-breaker.
    expect(['007', '7', '08'].sort(naturalTextCompare)).toEqual(['7', '007', '08']);
    // A lexicographic compare — the behaviour before — is what produced the wrong order.
    expect(['MQIS-10', 'MQIS-2'].sort()).toEqual(['MQIS-10', 'MQIS-2']);
  });
});

describe('the manual "Tình trạng" column', () => {
  it('names the field in one place the row and the save handler share', () => {
    expect(MANUAL_CONDITION_COLUMN).toBe('condition');
    expect(MANUAL_CONDITION_FIELD).toBe('manualCondition');
    expect(REQUIRED_RECORDS_COLUMNS.map(({ key }) => key)).toContain(MANUAL_CONDITION_COLUMN);
    expect(isManualInlineField(MANUAL_CONDITION_FIELD)).toBe(true);
    expect(isManualInlineField(MANUAL_DEFECT_NAME_FIELD)).toBe(true);
    expect(isManualInlineField('status')).toBe(false);
    expect(isManualInlineField('defectDetails')).toBe(false);
  });

  it('starts blank rather than borrowing anything from the record', () => {
    expect(getRecordCellSource(record(), 'condition', today)).toBeNull();
    // The canonical Approval value, and any unrelated field, must not leak into the column.
    expect(getRecordCellSource(record({ status: 'Hoàn thành' }), 'condition', today)).toBeNull();
    expect(getRecordCellSource({ ...record(), condition: 'OK' }, 'condition', today)).toBeNull();
  });

  it('shows exactly what was entered manually', () => {
    expect(getRecordCellSource(record({ manualCondition: 'Đang khắc phục' }), 'condition', today)).toBe('Đang khắc phục');
    expect(getRecordCellSource(record({ manualCondition: '   ' }), 'condition', today)).toBeNull();
  });

  it('leaves the canonical status untouched, so Approval keeps its own source', () => {
    const edited = record({ manualCondition: 'Đang khắc phục', status: 'Đợi đối sách' });

    expect(getRecordCellSource(edited, 'condition', today)).toBe('Đang khắc phục');
    expect(getRecordCellSource(edited, 'approval', today)).toBe('Đợi đối sách');
  });
});

describe('QPN report link', () => {
  const entries = [
    { recordIdKey: 'number:7', originalName: 'Countermeasure.pdf' },
    { recordIdKey: 'string:7', originalName: 'Other.pdf' },
  ];

  it('finds the attached report through the type-preserving canonical id key', () => {
    const index = createReportIndex(entries);

    expect(findAttachedReport(record({ id: 7 }), index)?.originalName).toBe('Countermeasure.pdf');
    expect(findAttachedReport(record({ id: '7' }), index)?.originalName).toBe('Other.pdf');
    expect(findAttachedReport(record({ id: 8 }), index)).toBeUndefined();
  });

  it('reports no attachment when the index is empty, so the cell shows the placeholder', () => {
    expect(findAttachedReport(record(), createReportIndex([]))).toBeUndefined();
    expect(getRecordCellSource(record(), 'qpn', today)).toBeNull();
  });
});

describe('the manual "Tên lỗi" column', () => {
  it('starts blank and never falls back to the imported defect details', () => {
    const untouched = record();

    // The fixture carries a source value; the column must not show it.
    expect(untouched.defectDetails).toBe('Scratch on left panel');
    expect(getRecordCellSource(untouched, 'defectName', today)).toBeNull();
  });

  it('shows exactly what was entered manually', () => {
    expect(getRecordCellSource(record({ manualDefectName: 'Weld crack' }), 'defectName', today)).toBe('Weld crack');
    expect(getRecordCellSource(record({ manualDefectName: '   ' }), 'defectName', today)).toBeNull();
  });

  it('leaves the imported source value readable alongside it', () => {
    const edited = record({ manualDefectName: 'Weld crack' });

    expect(edited.manualDefectName).toBe('Weld crack');
    expect(edited.defectDetails).toBe('Scratch on left panel');
  });

  it('names the field in one place the row and the save handler share', () => {
    expect(MANUAL_DEFECT_NAME_COLUMN).toBe('defectName');
    expect(MANUAL_DEFECT_NAME_FIELD).toBe('manualDefectName');
    expect(REQUIRED_RECORDS_COLUMNS.map(({ key }) => key)).toContain(MANUAL_DEFECT_NAME_COLUMN);
  });
});

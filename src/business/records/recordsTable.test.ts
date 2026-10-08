import { describe, expect, it } from 'vitest';
import type { DefectRecord } from '../../models/defect-record';
import { translate } from '../../i18n';
import {
  createReportIndex,
  findAttachedReport,
  getRecordCellSource,
  getVisibleRecordsColumns,
  hasSourceTatDeadline,
  MANUAL_DEFECT_NAME_COLUMN,
  MANUAL_DEFECT_NAME_FIELD,
  REQUIRED_RECORDS_COLUMNS,
} from './recordsTable';

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
    expect(getRecordCellSource(record(), 'mqis', today)).toBe('MQIS-8891');
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
    expect(getRecordCellSource(record({ mqisCode: '   ' }), 'mqis', today)).toBeNull();
    expect(getRecordCellSource(record({ pic: null }), 'pic', today)).toBeNull();
    expect(getRecordCellSource(record({ registeredDate: null }), 'registeredDate', today)).toBeNull();
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

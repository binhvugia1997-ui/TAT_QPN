import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as XLSX from '@e965/xlsx';
import { describe, expect, it } from 'vitest';
import { parseTnpFile } from './tnpFileParser';

// Same convention as realWorkbook.integration.test.ts: the validation workbook is
// company data, is gitignored, and is absent from a clean checkout.
const workbookName = 'EXCEL_EXPORT_FILE_20261002181424.xlsx';
const workbookPath = resolve(process.cwd(), workbookName);
const realWorkbookTest = existsSync(workbookPath) ? it : it.skip;

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function fileFromBytes(name: string, bytes: ArrayBuffer | Uint8Array) {
  const buffer = toArrayBuffer(bytes);
  return { name, size: buffer.byteLength, arrayBuffer: async () => buffer };
}

function workbookFile(name: string, rows: unknown[][], type: 'xlsx' | 'xls' = 'xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'TNP Export');
  const bytes = XLSX.write(book, { type: 'array', bookType: type === 'xls' ? 'biff8' : 'xlsx' });
  return fileFromBytes(name, bytes as Uint8Array);
}

const standardHeaders = [
  'Management Number',
  'Approval▼',
  'Reply expeced date for final countermeasure',
  'Registered Date',
  'Plant',
  'Basic Model',
  'Title',
  'Defect Q\'ty',
];

describe('TNP XLSX/XLS/CSV parser', () => {
  it('reads a real XLSX workbook and maps the exact legacy deadline header', async () => {
    const file = workbookFile('daily.xlsx', [
      ['TNP daily export'],
      standardHeaders,
      ['TNP-101', 'Rejected (xét)', '2026-10-17', '2026-10-01', 'SEV', 'Model A', 'Cracked part', 2],
    ]);

    const parsed = await parseTnpFile(file);
    expect(parsed.canImport).toBe(true);
    expect(parsed.sheetName).toBe('TNP Export');
    expect(parsed.headerRowNumber).toBe(2);
    expect(parsed.rows[0].sourceRowNumber).toBe(3);
    expect(parsed.rows[0].record).toMatchObject({
      mgmtNo: 'TNP-101',
      status: 'Rejected (xét)',
      dueDate: '2026-10-17',
      registeredDate: '2026-10-01',
      defectQty: 2,
    });
    expect(parsed.recognizedHeaders).toContainEqual({
      source: 'Reply expeced date for final countermeasure',
      field: 'dueDate',
    });
  });

  realWorkbookTest('recovers the real TNP export rows when its declared worksheet range is too short', async () => {
    const fileName = workbookName;
    const bytes = await readFile(workbookPath);
    const parsed = await parseTnpFile(fileFromBytes(fileName, bytes));

    expect(parsed).toMatchObject({
      sheetName: 'sheet1',
      sheetCount: 1,
      headerRowNumber: 2,
      canImport: true,
    });
    expect(parsed.rows).toHaveLength(110);
    expect(parsed.errors).toEqual([]);
    expect(parsed.unknownHeaders).toEqual([]);
    expect(parsed.recognizedHeaders).toEqual(expect.arrayContaining([
      { source: 'Reply expeced date for first countermeasure', field: 'initialDueDate' },
      { source: 'First Countermeasure input date', field: 'initialCompletedDate' },
      { source: 'TAT Compliance Y/N', field: 'initialTatCompliance' },
      { source: 'Vendor classification_approval date.', field: 'vendorApprovalDate' },
      { source: 'Reply expeced date for final countermeasure', field: 'dueDate' },
    ]));
    expect(parsed.warnings.some((warning) => warning.startsWith('Unrecognized columns'))).toBe(false);
    expect(parsed.rows[0]).toMatchObject({
      sourceRowNumber: 3,
      record: {
        mgmtNo: '261002091-VOC',
        registeredDate: '2026-10-02',
        dueDate: '2026-10-09',
      },
    });
    expect(parsed.rows.every(({ record }) => typeof record.dueDate === 'string' && record.dueDate.length > 0)).toBe(true);
    expect(parsed.warnings.some((warning) => warning.includes('A1:AX1') && warning.includes('A1:AX112') && warning.includes('in memory'))).toBe(true);
  });

  it('reads legacy binary XLS workbooks', async () => {
    const parsed = await parseTnpFile(workbookFile('daily.xls', [
      standardHeaders,
      ['TNP-XLS-1', 'Đợi đối sách', 46312, 46300, 'SEV', 'Model X', 'Legacy workbook row', 4],
    ], 'xls'));

    expect(parsed.canImport).toBe(true);
    expect(parsed.rows[0].record.dueDate).toBe('2026-10-17');
    expect(parsed.rows[0].record.registeredDate).toBe('2026-10-05');
  });

  it('parses quoted CSV fields and retains unrecognized source columns on new rows', async () => {
    const csv = [
      'Management Number,Status,Reply expeced date for final countermeasure,Registered Date,Plant,Title,Notes',
      'CSV-1,\"Đợi đối sách\",2026-10-17,2026-10-01,SEV,\"Defect, with comma\",\"Keep this local source value\"',
    ].join('\r\n');
    const bytes = new TextEncoder().encode(csv);

    const parsed = await parseTnpFile(fileFromBytes('daily.csv', bytes));
    expect(parsed.canImport).toBe(true);
    expect(parsed.rows[0].record).toMatchObject({
      mgmtNo: 'CSV-1',
      title: 'Defect, with comma',
      dueDate: '2026-10-17',
      sourceExtras: { Notes: 'Keep this local source value' },
    });
    expect(parsed.unknownHeaders).toEqual(['Notes']);
    expect(parsed.warnings.join(' ')).toContain('sourceExtras');
  });

  it('preserves hostile-looking unknown header names as inert source data', async () => {
    const parsed = await parseTnpFile(workbookFile('extra-header.xlsx', [
      ['Management Number', 'Status', 'Reply expeced date for final countermeasure', 'Title', '__proto__'],
      ['EXTRA-1', 'Đợi đối sách', '2026-10-17', 'Extra source', 'untrusted header value'],
    ]));

    const extras = parsed.rows[0].record.sourceExtras as Record<string, unknown>;
    expect(parsed.canImport).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(extras, '__proto__')).toBe(true);
    expect(extras['__proto__']).toBe('untrusted header value');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('validates missing status/identity headers and does not permit an unsafe import', async () => {
    const parsed = await parseTnpFile(workbookFile('incomplete.xlsx', [
      ['Plant', 'Title', 'Defect Q\'ty'],
      ['SEV', 'Not enough identity', 1],
    ]));

    expect(parsed.canImport).toBe(false);
    expect(parsed.errors.map((error) => error.message).join(' ')).toContain('status column is required');
    expect(parsed.errors.map((error) => error.message).join(' ')).toContain('Management Number');
  });

  it('supports the exact legacy composite identity when Management Number is blank', async () => {
    const parsed = await parseTnpFile(workbookFile('fallback-identity.xlsx', [
      ['Status', 'Reply expeced date for final countermeasure', 'Registered Date', 'Plant', 'Part Code', 'Title', 'Defect Q\'ty'],
      ['Đợi đối sách', '2026-10-17', '2026-10-01', 'SEV', 'P-1', 'Fallback identity', 2],
    ]));

    expect(parsed.canImport).toBe(true);
    expect(parsed.rows[0].record.mgmtNo).toBeUndefined();
    expect(parsed.rows[0].record.partCode).toBe('P-1');
  });

  it('blocks rows with blank status and incomplete fallback identity', async () => {
    const parsed = await parseTnpFile(workbookFile('blank-status.xlsx', [
      ['Management Number', 'Status', 'Reply expeced date for final countermeasure', 'Title'],
      ['BLANK-1', '', '2026-10-17', 'Blank status'],
      ['', 'Đợi đối sách', '2026-10-17', 'No reliable identity'],
    ]));

    expect(parsed.canImport).toBe(false);
    expect(parsed.rowsScanned).toBe(2);
    expect(parsed.invalidRows).toBe(2);
    expect(parsed.errors.some((issue) => issue.field === 'status' && issue.rowNumber === 2)).toBe(true);
    expect(parsed.errors.some((issue) => issue.field === 'mgmtNo' && issue.rowNumber === 3)).toBe(true);
  });

  it('blocks ambiguous numeric dates instead of guessing their locale order', async () => {
    const parsed = await parseTnpFile(workbookFile('ambiguous.xlsx', [
      standardHeaders,
      ['DATE-1', 'Đợi đối sách', '10/11/2026', '2026-10-01', 'SEV', 'Model A', 'Ambiguous date', 1],
    ]));

    expect(parsed.canImport).toBe(false);
    expect(parsed.rowsScanned).toBe(1);
    expect(parsed.invalidRows).toBe(1);
    expect(parsed.errors.some((error) => error.field === 'dueDate' && error.message.includes('Ambiguous date'))).toBe(true);
  });

  it('blocks duplicate identities instead of applying last-row-wins within a file', async () => {
    const parsed = await parseTnpFile(workbookFile('duplicate.xlsx', [
      standardHeaders,
      ['DUP-1', 'Đợi đối sách', '2026-10-17', '2026-10-01', 'SEV', 'Model A', 'Duplicate', 1],
      ['DUP-1', 'Rejected (xét)', '2026-10-20', '2026-10-01', 'SEV', 'Model A', 'Duplicate', 1],
    ]));

    expect(parsed.canImport).toBe(false);
    expect(parsed.rowsScanned).toBe(2);
    expect(parsed.invalidRows).toBe(1);
    expect(parsed.errors.some((error) => error.message.includes('same record identity'))).toBe(true);
  });

  it('rejects unsupported extensions, empty files and unrecognized header rows', async () => {
    await expect(parseTnpFile({ name: 'daily.xlsm', size: 4, arrayBuffer: async () => new ArrayBuffer(4) }))
      .rejects.toThrow(/Choose a \.xlsx, \.xls or \.csv/);
    await expect(parseTnpFile({ name: 'empty.csv', size: 0, arrayBuffer: async () => new ArrayBuffer(0) }))
      .rejects.toThrow(/empty/);
    const malformed = await parseTnpFile(fileFromBytes('malformed.xlsx', new TextEncoder().encode('not a valid workbook')));
    expect(malformed.canImport).toBe(false);
    expect(malformed.errors.length).toBeGreaterThan(0);
    const emptyWorkbook = await parseTnpFile(workbookFile('empty-workbook.xlsx', []));
    expect(emptyWorkbook.canImport).toBe(false);
    expect(emptyWorkbook.errors[0].message).toContain('No header row');
    const noHeader = await parseTnpFile(workbookFile('not-tnp.xlsx', [['a', 'b', 'c'], ['1', '2', '3']]));
    expect(noHeader.canImport).toBe(false);
    expect(noHeader.errors[0].message).toContain('No header row');
  });
});

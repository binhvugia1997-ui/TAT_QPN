import * as XLSX from '@e965/xlsx';
import { getRecordFingerprint } from '../../business/duplicate/identity';
import { normalizeDefectRecordPatch, type DefectRecordPatch } from '../../models/defect-record';
import { findTnpHeaderRowIndex, mapTnpHeader } from './headerMapping';

export const MAX_TNP_FILE_BYTES = 50 * 1024 * 1024;

export interface TnpFileLike {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface TnpParseIssue {
  rowNumber?: number;
  field?: string;
  message: string;
}

export interface ParsedTnpRow {
  sourceRowNumber: number;
  record: DefectRecordPatch;
}

export interface ParsedTnpFile {
  fileName: string;
  sheetName: string;
  sheetCount: number;
  headerRowNumber: number | null;
  recognizedHeaders: Array<{ source: string; field: string }>;
  unknownHeaders: string[];
  rows: ParsedTnpRow[];
  rowsScanned: number;
  invalidRows: number;
  warnings: string[];
  errors: TnpParseIssue[];
  canImport: boolean;
}

export class TnpFileParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TnpFileParseError';
  }
}

const IDENTITY_FALLBACK_FIELDS = ['registeredDate', 'plant', 'partCode', 'title', 'defectQty'] as const;
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

function extensionOf(fileName: string): string {
  return fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
}

function sourceText(value: unknown): string {
  return String(value ?? '').trim();
}

function isSafeSourceDate(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (value instanceof Date || typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return true;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:$|[T\s])/u.test(text)) return true;
  // Month names are unambiguous; numeric day-first/month-first strings are not.
  return /[a-z]/iu.test(text);
}

function uniqueUnknownHeader(header: unknown, columnIndex: number, used: Set<string>): string {
  const base = sourceText(header) || `Column ${columnIndex + 1}`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base} (${suffix})`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

function expandWorksheetRangeToStoredCells(worksheet: XLSX.WorkSheet): { declaredRange?: string; usedRange?: string } {
  const declaredRange = worksheet['!ref'];
  const cellAddresses = Object.keys(worksheet).filter((key) => /^[A-Z]{1,3}[1-9][0-9]*$/u.test(key));
  if (cellAddresses.length === 0) return { declaredRange, usedRange: declaredRange };

  const range = declaredRange
    ? XLSX.utils.decode_range(declaredRange)
    : { s: { r: Number.POSITIVE_INFINITY, c: Number.POSITIVE_INFINITY }, e: { r: -1, c: -1 } };
  for (const address of cellAddresses) {
    const cell = XLSX.utils.decode_cell(address);
    range.s.r = Math.min(range.s.r, cell.r);
    range.s.c = Math.min(range.s.c, cell.c);
    range.e.r = Math.max(range.e.r, cell.r);
    range.e.c = Math.max(range.e.c, cell.c);
  }

  const usedRange = XLSX.utils.encode_range(range);
  if (usedRange !== declaredRange) worksheet['!ref'] = usedRange;
  return { declaredRange, usedRange };
}

function buildGrid(fileName: string, buffer: ArrayBuffer): { grid: unknown[][]; sheetName: string; sheetCount: number; rangeWarning?: string } {
  const extension = extensionOf(fileName);
  let workbook: XLSX.WorkBook;
  try {
    if (extension === '.csv') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      workbook = XLSX.read(text, { type: 'string', raw: true, cellDates: true });
    } else {
      workbook = XLSX.read(buffer, { type: 'array', cellDates: true, raw: true });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TnpFileParseError(`Could not read ${fileName}: ${detail}`, { cause: error });
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new TnpFileParseError('The selected file contains no readable worksheet.');
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) throw new TnpFileParseError('The first worksheet could not be read.');
  const { declaredRange, usedRange } = expandWorksheetRangeToStoredCells(worksheet);
  const rangeWarning = declaredRange !== usedRange && usedRange
    ? `The worksheet declared range “${declaredRange ?? '(missing)'}”, but stored cells extend through “${usedRange}”; the range was expanded in memory for parsing only.`
    : undefined;
  const grid = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  }) as unknown[][];
  return { grid, sheetName, sheetCount: workbook.SheetNames.length, rangeWarning };
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function hasFallbackIdentity(record: DefectRecordPatch, mappedFields: ReadonlySet<string>): boolean {
  return IDENTITY_FALLBACK_FIELDS.every((field) => mappedFields.has(field))
    && ['registeredDate', 'plant', 'partCode', 'title'].every((field) => hasValue(record[field]));
}

/**
 * Reads one local TNP workbook/CSV, applies the audited exact header aliases, normalizes
 * recognized fields, and reports every row/header issue before the caller can commit.
 */
export async function parseTnpFile(file: TnpFileLike): Promise<ParsedTnpFile> {
  const extension = extensionOf(file.name);
  if (!['.xlsx', '.xls', '.csv'].includes(extension)) {
    throw new TnpFileParseError('Choose a .xlsx, .xls or .csv TNP file.');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new TnpFileParseError('The selected file is empty.');
  }
  if (file.size > MAX_TNP_FILE_BYTES) {
    throw new TnpFileParseError('The selected file is larger than the 50 MB development import limit.');
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    throw new TnpFileParseError(`Could not read ${file.name}.`, { cause: error });
  }

  const { grid, sheetName, sheetCount, rangeWarning } = buildGrid(file.name, buffer);
  const headerIndex = findTnpHeaderRowIndex(grid);
  const result: ParsedTnpFile = {
    fileName: file.name,
    sheetName,
    sheetCount,
    headerRowNumber: headerIndex >= 0 ? headerIndex + 1 : null,
    recognizedHeaders: [],
    unknownHeaders: [],
    rows: [],
    rowsScanned: 0,
    invalidRows: 0,
    warnings: rangeWarning ? [rangeWarning] : [],
    errors: [],
    canImport: false,
  };

  if (headerIndex < 0) {
    result.errors.push({ message: 'No header row with at least three recognized TNP columns was found in the first ten rows.' });
    return result;
  }

  const headerRow = grid[headerIndex] ?? [];
  const fields = headerRow.map((header) => mapTnpHeader(header));
  const mappedFields = new Set(fields.filter((field): field is string => field !== null));
  const duplicateFields = new Set<string>();
  const seenFields = new Set<string>();
  const unknownKeys = new Set<string>();
  const unknownColumns = new Map<number, string>();

  fields.forEach((field, index) => {
    const rawHeader = sourceText(headerRow[index]);
    if (field) {
      result.recognizedHeaders.push({ source: rawHeader, field });
      if (seenFields.has(field)) duplicateFields.add(field);
      seenFields.add(field);
    } else {
      const extraKey = uniqueUnknownHeader(headerRow[index], index, unknownKeys);
      unknownColumns.set(index, extraKey);
      if (rawHeader && !result.unknownHeaders.includes(rawHeader)) result.unknownHeaders.push(rawHeader);
    }
  });

  for (const field of duplicateFields) {
    result.errors.push({
      rowNumber: headerIndex + 1,
      field,
      message: `More than one source column maps to ${field}; remove the ambiguous duplicate column before importing.`,
    });
  }
  if (!mappedFields.has('status')) {
    result.errors.push({ rowNumber: headerIndex + 1, field: 'status', message: 'A recognized TNP status column is required.' });
  }
  if (!mappedFields.has('mgmtNo') && !IDENTITY_FALLBACK_FIELDS.every((field) => mappedFields.has(field))) {
    result.errors.push({
      rowNumber: headerIndex + 1,
      field: 'mgmtNo',
      message: 'Include Management Number, or all five legacy fallback identity columns (registered date, plant, part code, title and defect quantity).',
    });
  }

  if (sheetCount > 1) result.warnings.push(`This workbook has ${sheetCount} sheets; only the first sheet (“${sheetName}”) is read, matching the legacy import behavior.`);
  if (!mappedFields.has('dueDate')) result.warnings.push('No recognized final-countermeasure reply-date column was found. New rows will use registered date + 7 days when possible; matched records will keep their current dueDate.');
  if (result.unknownHeaders.length) {
    result.warnings.push(`Unrecognized columns are retained in sourceExtras on new records and are not applied to existing records: ${result.unknownHeaders.join(', ')}.`);
  }

  const rowIdentities = new Map<string, number>();
  for (let rowIndex = headerIndex + 1; rowIndex < grid.length; rowIndex += 1) {
    const sourceRow = grid[rowIndex] ?? [];
    if (!sourceRow.some(hasValue)) continue;
    result.rowsScanned += 1;
    const rowNumber = rowIndex + 1;
    const raw: Record<string, unknown> = {};
    const sourceExtras = Object.create(null) as Record<string, unknown>;

    fields.forEach((field, columnIndex) => {
      const value = sourceRow[columnIndex] === undefined ? null : sourceRow[columnIndex];
      if (field) raw[field] = value;
      else if (hasValue(value)) sourceExtras[unknownColumns.get(columnIndex)!] = value;
    });
    if (Object.keys(sourceExtras).length) raw.sourceExtras = sourceExtras;

    let record: DefectRecordPatch;
    try {
      record = normalizeDefectRecordPatch(raw);
    } catch (error) {
      const field = typeof error === 'object' && error && 'field' in error ? String(error.field) : undefined;
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ rowNumber, field, message });
      continue;
    }

    if (!hasValue(record.status)) {
      result.errors.push({ rowNumber, field: 'status', message: 'Status is blank; the row cannot be safely imported.' });
      continue;
    }
    if (!hasValue(record.mgmtNo) && !hasFallbackIdentity(record, mappedFields)) {
      result.errors.push({
        rowNumber,
        field: 'mgmtNo',
        message: 'This row has no Management Number and does not contain a complete legacy fallback identity.',
      });
      continue;
    }

    for (const field of DATE_FIELDS) {
      const value = raw[field];
      if (typeof value === 'string' && value.trim() && !isSafeSourceDate(value)) {
        result.errors.push({
          rowNumber,
          field,
          message: `Ambiguous date “${value}”. Use an unambiguous year-first date (YYYY-MM-DD) or a real Excel date cell.`,
        });
      }
    }
    if (result.errors.some((issue) => issue.rowNumber === rowNumber)) continue;

    const identity = getRecordFingerprint(record);
    const previousRow = rowIdentities.get(identity);
    if (previousRow !== undefined) {
      result.errors.push({
        rowNumber,
        field: 'mgmtNo',
        message: `This row has the same record identity as row ${previousRow}; duplicate identities in one file must be resolved before import.`,
      });
      continue;
    }
    rowIdentities.set(identity, rowNumber);
    result.rows.push({ sourceRowNumber: rowNumber, record });
  }

  if (!result.rows.length && !result.errors.length) {
    result.errors.push({ message: 'No non-empty TNP data rows were found below the header.' });
  }
  const headerRowNumber = result.headerRowNumber ?? 0;
  result.invalidRows = new Set(result.errors
    .map(({ rowNumber }) => rowNumber)
    .filter((rowNumber): rowNumber is number => rowNumber !== undefined && rowNumber > headerRowNumber)).size;
  result.canImport = result.rows.length > 0 && result.errors.length === 0;
  return result;
}

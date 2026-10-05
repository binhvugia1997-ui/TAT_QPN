import { normalizeDefectRecordPatch, type DefectRecordPatch } from '../../models/defect-record';

/**
 * Recognized TNP export headers, normalized to lowercase single-space form. The misspelled
 * English header is present in the legacy map and is intentionally kept as an exact alias.
 */
export const TNP_IMPORT_HEADER_MAP: Readonly<Record<string, string>> = {
  no: 'no',
  'management number': 'mgmtNo',
  'registered date': 'registeredDate',
  'mqis code': 'mqisCode',
  'mqis no': 'mqisCode',
  'mqis number': 'mqisCode',
  mqis: 'mqisCode',
  'written by': 'writtenBy',
  'approval▼': 'status',
  approval: 'status',
  status: 'status',
  plant: 'plant',
  title: 'title',
  'occur place': 'occurPlace',
  supplier: 'supplier',
  'v/code': 'vCode',
  vendor_g: 'vendorGroup',
  vendor_s: 'vendorSub',
  'part code': 'partCode',
  'part name': 'partName',
  'part group': 'partGroup',
  'main category': 'mainCategory',
  project: 'project',
  'basic model': 'model',
  'defect details': 'defectDetails',
  "sample q'ty": 'sampleQty',
  'sample q’ty': 'sampleQty',
  "defect q'ty": 'defectQty',
  'defect q’ty': 'defectQty',
  'defect rate(%)': 'defectRate',
  reason1: 'reason1',
  reason2: 'reason2',
  inspector: 'inspector',
  'audit date': 'auditDate',
  approver: 'approver',
  'approval date': 'approvalDate',
  'issue 사유': 'issueReason',
  'issue y/n': 'issueYN',
  'parts problem': 'partsProblem',
  'reoccur 3m': 'reoccur3M',
  'system qtr': 'systemQtr',
  'claim y/n': 'claimYN',
  'input stop': 'inputStop',
  'effectiveness verification': 'effectivenessVerification',
  // Existing initial-countermeasure fields from the legacy model and Korean source aliases.
  'reply expeced date for first countermeasure': 'initialDueDate',
  'first countermeasure input date': 'initialCompletedDate',
  'tat compliance y/n': 'initialTatCompliance',
  'vendor classification_approval date.': 'vendorApprovalDate',
  // Exact legacy Excel spelling; canonical dueDate is the current/effective TAT deadline.
  'reply expeced date for final countermeasure': 'dueDate',
  'reply expected date for final countermeasure': 'dueDate',
  'final countermeasure input date': 'completedDate',
  'tat(day)': 'tatDays',
  'tat compliance': 'tatCompliance',
  'transaction type': 'transactionType',
  'located corp': 'locatedCorp',
  '관리번호': 'mgmtNo',
  '등록일': 'registeredDate',
  '등록자': 'writtenBy',
  '승인단계': 'status',
  '승인상태': 'status',
  '제목': 'title',
  '발생장소': 'occurPlace',
  '협력사': 'supplier',
  '업체명': 'supplier',
  '부품코드': 'partCode',
  '부품명': 'partName',
  '부품군': 'partGroup',
  '대분류': 'mainCategory',
  '불량현상': 'defectDetails',
  '검사수': 'sampleQty',
  '불량수': 'defectQty',
  '불량률(%)': 'defectRate',
  '불량율(%)': 'defectRate',
  '원인1(4m+1e)': 'reason1',
  원인1: 'reason1',
  '원인2(발생원인)': 'reason2',
  원인2: 'reason2',
  심사자: 'inspector',
  심사일: 'auditDate',
  승인자: 'approver',
  승인일: 'approvalDate',
  부품문제: 'partsProblem',
  'qtr 3개월내 재발': 'reoccur3M',
  '3개월내 재발생': 'reoccur3M',
  투입중지: 'inputStop',
  '유효성 검증': 'effectivenessVerification',
  유효성검증: 'effectivenessVerification',
  '최종대책회답예정일': 'dueDate',
  '최종대책입력일': 'completedDate',
  'tat(일)': 'tatDays',
  'tat 준수': 'tatCompliance',
  'sqci/plm-no': 'sqciPlmNo',
  'plm 대책': 'plmCountermeasure',
  '의뢰자/시료번호/비고': 'sourceRemarks',
  '최초대책예정일': 'initialDueDate',
  '최초 대책 입력일': 'initialCompletedDate',
  '최초대책입력일': 'initialCompletedDate',
  '최초tat 준수(y/n)': 'initialTatCompliance',
  거래유형: 'transactionType',
  '업체구분_승락일': 'vendorApprovalDate',
  권역법인: 'locatedCorp',
  사용멤버: 'usedMember',
};

export class TnpHeaderMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TnpHeaderMappingError';
  }
}

export function normalizeTnpHeader(header: unknown): string {
  return String(header ?? '').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function mapTnpHeader(header: unknown): string | null {
  const normalized = normalizeTnpHeader(header);
  return Object.prototype.hasOwnProperty.call(TNP_IMPORT_HEADER_MAP, normalized)
    ? TNP_IMPORT_HEADER_MAP[normalized]
    : null;
}

export function findTnpHeaderRowIndex(grid: readonly (readonly unknown[])[]): number {
  const scanLimit = Math.min(grid.length, 10);
  for (let index = 0; index < scanLimit; index += 1) {
    const hits = grid[index].filter((header) => mapTnpHeader(header) !== null).length;
    if (hits >= 3) return index;
  }
  return -1;
}

/** Maps the first matching header row (within the first ten rows) and normalizes source values. */
export function mapTnpGridToCanonicalRows(
  grid: readonly (readonly unknown[])[],
): DefectRecordPatch[] {
  const headerRowIndex = findTnpHeaderRowIndex(grid);
  if (headerRowIndex < 0) {
    throw new TnpHeaderMappingError('No TNP header row with at least three recognized columns was found in the first ten rows.');
  }

  const columns = grid[headerRowIndex].map(mapTnpHeader);
  const mappedRows: DefectRecordPatch[] = [];

  for (const sourceRow of grid.slice(headerRowIndex + 1)) {
    if (!sourceRow.some((value) => value !== null && value !== undefined && value !== '')) continue;
    const row: Record<string, unknown> = {};
    columns.forEach((field, index) => {
      if (field) row[field] = sourceRow[index];
    });
    if (Object.keys(row).length > 0) mappedRows.push(normalizeDefectRecordPatch(row));
  }

  return mappedRows;
}

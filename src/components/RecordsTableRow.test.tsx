import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RecordsTableRow from './RecordsTableRow';
import { createReportIndex } from '../business/records/recordsTable';
import { getVisibleRecordsColumns } from '../business/records/recordsTable';
import type { DefectRecord } from '../models/defect-record';

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

function renderRow(overrides: Partial<DefectRecord> = {}, options: { reportIndex?: ReturnType<typeof createReportIndex>; mode?: 'records' | 'corrective' } = {}): string {
  return renderToStaticMarkup(
    <RecordsTableRow
      locale="en"
      record={record(overrides)}
      sequence={1}
      today={today}
      reportIndex={options.reportIndex ?? createReportIndex([])}
      showCaLink={options.mode === 'corrective'}
      onSelect={() => {}}
    />,
  );
}

function cells(markup: string): string[] {
  return (markup.match(/<td[^>]*>[\s\S]*?<\/td>/gu) ?? [])
    .map((cell) => cell.replace(/<[^>]*>/gu, '').trim());
}

describe('Records table row rendering', () => {
  it('renders exactly the 14 approved cells, in the approved order', () => {
    expect(cells(renderRow())).toEqual([
      '1',                          // NO — rendered row sequence only
      'MQIS-8891',                  // MQIS
      '01 Oct 2026',                // Registered Date
      'Nguyen Van A',               // PIC
      'Đợi đối sách',               // Approval — original TNP status
      'TNP',                        // PLANT
      'Body scratch',               // Title
      'Line 3',                     // Occur place
      'Welding',                    // Công đoạn quy trách
      'Scratch on left panel',      // Tên lỗi
      '—',                          // Tình trạng — no verified source field
      '—',                          // QPN — no linked file
      '15 Oct 2026TNP deadline',    // TAT Hệ thống
      '-3',                         // Ngày Pending
    ]);
  });

  it('renders one header per approved column, in the same order', () => {
    expect(getVisibleRecordsColumns({ corrective: false })).toHaveLength(14);
    expect(cells(renderRow())).toHaveLength(getVisibleRecordsColumns({ corrective: false }).length);
  });

  it('keeps TAT Hệ thống and Ngày Pending independent', () => {
    // registeredDate = 2026-10-01, today = 2026-10-11, dueDate = 2026-10-15
    const [tatSystem, pendingDays] = cells(renderRow()).slice(12);

    expect(tatSystem).toBe('15 Oct 2026TNP deadline');
    expect(pendingDays).toBe('-3');
  });

  it('falls back to registeredDate + 7 for TAT Hệ thống without touching Ngày Pending', () => {
    const withoutDeadline = cells(renderRow({ dueDate: null }));

    expect(withoutDeadline[12]).toBe('08 Oct 20267-day fallback');
    expect(withoutDeadline[13]).toBe('-3');
  });

  it('always shows the placeholder for Tình trạng, even when other fields are filled in', () => {
    const filled = cells(renderRow({ notes: 'OK', status: 'Hoàn thành', completedDate: '2026-10-09' }));

    expect(filled[10]).toBe('—');
  });

  it('renders a clickable File link in QPN only when a report is linked', () => {
    const linked = renderRow({}, { reportIndex: createReportIndex([{ recordIdKey: 'number:7', originalName: 'Countermeasure.pdf' }]) });

    expect(cells(linked)[11]).toBe('File');
    expect(linked).toContain('href="/api/records/number%3A7/report"');
    expect(linked).toContain('title="Countermeasure.pdf"');
    expect(linked).toContain('target="_blank"');

    expect(cells(renderRow())[11]).toBe('—');
  });

  it('uses the type-preserving record id key for the QPN link', () => {
    const linked = renderRow({ id: '7' }, { reportIndex: createReportIndex([{ recordIdKey: 'string:7', originalName: 'Other.pdf' }]) });

    expect(linked).toContain('href="/api/records/string%3A7/report"');
  });

  it('shows placeholders rather than empty cells for missing source values', () => {
    const blank = cells(renderRow({
      mqisCode: null,
      pic: null,
      plant: null,
      title: null,
      occurPlace: null,
      partGroup: null,
      defectDetails: null,
      registeredDate: null,
      dueDate: null,
      status: '',
    }));

    expect(blank).toEqual(['1', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—']);
  });

  it('still resolves TAT Hệ thống from dueDate when registeredDate is missing, with no pending window', () => {
    const withoutRegistration = cells(renderRow({ registeredDate: null }));

    expect(withoutRegistration[2]).toBe('—');
    expect(withoutRegistration[12]).toBe('15 Oct 2026TNP deadline');
    expect(withoutRegistration[13]).toBe('—');
  });

  it('appends the CA badge as a 15th column only in the corrective workspace', () => {
    expect(cells(renderRow({}, { mode: 'corrective' }))).toHaveLength(15);
    expect(cells(renderRow())).toHaveLength(14);
  });
});

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RecordsTableRow from './RecordsTableRow';
import {
  createReportIndex,
  REQUIRED_RECORDS_COLUMNS,
  type RecordsTableColumnKey,
} from '../business/records/recordsTable';
import type { DefectRecord } from '../models/defect-record';

const today = '2026-10-11';
const ALL_COLUMNS: RecordsTableColumnKey[] = REQUIRED_RECORDS_COLUMNS.map(({ key }) => key);

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

interface RenderOptions {
  reportIndex?: ReturnType<typeof createReportIndex>;
  mode?: 'records' | 'corrective';
  columns?: RecordsTableColumnKey[];
}

function renderRow(overrides: Partial<DefectRecord> = {}, options: RenderOptions = {}): string {
  return renderToStaticMarkup(
    <RecordsTableRow
      locale="en"
      record={record(overrides)}
      sequence={1}
      today={today}
      reportIndex={options.reportIndex ?? createReportIndex([])}
      showCaLink={options.mode === 'corrective'}
      columns={options.columns ?? ALL_COLUMNS}
      onSelect={() => {}}
      onSaveDefectName={async () => {}}
      onReportChanged={() => {}}
    />,
  );
}

/**
 * Drops hidden subtrees first, so a collapsed menu does not count as visible text.
 * Matches only a real `hidden` attribute — never `aria-hidden`, which decorates icons.
 */
function withoutHidden(markup: string): string {
  return markup.replace(/<([a-z]+)([^>]*\shidden(?:\s*=|\s|>)[^>]*)>[\s\S]*?<\/\1>/gu, '');
}

function cells(markup: string): string[] {
  return (withoutHidden(markup).match(/<td[^>]*>[\s\S]*?<\/td>/gu) ?? [])
    .map((cell) => cell.replace(/<[^>]*>/gu, '').trim());
}

const withReport = createReportIndex([{ recordIdKey: 'number:7', originalName: 'Countermeasure.pdf' }]);

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
      'Click to enter the defect name', // Tên lỗi — manual, blank until entered
      '—',                          // Tình trạng — no verified source field
      '＋ Add',                     // QPN — nothing attached yet
      '15 Oct 2026TNP deadline',    // TAT Hệ thống
      '-3',                         // Ngày Pending
    ]);
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
    const filled = cells(renderRow({ notes: 'OK', completedDate: '2026-10-09' }));

    expect(filled[10]).toBe('—');
  });

  it('renders Ngày Pending blank — not 0, not an em dash — for a no-longer-active status', () => {
    for (const status of ['Đợi duyệt', 'Đợi xét', 'Hoàn thành']) {
      const row = cells(renderRow({ status }));

      expect(row[13]).toBe('');
      // TAT Hệ thống is untouched by the pending rule.
      expect(row[12]).toBe('15 Oct 2026TNP deadline');
    }
  });

  it('keeps calculating Ngày Pending for the active pending status', () => {
    expect(cells(renderRow({ status: 'Đợi đối sách' }))[13]).toBe('-3');
  });

  it('marks the blank pending cell so it is visibly empty', () => {
    expect(renderRow({ status: 'Đợi duyệt' })).toContain('pending-cell pending-blank');
    expect(renderRow()).not.toContain('pending-blank');
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

    expect(blank[1]).toBe('—');
    expect(blank[3]).toBe('—');
    expect(blank[5]).toBe('—');
    expect(blank[13]).toBe('');
  });

  it('still resolves TAT Hệ thống from dueDate when registeredDate is missing, with no pending window', () => {
    const withoutRegistration = cells(renderRow({ registeredDate: null }));

    expect(withoutRegistration[2]).toBe('—');
    expect(withoutRegistration[12]).toBe('15 Oct 2026TNP deadline');
    expect(withoutRegistration[13]).toBe('');
  });

  it('appends the CA badge as a 15th column only in the corrective workspace', () => {
    expect(cells(renderRow({}, { mode: 'corrective' }))).toHaveLength(15);
    expect(cells(renderRow())).toHaveLength(14);
  });
});

describe('QPN cell', () => {
  it('offers a compact Add action when nothing is attached', () => {
    const markup = renderRow();

    expect(cells(markup)[11]).toBe('＋ Add');
    expect(markup).toContain('class="qpn-action qpn-add"');
    // A real file input backs the browser upload path.
    expect(markup).toContain('type="file"');
    expect(markup).not.toContain('qpn-more');
  });

  it('offers Open plus an overflow menu once a report is attached', () => {
    const markup = renderRow({}, { reportIndex: withReport });

    expect(cells(markup)[11]).toBe('📄 Open⋯');
    expect(markup).toContain('Change file');
    expect(markup).toContain('Remove file');
  });

  it('opens through the existing per-record report streaming endpoint', () => {
    const markup = renderRow({}, { reportIndex: withReport });

    expect(markup).toContain('href="/api/records/number%3A7/report"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    // The full local path is never rendered; only the file name, as a tooltip.
    expect(markup).toContain('title="Countermeasure.pdf"');
    expect(markup).not.toContain('/reports/');
  });

  it('binds the QPN actions to the type-preserving canonical record id', () => {
    const markup = renderRow({ id: '7' }, {
      reportIndex: createReportIndex([{ recordIdKey: 'string:7', originalName: 'Other.pdf' }]),
    });

    expect(markup).toContain('href="/api/records/string%3A7/report"');
  });

  it('still works when other columns are hidden', () => {
    const hidden = ALL_COLUMNS.filter((key) => key === 'no' || key === 'title' || key === 'qpn');
    const markup = renderRow({}, { columns: hidden, reportIndex: withReport });

    expect(cells(markup)).toHaveLength(3);
    expect(markup).toContain('href="/api/records/number%3A7/report"');
  });
});

describe('column visibility in the row', () => {
  it('hides only the unchecked columns and keeps the rest in order', () => {
    const shown = ALL_COLUMNS.filter((key) => key !== 'mqis' && key !== 'plant');

    expect(cells(renderRow({}, { columns: shown }))).toEqual([
      '1',
      '01 Oct 2026',
      'Nguyen Van A',
      'Đợi đối sách',
      'Body scratch',
      'Line 3',
      'Welding',
      'Click to enter the defect name',
      '—',
      '＋ Add',
      '15 Oct 2026TNP deadline',
      '-3',
    ]);
  });

  it('restores a column when it is checked again', () => {
    const hidden = ALL_COLUMNS.filter((key) => key !== 'pic');
    expect(cells(renderRow({}, { columns: hidden }))).toHaveLength(13);
    expect(cells(renderRow({}, { columns: ALL_COLUMNS }))).toHaveLength(14);
  });

  it('does not alter the record when a column is hidden', () => {
    const source = record();
    const before = JSON.stringify(source);

    renderRow({}, { columns: ['no', 'title', 'qpn'] });

    expect(JSON.stringify(source)).toBe(before);
    expect(source.mqisCode).toBe('MQIS-8891');
    expect(source.plant).toBe('TNP');
    expect(source.registeredDate).toBe('2026-10-01');
    expect(source.dueDate).toBe('2026-10-15');
  });
});

describe('the editable "Tên lỗi" cell', () => {
  it('renders an entry prompt instead of the imported defect details', () => {
    const markup = renderRow();

    // The fixture still carries a source value; it must not appear anywhere in the row.
    expect(markup).not.toContain('Scratch on left panel');
    expect(markup).toContain('inline-edit-trigger inline-edit-empty');
    expect(markup).toContain('Click to enter the defect name');
  });

  it('is a real button, so it is reachable without a click and blocks the row double-click', () => {
    const markup = renderRow();

    expect(markup).toContain('class="inline-edit-trigger inline-edit-empty"');
    expect(markup).toContain('aria-label="Defect name (manual entry)"');
  });

  it('shows the saved manual value once one exists', () => {
    const markup = renderRow({ manualDefectName: 'Weld crack on bracket' });

    expect(markup).toContain('Weld crack on bracket');
    expect(markup).not.toContain('inline-edit-empty');
    expect(markup).not.toContain('Click to enter the defect name');
  });

  it('treats a whitespace-only value as still blank', () => {
    expect(renderRow({ manualDefectName: '   ' })).toContain('inline-edit-empty');
  });

  it('marks the cell interactive so a double-click edits rather than opening the drawer', () => {
    expect(renderRow()).toMatch(/<td[^>]*class="defect-name-cell"[^>]*data-tnp-row-interactive/u);
  });

  it('marks the QPN cell interactive too, so its controls never trigger the drawer', () => {
    expect(renderRow({}, { reportIndex: withReport })).toMatch(/<td[^>]*class="qpn-cell"[^>]*data-tnp-row-interactive/u);
  });

  it('does not render the row as a single-click target', () => {
    // React attaches these as listeners, not attributes, so the guard is the DOM-level check.
    expect(renderRow()).not.toMatch(/<tr[^>]*\sonclick=/u);
  });
});

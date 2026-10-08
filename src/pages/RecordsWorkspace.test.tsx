import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import RecordsWorkspace from './RecordsWorkspace';
import { RECORDS_COLUMN_STORAGE_KEY } from '../services/preferences/columnPreferences';
import { REQUIRED_RECORDS_COLUMNS } from '../business/records/recordsTable';
import type { DefectRecord } from '../models/defect-record';

/**
 * Renders the real Records workspace page and reads the table headers straight out of the
 * markup, so the approved 14-column order is verified at the level the user sees.
 */
const records: DefectRecord[] = [
  {
    id: 1,
    recordSource: 'legacy-seed',
    mgmtNo: 'TNP-0001',
    status: 'Đợi đối sách',
    registeredDate: '2026-10-01',
    mqisCode: 'MQIS-1',
    pic: 'Nguyen Van A',
    plant: 'TNP',
    title: 'Body scratch',
    occurPlace: 'Line 3',
    partGroup: 'Welding',
    defectDetails: 'Scratch on left panel',
    dueDate: '2026-10-15',
  },
  {
    id: 2,
    recordSource: 'import',
    mgmtNo: 'TNP-0002',
    status: 'Rejected (xét)',
    registeredDate: '2026-09-20',
    plant: 'SIEL',
    title: 'Missing weld',
    defectDetails: 'Weld point missing',
    dueDate: null,
  },
];

function renderPage(mode: 'records' | 'corrective' | 'rejected' = 'records'): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RecordsWorkspace locale="en" records={records} mode={mode} onRecordsChanged={async () => {}} />
    </MemoryRouter>,
  );
}

function headerCells(markup: string): string[] {
  const head = /<thead>[\s\S]*?<\/thead>/u.exec(markup)?.[0] ?? '';
  return (head.match(/<th[^>]*>[\s\S]*?<\/th>/gu) ?? [])
    .map((cell) => cell.replace(/<[^>]*>/gu, '').replace(/[↑↓↕]/gu, '').trim());
}

/**
 * Drops hidden subtrees first, so a collapsed QPN menu does not count as visible text.
 * Matches only a real `hidden` attribute — never `aria-hidden`, which decorates icons.
 */
function withoutHidden(markup: string): string {
  return markup.replace(/<([a-z]+)([^>]*\shidden(?:\s*=|\s|>)[^>]*)>[\s\S]*?<\/\1>/gu, '');
}

function dataRows(markup: string): string[][] {
  const body = /<tbody>[\s\S]*?<\/tbody>/u.exec(markup)?.[0] ?? '';
  return (withoutHidden(body).match(/<tr[^>]*class="[^"]*record-row[^"]*"[\s\S]*?<\/tr>/gu) ?? [])
    .map((row) => (row.match(/<td[^>]*>[\s\S]*?<\/td>/gu) ?? [])
      .map((cell) => cell.replace(/<[^>]*>/gu, '').trim()));
}

describe('Records workspace table', () => {
  it('shows the 14 approved columns as visible headers, in the approved order', () => {
    // The header style upper-cases the label; the label text itself is the approved wording.
    expect(headerCells(renderPage())).toEqual([
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

  it('renders one cell per approved column for every row', () => {
    const markup = renderPage();

    expect(headerCells(markup)).toHaveLength(14);
    expect(dataRows(markup)).toHaveLength(2);
    for (const row of dataRows(markup)) expect(row).toHaveLength(14);
  });

  it('keeps the approved 14 columns first and appends the CA badge only for corrective work', () => {
    expect(headerCells(renderPage('corrective'))).toEqual([...headerCells(renderPage()), 'CA file']);
    expect(headerCells(renderPage('rejected'))).toEqual(headerCells(renderPage()));
  });

  it('numbers rows as a rendered sequence and maps the approved source fields', () => {
    // Operational priority puts the most overdue record first, so the Rejected record leads.
    const [first, second] = dataRows(renderPage());

    expect(first).toEqual([
      '1',
      // MQIS is the canonical Management Number, so a record without the optional
      // `mqisCode` extension still shows its number instead of an em dash.
      'TNP-0002',
      '20 Sept 2026',
      '—',
      'Rejected (xét)',
      'SIEL',
      'Missing weld',
      '—',
      '—',
      'Click to enter the defect name',
      'Click to enter the condition',
      '＋ Add',
      '27 Sept 20267-day fallback',
      expect.stringMatching(/^-?\d+$/u),
    ]);
    expect(second).toEqual([
      '2',
      'TNP-0001',
      '01 Oct 2026',
      'Nguyen Van A',
      'Đợi đối sách',
      'TNP',
      'Body scratch',
      'Line 3',
      'Welding',
      'Click to enter the defect name',
      'Click to enter the condition',
      '＋ Add',
      '15 Oct 2026TNP deadline',
      expect.stringMatching(/^-?\d+$/u),
    ]);
  });

  it('keeps the table inside a horizontally scrolling container', () => {
    expect(renderPage()).toContain('<div class="table-scroll">');
  });
});

/**
 * Drives the real per-client preference path: the workspace reads `window.localStorage`
 * on mount, so stubbing it exercises the same load code the browser uses.
 */
function withStoredPreference<T>(hidden: readonly string[], run: () => T): T {
  const globalRef = globalThis as { window?: unknown };
  const previous = globalRef.window;
  globalRef.window = {
    localStorage: {
      getItem: (key: string) => key === RECORDS_COLUMN_STORAGE_KEY
        ? JSON.stringify({ version: 1, hidden })
        : null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
  try {
    return run();
  } finally {
    globalRef.window = previous;
  }
}

function columnWidths(markup: string): string[] {
  return (/<colgroup>[\s\S]*?<\/colgroup>/u.exec(markup)?.[0] ?? '')
    .match(/width:\s*[\d.]+%/gu) ?? [];
}

/** The declared minimum table width in px — the natural width the table never shrinks below. */
function tableMinWidth(markup: string): number {
  const raw = /min-width:\s*(\d+(?:\.\d+)?)px/u.exec(markup)?.[1];
  return raw === undefined ? Number.NaN : Number(raw);
}

describe('Records column visibility end to end', () => {
  it('shows every approved column when no preference has been saved', () => {
    expect(headerCells(renderPage())).toHaveLength(14);
    expect(columnWidths(renderPage())).toHaveLength(14);
  });

  it('hides a saved-away column from the header, the cells and the colgroup', () => {
    const markup = withStoredPreference(['mqis', 'plant'], () => renderPage());

    const headers = headerCells(markup);
    expect(headers).not.toContain('MQIS');
    expect(headers).not.toContain('PLANT');
    expect(headers).toHaveLength(12);
    // The remaining columns still come first, in the approved order.
    expect(headers.slice(0, 5)).toEqual(['NO', 'Registered Date', 'PIC', 'Approval', 'Title']);
    expect(columnWidths(markup)).toHaveLength(12);
    for (const row of dataRows(markup)) expect(row).toHaveLength(12);
  });

  it('restores the column when the preference no longer hides it', () => {
    expect(headerCells(withStoredPreference(['mqis'], () => renderPage()))).toHaveLength(13);
    expect(headerCells(withStoredPreference([], () => renderPage()))).toHaveLength(14);
  });

  it('ignores a corrupt stored preference and shows the default columns', () => {
    const globalRef = globalThis as { window?: unknown };
    const previous = globalRef.window;
    globalRef.window = {
      localStorage: { getItem: () => 'not json', setItem: () => {}, removeItem: () => {} },
    };
    try {
      expect(headerCells(renderPage())).toHaveLength(14);
    } finally {
      globalRef.window = previous;
    }
  });

  it('keeps the protected columns even if a stored preference hides everything', () => {
    const markup = withStoredPreference(
      REQUIRED_RECORDS_COLUMNS.map(({ key }) => key),
      () => renderPage(),
    );

    expect(headerCells(markup)).toEqual(['NO', 'Title', 'QPN']);
    for (const row of dataRows(markup)) expect(row).toHaveLength(3);
  });

  it('does not change which rows show, or their order, when columns are hidden', () => {
    const titles = (markup: string) => dataRows(markup).map((row) => row[0]);

    expect(titles(withStoredPreference(['mqis', 'plant', 'pic'], () => renderPage())))
      .toEqual(titles(renderPage()));
  });

  it('keeps the sorting controls for the columns that remain visible', () => {
    const markup = withStoredPreference(['mqis'], () => renderPage());
    const head = /<thead>[\s\S]*?<\/thead>/u.exec(markup)?.[0] ?? '';

    expect(headerCells(markup)).not.toContain('MQIS');
    expect(head).not.toContain('MQIS');
    // Sorting controls survive for the columns that remain, including the date columns.
    expect(head).toContain('aria-sort=');
    expect(head).toContain('aria-label="Registered Date: Ascending"');
    expect(head).toContain('aria-label="Ngày Pending: Ascending"');
    expect((head.match(/table-sort-button/gu) ?? []).length).toBeGreaterThan(5);
  });

  it('keeps the QPN actions usable when other columns are hidden', () => {
    const markup = withStoredPreference(
      ['mqis', 'registeredDate', 'pic', 'approval', 'plant', 'occurPlace', 'partGroup', 'defectName', 'condition', 'tatSystem', 'pendingDays'],
      () => renderPage(),
    );

    expect(headerCells(markup)).toEqual(['NO', 'Title', 'QPN']);
    expect(markup).toContain('class="qpn-action qpn-add"');
  });

  it('keeps the colgroup percentages summing to the whole table', () => {
    const total = (widths: string[]) => widths.reduce((sum, w) => sum + Number(w.replace(/[^\d.]/gu, '')), 0);

    expect(total(columnWidths(renderPage()))).toBeCloseTo(100, 2);
    expect(total(columnWidths(withStoredPreference(['mqis', 'plant'], () => renderPage())))).toBeCloseTo(100, 2);
  });

  it('shrinks the table minimum width as columns are hidden', () => {
    const all = columnWidths(renderPage());
    const fewer = columnWidths(withStoredPreference(['mqis', 'plant'], () => renderPage()));

    expect(fewer.length).toBeLessThan(all.length);
    // Hiding a column hands its share to the rest rather than leaving a gap.
    const widest = (widths: string[]) => Math.max(...widths.map((w) => Number(w.replace(/[^\d.]/gu, ''))));
    expect(widest(fewer)).toBeGreaterThan(widest(all));
    // The px floor is what makes the table scroll instead of crushing the text.
    expect(tableMinWidth(withStoredPreference(['mqis', 'plant'], () => renderPage())))
      .toBeLessThan(tableMinWidth(renderPage()));
    expect(renderPage()).toContain('style="min-width:');
  });

  it('keeps the horizontal scroll container', () => {
    expect(withStoredPreference(['mqis'], () => renderPage())).toContain('<div class="table-scroll">');
  });
});

describe('the manual "Tên lỗi" field in the workspace', () => {
  const edited: DefectRecord[] = [
    { ...records[0], manualDefectName: 'Scratch caught at final inspection' },
    records[1],
  ];

  function renderEdited(): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <RecordsWorkspace locale="en" records={edited} mode="records" onRecordsChanged={async () => {}} />
      </MemoryRouter>,
    );
  }

  it('shows the entered value on the row that has one, and the prompt on the row that does not', () => {
    // Rows come back in operational-priority order, not array order, so match on content.
    const names = dataRows(renderEdited()).map((row) => row[9]);

    expect(names).toContain('Scratch caught at final inspection');
    expect(names).toContain('Click to enter the defect name');
    expect(names.filter((name) => name === 'Click to enter the defect name')).toHaveLength(1);
  });

  it('never shows the imported defect details in that column', () => {
    const markup = renderEdited();

    // Both fixtures carry a source value; neither may leak into the manual column.
    expect(markup).not.toContain('Scratch on left panel');
    expect(markup).not.toContain('Weld point missing');
  });
});

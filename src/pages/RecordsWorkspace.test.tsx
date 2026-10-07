import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import RecordsWorkspace from './RecordsWorkspace';
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

function dataRows(markup: string): string[][] {
  const body = /<tbody>[\s\S]*?<\/tbody>/u.exec(markup)?.[0] ?? '';
  return (body.match(/<tr[^>]*class="[^"]*record-row[^"]*"[\s\S]*?<\/tr>/gu) ?? [])
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
      '—',
      '20 Sept 2026',
      '—',
      'Rejected (xét)',
      'SIEL',
      'Missing weld',
      '—',
      '—',
      'Weld point missing',
      '—',
      '—',
      '27 Sept 20267-day fallback',
      expect.stringMatching(/^-?\d+$/u),
    ]);
    expect(second).toEqual([
      '2',
      'MQIS-1',
      '01 Oct 2026',
      'Nguyen Van A',
      'Đợi đối sách',
      'TNP',
      'Body scratch',
      'Line 3',
      'Welding',
      'Scratch on left panel',
      '—',
      '—',
      '15 Oct 2026TNP deadline',
      expect.stringMatching(/^-?\d+$/u),
    ]);
  });

  it('keeps the table inside a horizontally scrolling container', () => {
    expect(renderPage()).toContain('<div class="table-scroll">');
  });
});

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ColumnsMenu from './ColumnsMenu';
import { DEFAULT_VISIBLE_COLUMNS, toggleVisibleColumn } from '../business/records/columnVisibility';
import { REQUIRED_RECORDS_COLUMNS } from '../business/records/recordsTable';
import { SELECTABLE_RECORDS_COLUMNS } from '../business/records/columnVisibility';
import type { RecordsTableColumnKey } from '../business/records/recordsTable';

const ALL: RecordsTableColumnKey[] = REQUIRED_RECORDS_COLUMNS.map(({ key }) => key);

function render(visible: ReadonlySet<RecordsTableColumnKey> = DEFAULT_VISIBLE_COLUMNS): string {
  return renderToStaticMarkup(
    <ColumnsMenu
      locale="en"
      columns={SELECTABLE_RECORDS_COLUMNS}
      visible={visible}
      onChange={() => {}}
    />,
  );
}

function checkboxes(markup: string): { checked: boolean; disabled: boolean; label: string }[] {
  return (markup.match(/<label class="columns-menu-item"[\s\S]*?<\/label>/gu) ?? []).map((item) => ({
    checked: /checked=""/u.test(item),
    disabled: /disabled=""/u.test(item),
    label: (/<span>([\s\S]*?)<\/span>/u.exec(item)?.[1] ?? '').trim(),
  }));
}

describe('Columns control', () => {
  it('is labelled "Columns" and sits with the other filter controls', () => {
    const markup = render();

    expect(markup).toContain('<summary>Columns</summary>');
    expect(markup).toContain('class="more-filters columns-control"');
  });

  it('lists a checkbox for each of the 14 approved columns, in the approved order', () => {
    expect(checkboxes(render()).map(({ label }) => label)).toEqual([
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
    expect(checkboxes(render())).toHaveLength(14);
  });

  it('does not offer the corrective CA badge', () => {
    expect(checkboxes(render()).map(({ label }) => label)).not.toContain('CA file');
  });

  it('starts with every column checked', () => {
    expect(checkboxes(render()).every(({ checked }) => checked)).toBe(true);
  });

  it('reflects an unchecked column as unticked, leaving the others ticked', () => {
    const boxes = checkboxes(render(toggleVisibleColumn(DEFAULT_VISIBLE_COLUMNS, 'mqis')));

    expect(boxes.find(({ label }) => label === 'MQIS')?.checked).toBe(false);
    expect(boxes.filter(({ checked }) => checked)).toHaveLength(ALL.length - 1);
  });

  it('locks NO, Title and QPN so the table cannot be emptied', () => {
    const boxes = checkboxes(render());

    for (const label of ['NO', 'Title', 'QPN']) {
      const box = boxes.find((item) => item.label === label);
      expect(box?.checked).toBe(true);
      expect(box?.disabled).toBe(true);
    }
    // Everything else stays freely hideable.
    expect(boxes.filter(({ disabled }) => disabled)).toHaveLength(3);
  });

  it('offers Select all and Reset default', () => {
    const markup = render();

    expect(markup).toContain('Select all');
    expect(markup).toContain('Reset default');
  });
});

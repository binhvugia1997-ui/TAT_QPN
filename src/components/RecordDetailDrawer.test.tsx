import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RecordDetailDrawer from './RecordDetailDrawer';
import type { DefectRecord } from '../models/defect-record';

/**
 * The drawer has to keep two kinds of value apart: what the import brought in, and what someone
 * typed at this machine. Both are shown, but in different places with different headings — a manual
 * entry listed under "source data" reads as if the spreadsheet contained it, which is how a
 * corrective-action field gets "verified" against an import that never had it.
 */

function record(overrides: Partial<DefectRecord> = {}): DefectRecord {
  return {
    id: 7,
    mgmtNo: 'MQIS-12',
    defectName: 'Scratch on bezel',
    status: 'In progress',
    manualDefectName: 'Deep scratch, left edge',
    manualCondition: 'Waiting for fixture',
    recordSource: 'import',
    version: 3,
    ...overrides,
  } as unknown as DefectRecord;
}

function render(overrides: Partial<DefectRecord> = {}): string {
  return renderToStaticMarkup(<RecordDetailDrawer locale="en" record={record(overrides)} onClose={async () => {}} onSaved={async () => {}} />);
}

/** The contents of the collapsed `<details>` block, i.e. the imported source data only. */
function sourceBlock(markup: string): string {
  // React renders `class`, not `className` — matching the JSX text here is how this assertion first
  // failed for the wrong reason.
  const start = markup.indexOf('<details class="source-details"');
  expect(start, 'the source block should be rendered').toBeGreaterThan(-1);
  return markup.slice(start, markup.indexOf('</details>', start));
}

describe('record detail drawer source list', () => {
  it('keeps the manual columns out of the imported source data', () => {
    const markup = render();
    const source = sourceBlock(markup);

    expect(source).not.toContain('Deep scratch, left edge');
    expect(source).not.toContain('Waiting for fixture');
    expect(source).not.toContain('manualDefectName');
    expect(source).not.toContain('manualCondition');
    // The imported values are still there, so the exclusion is about provenance and not a filter bug.
    expect(source).toContain('Scratch on bezel');
  });

  it('counts only the source fields in the summary, so the number is not off by two', () => {
    const markup = render();
    const block = sourceBlock(markup);
    const summary = Number(/<summary>[^<]*· (\d+)<\/summary>/u.exec(block)?.[1]);

    expect(Number.isFinite(summary)).toBe(true);
    // id, mgmtNo and defectName. Before the exclusion this read 5, with the two manual columns
    // counted as imported fields.
    expect(summary).toBe(3);
    // One more row than the count is rendered, and that is correct: the record's origin is added as
    // a labelled row of its own rather than dumped in as a raw `recordSource` field.
    const labels = [...block.matchAll(/<dt>([^<]*)<\/dt>/gu)].map((match) => match[1] as string);
    expect(labels).toEqual(['Defect Name', 'Id', 'Mgmt No', 'Record origin']);
    expect(labels).not.toContain('Manual Condition');
    expect(labels).not.toContain('Manual Defect Name');
  });

  it('reports the manual columns under a heading that says where they came from', () => {
    const markup = render();

    expect(markup).toContain('Entered on this PC');
    expect(markup).toContain('Deep scratch, left edge');
    expect(markup).toContain('Waiting for fixture');
    // The auto-generated label is fine here; what matters is the sentence under it, which is the
    // part that stops the value being mistaken for import data.
    expect(markup).toContain('never replaced by a re-import');
    expect(markup.indexOf('Entered on this PC')).toBeLessThan(markup.indexOf('<details class="source-details"'));
  });

  it('omits the manual section entirely when nothing has been entered', () => {
    const markup = render({ manualDefectName: null, manualCondition: null });

    expect(markup).not.toContain('Entered on this PC');
    // No empty shells: an operator who has not typed anything sees nothing, not two dashes.
    expect(markup).not.toContain('Manual Condition');
  });

  it('treats whitespace as nothing entered', () => {
    const markup = render({ manualDefectName: '   ', manualCondition: '' });

    expect(markup).not.toContain('Entered on this PC');
  });
});

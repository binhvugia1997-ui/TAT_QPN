import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import RecordDetailDrawer from './RecordDetailDrawer';
import { MQIS_DISPLAY_FIELD } from '../business/records/recordsTable';
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
    // id and defectName. Before the exclusions this read 6: the two manual columns counted as
    // imported fields, and the management number counted twice — once raw, once under its label.
    expect(summary).toBe(2);
    // One more row than the count is rendered, and that is correct: the record's origin is added as
    // a labelled row of its own rather than dumped in as a raw `recordSource` field.
    const labels = [...block.matchAll(/<dt>([^<]*)<\/dt>/gu)].map((match) => match[1] as string);
    expect(labels).toEqual(['Defect Name', 'Id', 'Record origin']);
    // The management number is not in the raw dump: it is shown under its own label above.
    expect(labels).not.toContain('Mgmt No');
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

describe('the drawer\'s MQIS field', () => {
  /** The component's own source, for the rules a render cannot express. */
  const componentSource = readFileSync(
    path.resolve(process.cwd(), 'src/components/RecordDetailDrawer.tsx'),
    'utf8',
  );
  /** Everything outside the collapsed source list, i.e. the parts the operator edits or reads first. */
  function mainSection(markup: string): string {
    const start = markup.indexOf('<form');
    const details = markup.indexOf('<details class="source-details"');
    return markup.slice(start, details === -1 ? markup.length : details);
  }

  it('shows the Management Number the table column shows', () => {
    const markup = render();

    expect(mainSection(markup)).toContain('Management Number (MQIS)');
    expect(mainSection(markup)).toContain('MQIS-12');
    // React emits `readOnly`, and the attribute is the whole point: the value is copyable and
    // announced, but it cannot be typed into.
    expect(mainSection(markup)).toContain('readOnly');
  });

  it('reads the number through the table\'s own field constant, so the two cannot drift', () => {
    // The bug this replaces was exactly a drift: the column was pointed at a different field than
    // the form, so the table and the drawer showed different "MQIS" values for one record.
    expect(componentSource).toContain('MQIS_DISPLAY_FIELD');
    expect(componentSource).toContain('canonicalCodeText');
    expect(MQIS_DISPLAY_FIELD).toBe('mgmtNo');
  });

  it('offers no independent MQIS input, and never sends mqisCode on save', () => {
    // `mqisCode` is a legacy extension column. As a form field it let two numbers claim to be the
    // record's MQIS; and because the old form initialised it from `record.mqisCode ?? ''`, every
    // unrelated edit also rewrote a stored null as an empty string.
    // Prose about the field is allowed; touching it is not. A property read or a patch key would
    // both mean the drawer still treats it as an input it owns.
    expect(componentSource).not.toMatch(/\.mqisCode\b/u);
    expect(componentSource).not.toMatch(/^\s*mqisCode:/mu);
    expect(componentSource).not.toMatch(/update\('mqisCode'/u);
  });

  it('keeps the legacy extension visible as source data instead of as an input', () => {
    const markup = render({ mqisCode: 'MQIS-8891' });
    const source = sourceBlock(markup);

    expect(source).toContain('Mqis Code');
    expect(source).toContain('MQIS-8891');
  });

  it('does not fall back to the extension when the management number is blank', () => {
    const markup = render({ mgmtNo: '   ', mqisCode: 'MQIS-8891' });

    // The field is empty, not secretly the other number: an operator who sees a blank MQIS row
    // looks for the missing import column, which is the truth.
    const row = mainSection(markup).match(/Management Number \(MQIS\)<\/span><input[^>]*value="([^"]*)"/u);
    expect(row?.[1]).toBe('');
    expect(mainSection(markup)).not.toContain('MQIS-8891');
  });

  it('shows the number once in the form and not again in the raw dump', () => {
    const markup = render();

    // The header line and the labelled field are the same derived value, so they can never
    // disagree; the raw list omits it rather than showing a third copy nobody labelled.
    expect(mainSection(markup).split('MQIS-12').length - 1).toBe(1);
    expect(sourceBlock(markup)).not.toContain('MQIS-12');
    expect(markup).toContain('never edited');
  });

  it('still keys the header on the record id when there is no number at all', () => {
    const markup = render({ mgmtNo: '' });

    expect(markup).toContain('#7');
  });
});

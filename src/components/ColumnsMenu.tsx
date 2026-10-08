import type { Locale } from '../i18n';
import { translate } from '../i18n';
import type { RecordsTableColumn, RecordsTableColumnKey } from '../business/records/recordsTable';
import {
  isProtectedColumn,
  resetVisibleColumns,
  selectAllColumns,
  toggleVisibleColumn,
} from '../business/records/columnVisibility';

interface ColumnsMenuProps {
  locale: Locale;
  /** The selectable (approved) columns, in order. */
  columns: readonly RecordsTableColumn[];
  visible: ReadonlySet<RecordsTableColumnKey>;
  onChange: (next: ReadonlySet<RecordsTableColumnKey>) => void;
  /**
   * Offers "reset column widths" inside the same popover that controls visibility, so one
   * control owns the table layout. Omitted where the workspace has no resizable widths.
   */
  onResetWidths?: () => void;
}

/**
 * Compact "Columns" popover next to the Record filters. Purely a display toggle over the
 * approved Records columns — it never touches record data, filtering, sorting or TAT.
 * Protected columns stay checked and disabled so the table cannot be emptied.
 *
 * Widths are handled here too rather than in a second control: a column that is hidden keeps its
 * manual width (visibility and width are separate preferences), and "Reset column widths" clears
 * every manual width at once instead of forcing the operator to find each divider.
 */
export default function ColumnsMenu({ locale, columns, visible, onChange, onResetWidths }: ColumnsMenuProps) {
  return (
    <details className="more-filters columns-control">
      <summary>{translate(locale, 'columnsControl')}</summary>
      <div className="more-filter-content columns-menu-content">
        <div className="columns-menu-actions">
          <button
            type="button"
            onClick={() => onChange(selectAllColumns(columns.map(({ key }) => key)))}
          >
            {translate(locale, 'columnsSelectAll')}
          </button>
          <button
            type="button"
            onClick={() => onChange(resetVisibleColumns(columns.map(({ key }) => key)))}
          >
            {translate(locale, 'columnsReset')}
          </button>
          {onResetWidths && (
            <button type="button" onClick={onResetWidths}>
              {translate(locale, 'columnsResetWidths')}
            </button>
          )}
        </div>
        <div className="columns-menu-list">
          {columns.map(({ key, label }) => {
            const locked = isProtectedColumn(key);
            return (
              <label className="columns-menu-item" key={key}>
                <input
                  type="checkbox"
                  checked={visible.has(key)}
                  disabled={locked}
                  title={locked ? translate(locale, 'columnsAlwaysVisible') : undefined}
                  onChange={() => onChange(toggleVisibleColumn(visible, key))}
                />
                <span>{translate(locale, label)}</span>
              </label>
            );
          })}
        </div>
      </div>
    </details>
  );
}

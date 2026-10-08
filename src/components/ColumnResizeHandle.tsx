import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Locale } from '../i18n';
import { translate } from '../i18n';
import { resizedColumnWidth } from '../business/records/columnWidths';

/**
 * A drag handle sitting on a Records table header divider.
 *
 * Deliberately pointer-based rather than `<input type="range">`-based: the handle is a column
 * boundary, not a control in the cell, and it must not steal the row's double-click-to-open
 * behaviour. It is still keyboard reachable — the host element is a real button, and arrow keys
 * step the width — so resizing does not require a mouse.
 *
 * The width arithmetic lives in `columnWidths.ts` (`resizedColumnWidth`); this component only
 * tracks the gesture and reports the next width. A drag is committed on pointer-up, and
 * `onResizeEnd` is what should persist the preference, so localStorage is written once per drag
 * rather than once per pixel.
 *
 * `onResizeEnd(-1)` is the reset signal: a double-click on the divider asks the host to return
 * that column to its approved default width. `-1` is not a candidate width — it is outside
 * `MIN_RECORDS_COLUMN_WIDTH`, and a host must treat it as "clear this column", never clamp it.
 */

/** Emitted from `onResizeEnd` to mean "drop the manual width and use the approved default". */
export const RESET_COLUMN_WIDTH_SENTINEL = -1;

/** Arrow-key step, in px. Shift takes a coarser one, matching common splitter conventions. */
const KEYBOARD_STEP_PX = 8;
const KEYBOARD_COARSE_STEP_PX = 40;

export interface ColumnResizeHandleProps {
  locale: Locale;
  /** Stable column identity, used only for accessible naming. */
  columnLabel: string;
  /** The column's current width in px. */
  width: number;
  onResize: (nextWidth: number) => void;
  /**
   * Called once when a gesture finishes, so persistence happens once per drag. Receives
   * `RESET_COLUMN_WIDTH_SENTINEL` when the divider was double-clicked.
   */
  onResizeEnd?: (nextWidth: number) => void;
}

export default function ColumnResizeHandle({
  locale,
  columnLabel,
  width,
  onResize,
  onResizeEnd,
}: ColumnResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ startWidth: number; startX: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;

  const widthFromPointer = useCallback((clientX: number) => {
    const start = gesture.current;
    if (!start) return null;
    return resizedColumnWidth({
      startWidth: start.startWidth,
      startPointerClientX: start.startX,
      pointerClientX: clientX,
    });
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // Left button / primary contact only, and never while another drag is open.
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = { startWidth: latest.current, startX: event.clientX };
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!gesture.current) return;
    event.preventDefault();
    const next = widthFromPointer(event.clientX);
    if (next !== null) onResize(next);
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (!gesture.current) return;
    event.preventDefault();
    const next = widthFromPointer(event.clientX);
    gesture.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (next !== null) onResizeEnd?.(next);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEYBOARD_COARSE_STEP_PX : KEYBOARD_STEP_PX;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') {
      next = resizedColumnWidth({ startWidth: latest.current, startPointerClientX: 0, pointerClientX: -step });
    } else if (event.key === 'ArrowRight') {
      next = resizedColumnWidth({ startWidth: latest.current, startPointerClientX: 0, pointerClientX: step });
    } else if (event.key === 'Escape') {
      // Abandon an in-progress drag without committing it.
      if (!gesture.current) return;
      gesture.current = null;
      setDragging(false);
      event.preventDefault();
      event.stopPropagation();
      return;
    } else {
      return;
    }
    // The header cell owns a sort button; a keystroke here must not activate it.
    event.preventDefault();
    event.stopPropagation();
    onResize(next);
    onResizeEnd?.(next);
  };

  // A pointer-up that lands outside the handle still has to end the gesture.
  useEffect(() => {
    if (!dragging) return;
    const cancel = () => {
      gesture.current = null;
      setDragging(false);
    };
    window.addEventListener('pointercancel', cancel);
    return () => window.removeEventListener('pointercancel', cancel);
  }, [dragging]);

  return (
    <span
      className={`column-resize-handle${dragging ? ' column-resize-active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={translate(locale, 'columnResizeLabel', { column: columnLabel })}
      aria-valuenow={width}
      title={translate(locale, 'columnResizeHelp')}
      tabIndex={0}
      data-tnp-row-interactive=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => {
        // Double-click on the divider resets the column; it must not open the detail drawer.
        event.preventDefault();
        event.stopPropagation();
        onResizeEnd?.(RESET_COLUMN_WIDTH_SENTINEL);
      }}
    />
  );
}

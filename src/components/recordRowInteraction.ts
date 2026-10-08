/**
 * Decides whether a double-click on a Records row should open the Detail drawer.
 *
 * The row itself is no longer a single-click target: a single click must do nothing so that
 * selecting text or landing on a control is never mistaken for "open the record". The drawer
 * opens on double-click, but only in a non-interactive part of the row — double-clicking the
 * QPN controls or an inline editor must keep working as itself instead of also launching the
 * drawer.
 */

/**
 * Any of these, or an ancestor that carries the opt-out attribute, swallows the double-click.
 * The attribute covers the padding around a control (e.g. the cell that hosts the QPN
 * buttons) where `target` is the cell rather than the button.
 */
export const DRAWER_BLOCKING_SELECTOR =
  'button, a, input, select, textarea, [contenteditable], [data-tnp-row-interactive]';

/** Anything `closest` can be called on, so this stays testable without a DOM implementation. */
export interface ClosestCapable {
  closest(selector: string): unknown;
}

/**
 * True when the double-click landed on something the row must leave alone.
 * Returns false — "not interactive, let the drawer open" — for a missing target or an
 * environment where `closest` is unavailable, so a degraded DOM degrades to the old behaviour
 * rather than making the drawer unreachable.
 */
export function isInteractiveTarget(target: ClosestCapable | null | undefined): boolean {
  if (!target || typeof target.closest !== 'function') return false;
  return target.closest(DRAWER_BLOCKING_SELECTOR) !== null;
}

/** True when a double-click should open the Detail drawer. */
export function shouldOpenDrawer(target: ClosestCapable | null | undefined): boolean {
  return !isInteractiveTarget(target);
}

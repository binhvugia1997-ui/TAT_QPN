import { describe, expect, it } from 'vitest';
import { DRAWER_BLOCKING_SELECTOR, isInteractiveTarget, shouldOpenDrawer } from './recordRowInteraction';

/**
 * `closest` is the whole decision, so the stub reports exactly which ancestor the browser
 * would have matched — `null` for plain row chrome, the node itself for a control.
 */
function target(matched: unknown, selectorSeen: string[] = []) {
  return {
    closest(selector: string) {
      selectorSeen.push(selector);
      return matched;
    },
  };
}

describe('row double-click guard', () => {
  it('opens the drawer on plain row chrome', () => {
    const plain = target(null);

    expect(isInteractiveTarget(plain)).toBe(false);
    expect(shouldOpenDrawer(plain)).toBe(true);
  });

  it('stays out of the way of buttons, links, inputs and selects', () => {
    for (const control of ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']) {
      const hit = target({ tagName: control });

      expect(isInteractiveTarget(hit)).toBe(true);
      expect(shouldOpenDrawer(hit)).toBe(false);
    }
  });

  it('honours the opt-out attribute used by the QPN and Tên lỗi cells', () => {
    expect(shouldOpenDrawer(target({ dataset: { tnpRowInteractive: '' } }))).toBe(false);
    expect(DRAWER_BLOCKING_SELECTOR).toContain('data-tnp-row-interactive');
  });

  it('asks for the whole blocking selector in one call, so controls cannot slip through', () => {
    const seen: string[] = [];
    isInteractiveTarget(target(null, seen));

    expect(seen).toEqual([DRAWER_BLOCKING_SELECTOR]);
  });

  it('falls back to opening the drawer when the target is missing or has no closest', () => {
    expect(shouldOpenDrawer(null)).toBe(true);
    expect(shouldOpenDrawer(undefined)).toBe(true);
    expect(shouldOpenDrawer({} as { closest: (selector: string) => unknown })).toBe(true);
  });
});

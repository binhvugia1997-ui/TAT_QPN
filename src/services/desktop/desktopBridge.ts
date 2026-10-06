/**
 * Access to the desktop wrapper, when the UI is running inside it.
 *
 * In a plain browser tab `window.tnpDesktop` is simply absent and every helper here returns
 * null, so the same React code serves both the browser build and the Windows TEST build with
 * no branching in the pages. Nothing here reaches the filesystem: the bridge is the only
 * path, and it exposes a fixed set of actions with no way to pass a path in.
 */
import type { TnpDesktopBridge } from '../../../desktop/types/tnpDesktop';

export function getDesktopBridge(): TnpDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.tnpDesktop;
  return bridge && bridge.isDesktop === true ? bridge : null;
}

export function isDesktopRuntime(): boolean {
  return getDesktopBridge() !== null;
}

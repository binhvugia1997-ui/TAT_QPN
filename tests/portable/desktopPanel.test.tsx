import { describe, expect, it, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DesktopPanel from '../../src/components/DesktopPanel';
import type { TnpDesktopBridge, TnpDesktopState } from '../../desktop/types/tnpDesktop';

/**
 * The owner's panel is the only place an operator can find out whether the update folder is right,
 * so the control has to be *there* — reachable, labelled from i18n, and disabled while a check is
 * in flight. These are render assertions on purpose: the panel reads `window.tnpDesktop`, and the
 * interesting branch (what a validation result looks like) is decided in the main process, where it
 * is tested directly by `updateSourceValidation.test.ts`.
 */

const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (realWindow) Object.defineProperty(globalThis, 'window', realWindow);
  else delete (globalThis as { window?: unknown }).window;
});

function stubBridge(overrides: Partial<TnpDesktopBridge> = {}): void {
  const state: TnpDesktopState = {
    server: { running: true, port: 9000, baseUrl: 'http://127.0.0.1:9000', pid: 1 },
    status: null,
    statusError: null,
    layout: {
      root: 'C:\\TNP',
      dataDir: 'C:\\TNP\\data',
      backupsDir: 'C:\\TNP\\backups',
      reportsDir: 'C:\\TNP\\reports',
      databaseFile: 'C:\\TNP\\data\\tnp.sqlite',
      portable: true,
      rootNote: '',
    },
    settings: {
      lanEnabled: false,
      port: 9000,
      workstationLabel: '',
      updateSource: '\\\\192.168.103.12\\ReportExtractor_Update\\TAT QPN\\updates',
      updateChannel: 'test',
      updateChecksEnabled: true,
    },
    security: { authentication: false, tls: false, warning: 'no auth' },
  };
  const bridge = {
    isDesktop: true,
    getDesktopState: async () => state,
    validateUpdateSource: async () => ({
      state: 'ready' as const,
      source: '',
      message: 'Ready.',
      usable: true,
      manifest: null,
      channelMatches: true,
      checkedAt: new Date(0).toISOString(),
    }),
    ...overrides,
  } as unknown as TnpDesktopBridge;
  Object.defineProperty(globalThis, 'window', {
    value: { tnpDesktop: bridge, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } },
    configurable: true,
    writable: true,
  });
}

describe('desktop panel update section', () => {
  it('renders nothing at all outside the desktop wrapper', () => {
    const markup = renderToStaticMarkup(<DesktopPanel locale="en" />);

    // A browser tab must not see owner-only controls, not even disabled ones.
    expect(markup).toBe('');
  });

  it('offers a folder check next to the check-for-updates action', () => {
    stubBridge();
    const markup = renderToStaticMarkup(<DesktopPanel locale="en" />);

    expect(markup).toContain('Check update folder');
    expect(markup).toContain('Check for updates');
    // The two are different actions and must not be conflated: one reads the share, the other asks
    // the updater to move to a new build.
    expect(markup.match(/<button/gu)?.length).toBeGreaterThanOrEqual(5);
  });

  it('explains that a check neither writes nor downloads', () => {
    stubBridge();
    const markup = renderToStaticMarkup(<DesktopPanel locale="en" />);

    expect(markup).toContain('It never writes to the folder');
  });

  it('says so when update information is unavailable, instead of showing an empty field', () => {
    stubBridge();
    const markup = renderToStaticMarkup(<DesktopPanel locale="vi" />);

    // The development checkout has no updater, and a blank "Installed build" reads like a broken
    // install rather than an unsupported context.
    expect(markup).toContain('chỉ có trong bản portable');
  });

  it('bounds the source field to the cap the main process applies', () => {
    stubBridge();
    const markup = renderToStaticMarkup(<DesktopPanel locale="en" />);

    expect(markup).toContain('LAN update folder');
    // `normalizeSettings` slices the stored value to 500 characters. If the field allowed more, an
    // operator could type a path that is quietly truncated on save and then fails to resolve.
    expect(markup).toContain('maxLength="500"');
    // The example in the field is the real default folder, spaces included: an operator copying the
    // shape out of the placeholder must copy the quoting rule with it.
    expect(markup).toContain('TAT QPN');
  });

  it('shows the fallback instead of an installed-build row when there is no updater', () => {
    stubBridge();
    const markup = renderToStaticMarkup(<DesktopPanel locale="en" />);

    // A static render never runs the effect that loads state, so this is exactly what a development
    // checkout looks like: an explanation, not an empty "Installed build" row that reads as damage.
    expect(markup).not.toContain('Installed build');
    expect(markup).not.toContain('Reading updates from');
    expect(markup).toContain('available in the installed portable build only');
  });
});

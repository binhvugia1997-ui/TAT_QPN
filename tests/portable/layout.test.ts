import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertUsableRoot,
  resolvePortableLayout,
} from '../../desktop/main/paths';
import type { LayoutProbe } from '../../desktop/main/paths';

const writableProbe: LayoutProbe = { isWritableDirectory: () => true };
const readOnlyProbe: LayoutProbe = { isWritableDirectory: () => false };

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'tnp-phase6-'));
}

describe('portable layout', () => {
  it('stores data beside the app when that folder is writable', () => {
    const executableDir = tempRoot();
    const layout = resolvePortableLayout({
      executableDir,
      userDataDir: path.join(tempRoot(), 'userData'),
      appDir: path.join(executableDir, 'resources', 'app'),
      probe: writableProbe,
    });

    expect(layout.portable).toBe(true);
    expect(layout.root).toBe(executableDir);
    expect(layout.dataDir).toBe(path.join(executableDir, 'data'));
    expect(layout.backupsDir).toBe(path.join(executableDir, 'backups'));
    expect(layout.reportsDir).toBe(path.join(executableDir, 'reports'));
    expect(layout.databaseFile).toBe(path.join(executableDir, 'data', 'tnp.db'));
    expect(layout.settingsFile).toBe(path.join(executableDir, 'data', 'desktop-settings.json'));
  });

  it('falls back to the per-user folder and says why when the app folder is read-only', () => {
    const executableDir = tempRoot();
    const userDataDir = path.join(tempRoot(), 'userData');
    const layout = resolvePortableLayout({
      executableDir,
      userDataDir,
      appDir: executableDir,
      probe: readOnlyProbe,
    });

    expect(layout.portable).toBe(false);
    expect(layout.root).toBe(userDataDir);
    expect(layout.dataDir).toBe(path.join(userDataDir, 'data'));
    // The owner has to be told where their data went; a silent relocation is unacceptable.
    expect(layout.rootNote).toContain('not writable');
    expect(layout.rootNote).toContain(userDataDir);
  });

  it('honours an explicit TNP_DATA_ROOT over both candidates', () => {
    const explicit = tempRoot();
    const layout = resolvePortableLayout({
      executableDir: tempRoot(),
      userDataDir: tempRoot(),
      appDir: tempRoot(),
      env: { TNP_DATA_ROOT: explicit },
      probe: readOnlyProbe,
    });

    expect(layout.root).toBe(explicit);
    expect(layout.rootNote).toContain('TNP_DATA_ROOT');
  });

  it('lets the three owner folders be redirected individually', () => {
    const root = tempRoot();
    const layout = resolvePortableLayout({
      executableDir: root,
      userDataDir: root,
      appDir: root,
      env: {
        TNP_DATA_DIR: path.join(root, 'db'),
        TNP_BACKUPS_DIR: path.join(root, 'snapshots'),
        TNP_REPORTS_DIR: path.join(root, 'files'),
      },
      probe: writableProbe,
    });

    expect(layout.dataDir).toBe(path.join(root, 'db'));
    expect(layout.backupsDir).toBe(path.join(root, 'snapshots'));
    expect(layout.reportsDir).toBe(path.join(root, 'files'));
    expect(layout.databaseFile).toBe(path.join(root, 'db', 'tnp.db'));
  });

  it('finds the packaged server runtime, seed and web bundle', () => {
    const appDir = path.join(tempRoot(), 'app');
    mkdirSync(path.join(appDir, 'server-runtime', 'server'), { recursive: true });
    mkdirSync(path.join(appDir, 'seed'), { recursive: true });
    mkdirSync(path.join(appDir, 'web'), { recursive: true });
    writeFileSync(path.join(appDir, 'server-runtime', 'server', 'index.js'), '// compiled server');
    writeFileSync(path.join(appDir, 'seed', 'legacy-base-data.json'), '[]');
    writeFileSync(path.join(appDir, 'web', 'index.html'), '<html></html>');

    const layout = resolvePortableLayout({
      executableDir: tempRoot(),
      userDataDir: tempRoot(),
      appDir,
      probe: writableProbe,
    });

    expect(layout.serverEntry).toBe(path.join(appDir, 'server-runtime', 'server', 'index.js'));
    expect(layout.seedFile).toBe(path.join(appDir, 'seed', 'legacy-base-data.json'));
    expect(layout.staticDir).toBe(path.join(appDir, 'web'));
  });

  it('refuses a filesystem root as the data folder', () => {
    expect(() => assertUsableRoot('/')).toThrow(/filesystem root/u);
    expect(() => assertUsableRoot('   ')).toThrow(/empty/u);
    expect(() => assertUsableRoot('/home/user/TNP')).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  defaultSettings,
  normalizeSettings,
  readSettings,
  writeSettings,
} from '../../desktop/main/settings';
import type { SettingsStore } from '../../desktop/main/settings';

/** In-memory stand-in for the settings file. */
function memoryStore(initial: Record<string, string> = {}): SettingsStore & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    readFile: (file) => (file in files ? files[file]! : null),
    writeFile: (file, contents) => { files[file] = contents; },
  };
}

describe('desktop settings', () => {
  it('defaults to LAN off on the standard port', () => {
    expect(defaultSettings.lanEnabled).toBe(false);
    expect(defaultSettings.port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(8787);
  });

  it('returns safe defaults when the file is missing', () => {
    const store = memoryStore();
    expect(readSettings('/absent/desktop-settings.json', store)).toEqual(defaultSettings);
  });

  it('returns safe defaults when the file is corrupt rather than failing to start', () => {
    const store = memoryStore({ '/data/desktop-settings.json': '{ "lanEnabled": tru' });
    expect(readSettings('/data/desktop-settings.json', store)).toEqual(defaultSettings);
  });

  it('only enables LAN on an explicit boolean true', () => {
    // Anything truthy-but-not-true must stay off: LAN exposure is never accidental.
    expect(normalizeSettings({ lanEnabled: 'yes' }).lanEnabled).toBe(false);
    expect(normalizeSettings({ lanEnabled: 1 }).lanEnabled).toBe(false);
    expect(normalizeSettings({ lanEnabled: null }).lanEnabled).toBe(false);
    expect(normalizeSettings({ lanEnabled: true }).lanEnabled).toBe(true);
  });

  it('clamps an out-of-range or invalid port back to the default', () => {
    expect(normalizeSettings({ port: 80 }).port).toBe(DEFAULT_PORT);
    expect(normalizeSettings({ port: 70_000 }).port).toBe(DEFAULT_PORT);
    expect(normalizeSettings({ port: 'nope' }).port).toBe(DEFAULT_PORT);
    expect(normalizeSettings({ port: 8123 }).port).toBe(8123);
  });

  it('truncates an over-long workstation label', () => {
    const normalized = normalizeSettings({ workstationLabel: `  ${'x'.repeat(200)}  ` });
    expect(normalized.workstationLabel).toHaveLength(60);
    expect(normalized.workstationLabel).not.toContain(' ');
  });

  it('survives a write/read round trip', () => {
    const store = memoryStore();
    const file = '/data/desktop-settings.json';
    writeSettings(
      file,
      {
        lanEnabled: true,
        port: 9001,
        workstationLabel: 'Line 3 - QC',
        updateSource: '\\\\BUILD-PC\\TNP_Update\\Test',
        updateChannel: 'test',
        updateChecksEnabled: true,
      },
      store,
    );
    expect(readSettings(file, store)).toEqual({
      lanEnabled: true,
      port: 9001,
      workstationLabel: 'Line 3 - QC',
      updateSource: '\\\\BUILD-PC\\TNP_Update\\Test',
      updateChannel: 'test',
      updateChecksEnabled: true,
    });
  });

  it('normalizes on write so a bad value is never persisted', () => {
    const store = memoryStore();
    const file = '/data/desktop-settings.json';
    writeSettings(file, { lanEnabled: 'yes' as unknown as boolean, port: 12, workstationLabel: 'ok' }, store);
    expect(JSON.parse(store.files[file]!)).toEqual({
      lanEnabled: false,
      port: DEFAULT_PORT,
      workstationLabel: 'ok',
      updateSource: '',
      updateChannel: 'test',
      updateChecksEnabled: true,
    });
  });
});

describe('the update source settings', () => {
  it('keeps a UNC path intact, because backslashes are legitimate there', () => {
    const normalized = normalizeSettings({ updateSource: '  \\\\BUILD-PC\\TNP_Update\\Test  ' });
    expect(normalized.updateSource).toBe('\\\\BUILD-PC\\TNP_Update\\Test');
  });

  it('bounds the length so a corrupt settings file cannot inflate it', () => {
    expect(normalizeSettings({ updateSource: 'x'.repeat(900) }).updateSource).toHaveLength(500);
    expect(normalizeSettings({ updateSource: 42 }).updateSource).toBe('');
  });

  it('falls back to the test channel for anything that is not a simple identifier', () => {
    expect(normalizeSettings({ updateChannel: 'production' }).updateChannel).toBe('production');
    expect(normalizeSettings({ updateChannel: 'TEST' }).updateChannel).toBe('test');
    expect(normalizeSettings({ updateChannel: '../evil' }).updateChannel).toBe('test');
    expect(normalizeSettings({}).updateChannel).toBe('test');
  });

  it('treats checking as enabled unless it is explicitly switched off', () => {
    expect(normalizeSettings({}).updateChecksEnabled).toBe(true);
    expect(normalizeSettings({ updateChecksEnabled: 'no' }).updateChecksEnabled).toBe(true);
    expect(normalizeSettings({ updateChecksEnabled: false }).updateChecksEnabled).toBe(false);
    expect(normalizeSettings({ updateChecksEnabled: true }).updateChecksEnabled).toBe(true);
  });

  it('leaves update checking off when no source is configured', () => {
    expect(defaultSettings.updateSource).toBe('');
    expect(defaultSettings.updateChecksEnabled).toBe(true);
  });
});

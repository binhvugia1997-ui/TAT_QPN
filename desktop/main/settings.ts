/**
 * Desktop settings, persisted beside the database in `data/desktop-settings.json`.
 *
 * Only two things live here today: whether the owner switched LAN access on, and the port
 * the desktop last started on. Both are owner-controlled, both require a server restart to
 * take effect, and a corrupt or missing file must degrade to safe defaults rather than
 * break startup — LAN off, default port.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeUpdateSource } from '../../src/utils/uncPath';

export const DEFAULT_PORT = 8787;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

export interface DesktopSettings {
  lanEnabled: boolean;
  port: number;
  /** Free-form owner label written into the audit trail for this workstation. */
  workstationLabel: string;
  /**
   * LAN folder holding `version.json` and update packages, for example
   * `\\BUILD-PC\TNP_Update\Test`. Empty means update checking is off. Never hard-coded.
   */
  updateSource: string;
  /** Update channel this PC accepts. TEST builds use `test`. */
  updateChannel: string;
  /** Owner can switch the background check off entirely. */
  updateChecksEnabled: boolean;
}

export const DEFAULT_UPDATE_CHANNEL = 'test';

export const defaultSettings: DesktopSettings = {
  lanEnabled: false,
  port: DEFAULT_PORT,
  workstationLabel: '',
  updateSource: '',
  updateChannel: DEFAULT_UPDATE_CHANNEL,
  updateChecksEnabled: true,
};

export interface SettingsStore {
  readFile(file: string): string | null;
  writeFile(file: string, contents: string): void;
}

export const realSettingsStore: SettingsStore = {
  readFile(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  writeFile(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
  },
};

export function readSettings(file: string, store: SettingsStore = realSettingsStore): DesktopSettings {
  const raw = store.readFile(file);
  if (!raw) return { ...defaultSettings };
  try {
    return normalizeSettings(JSON.parse(raw) as unknown);
  } catch {
    // A hand-edited or half-written file must not stop the desktop from starting.
    return { ...defaultSettings };
  }
}

export function writeSettings(
  file: string,
  settings: DesktopSettings,
  store: SettingsStore = realSettingsStore,
): DesktopSettings {
  const normalized = normalizeSettings(settings);
  store.writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

/** Clamps and coerces anything untrusted into the known shape; never throws. */
export function normalizeSettings(input: unknown): DesktopSettings {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const port = Number(source.port);
  const label = typeof source.workstationLabel === 'string' ? source.workstationLabel : '';
  const updateSource = typeof source.updateSource === 'string' ? source.updateSource : '';
  const channel = typeof source.updateChannel === 'string' ? source.updateChannel : '';
  return {
    // Only a real boolean true enables LAN; absent/garbage stays off.
    lanEnabled: source.lanEnabled === true,
    port: Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : DEFAULT_PORT,
    workstationLabel: label.trim().slice(0, 60),
    // An update source is a path, so it is trimmed and length-bounded but otherwise opaque:
    // UNC paths legitimately start with backslashes, and every one of them is stored here with
    // its separators normalised (single runs, no trailing separator, `/` folded to `\`). That
    // normalisation is the shared `normalizeUpdateSource` rule rather than a local trim, so the
    // value a publisher writes and the value a client reads cannot disagree about the same share.
    updateSource: normalizeUpdateSource(updateSource).slice(0, 500),
    updateChannel: /^[a-z0-9-]{1,32}$/u.test(channel.trim()) ? channel.trim() : DEFAULT_UPDATE_CHANNEL,
    // Absent means enabled; only an explicit false switches the check off.
    updateChecksEnabled: source.updateChecksEnabled !== false,
  };
}

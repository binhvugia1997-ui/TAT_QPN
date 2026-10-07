/**
 * Fixtures for the Phase 7 update tests.
 *
 * Nothing here fakes the code under test: the manifest parser, the hash, the ZIP reader, the
 * copy loop, the install plan and the helper are all the real modules. What is fabricated is
 * the *world* around them — a runtime folder, a production database and an update share — so
 * the data-safety rules can be proven against real bytes on a real filesystem.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TNP_LAUNCHER_NAME } from '../../desktop/update/packageInspect';
import { resolveUpdateLayout } from '../../desktop/update/layout';
import type { UpdateLayout } from '../../desktop/update/layout';

export const FIXTURE_VERSION = '0.3.0';
export const FIXTURE_BUILD = 7;
export const FIXTURE_PRODUCT = 'TNP Defect Management TEST';

/** Production bytes: what must survive an update byte-for-byte. */
/**
 * Production bytes and text, held in both forms so a test can compare either way without a
 * Buffer/string mismatch silently passing.
 */
export const PRODUCTION_DB_TEXT = 'SQLite format 3 -- this is the OWNER PC production database, it must never change';
export const PRODUCTION_DB = Buffer.from(PRODUCTION_DB_TEXT, 'utf8');
export const PRODUCTION_SETTINGS = '{"lanEnabled":false,"port":8787,"workstationLabel":"OWNER-PC"}';
export const PRODUCTION_BACKUP = 'a real SQLite backup taken by the server';
export const PRODUCTION_REPORT = '%PDF-1.4 a report the owner attached';

export function assertText(file: string, expected: string): void {
  const actual = fs.readFileSync(file, 'utf8');
  if (actual !== expected) throw new Error(`${file} changed: expected ${expected.length} chars, found ${actual.length}`);
}

export function createTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tnp-update-${label}-`));
}

export interface RuntimeFixture {
  runtimeRoot: string;
  dataDir: string;
  backupsDir: string;
  reportsDir: string;
  updateDir: string;
  dbFile: string;
  settingsFile: string;
  backupFile: string;
  reportFile: string;
  cleanup: () => void;
}

/**
 * Builds a runtime folder shaped like the real portable build: launcher, Electron markers,
 * `resources/app/...`, plus the three persistent directories holding production data.
 */
export function createRuntimeFixture(
  parent: string,
  options: { version?: string; build?: number; label?: string } = {},
): RuntimeFixture {
  const version = options.version ?? FIXTURE_VERSION;
  const build = options.build ?? FIXTURE_BUILD;
  const root = fs.mkdtempSync(path.join(parent, `runtime-${options.label ?? 'a'}-`));

  const write = (relative: string, content: string | Buffer): void => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  write(TNP_LAUNCHER_NAME, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
  write('ffmpeg.dll', 'stub-ffmpeg');
  write('libEGL.dll', 'stub-egl');
  write('v8_context_snapshot.bin', 'stub-snapshot');
  write('resources/app/package.json', JSON.stringify({
    name: 'tnp-defect-management-test',
    productName: FIXTURE_PRODUCT,
    version,
    tnpBuild: build,
    type: 'commonjs',
    main: 'dist/desktop/main/main.js',
  }, null, 2));
  write('resources/app/dist/desktop/main/main.js', '// compiled main');
  write('resources/app/dist/desktop/preload/preload.js', '// compiled preload');
  write('resources/app/dist/desktop/update/helperMain.js', '// compiled updater helper');
  write('resources/app/dist/server/startupSignals.js', '// compiled startup signals');
  write('resources/app/server-runtime/server/index.js', '// compiled server entry');
  write('resources/app/server-runtime/package.json', JSON.stringify({ type: 'commonjs' }));
  write('resources/app/seed/legacy-base-data.json', '[]');
  write('resources/app/web/index.html', '<!doctype html><div id="root"></div>');
  write('resources/app/web/assets/index-abc123.js', 'console.log("bundle");');

  const dataDir = path.join(root, 'data');
  const backupsDir = path.join(root, 'backups');
  const reportsDir = path.join(root, 'reports');
  for (const dir of [dataDir, backupsDir, reportsDir]) fs.mkdirSync(dir, { recursive: true });

  const dbFile = path.join(dataDir, 'tnp.db');
  const settingsFile = path.join(dataDir, 'desktop-settings.json');
  const backupFile = path.join(backupsDir, 'tnp-20261006-manual-abc123.db');
  const reportFile = path.join(reportsDir, 'record-1-report.pdf');
  fs.writeFileSync(dbFile, PRODUCTION_DB);
  fs.writeFileSync(settingsFile, PRODUCTION_SETTINGS);
  fs.writeFileSync(backupFile, PRODUCTION_BACKUP);
  fs.writeFileSync(reportFile, PRODUCTION_REPORT);
  fs.writeFileSync(path.join(dataDir, 'server.log'), 'server log line\n');
  fs.writeFileSync(path.join(dataDir, 'tnp.lock'), '1234');

  return {
    runtimeRoot: root,
    dataDir,
    backupsDir,
    reportsDir,
    updateDir: path.join(root, '.tnp-update'),
    dbFile,
    settingsFile,
    backupFile,
    reportFile,
    cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export function runtimeLayout(fixture: RuntimeFixture): UpdateLayout {
  return resolveUpdateLayout({
    runtimeRoot: fixture.runtimeRoot,
    dataDir: fixture.dataDir,
    backupsDir: fixture.backupsDir,
    reportsDir: fixture.reportsDir,
  });
}

/* ------------------------------------------------------------------ *
 * A minimal stored-entry ZIP writer
 *
 * The publisher uses the real `createZip`, but several client tests need archives with
 * *specific* entry names — including hostile ones such as `../../evil.txt`, which no packaging
 * tool will write for you. This produces a valid, uncompressed ZIP that the real reader,
 * validator and extractor all accept.
 * ------------------------------------------------------------------ */

export interface ZipEntryInput {
  name: string;
  content?: string | Buffer;
  /** Emit a directory entry (name should end with '/'). */
  directory?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeZip(entries: readonly ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const data = entry.directory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '', 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // method: stored
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date (1996-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBuffer.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);         // comment length
    record.writeUInt16LE(0, 34);         // disk number
    record.writeUInt16LE(0, 36);         // internal attributes
    record.writeUInt32LE(0, 38);         // external attributes
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** Writes a ZIP whose contents are the fixture runtime, optionally with extra hostile entries. */
export function makeRuntimeZip(
  fixtureRoot: string,
  options: { version?: string; build?: number; extra?: readonly ZipEntryInput[]; omit?: readonly string[] } = {},
): Buffer {
  const entries = listRuntimeEntries(fixtureRoot);
  const omit = new Set(options.omit ?? []);
  const written: ZipEntryInput[] = [];

  for (const relative of entries) {
    if (omit.has(relative)) continue;
    let content: Buffer = fs.readFileSync(path.join(fixtureRoot, relative));
    if (relative === 'resources/app/package.json') {
      const parsed = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
      parsed.version = options.version ?? parsed.version;
      parsed.tnpBuild = options.build ?? parsed.tnpBuild;
      content = Buffer.from(JSON.stringify(parsed, null, 2), 'utf8');
    }
    written.push({ name: relative, content });
  }
  written.push(...(options.extra ?? []));
  return makeZip(written);
}

/**
 * The runtime entries of a fixture folder, i.e. what a real publisher would package. The
 * persistent directories are skipped exactly as `collectRuntimeForPackage` skips them, so a
 * fixture can hold production data without it leaking into the test archive.
 */
export function listRuntimeEntries(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && (['data', 'backups', 'reports', '.tnp-update', '.git'].includes(entry.name))) continue;
    if (entry.isDirectory()) out.push(...listRuntimeEntries(root, relative));
    else out.push(relative);
  }
  return out;
}

export function manifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product: 'TNP Defect Management System',
    channel: 'test',
    version: FIXTURE_VERSION,
    build: FIXTURE_BUILD,
    architecture: 'win-x64',
    package: `tnp-test-${FIXTURE_VERSION}-build${FIXTURE_BUILD}-win-x64.zip`,
    sha256: 'a'.repeat(64),
    size: 1024,
    publishedAt: '2026-10-06T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * ZIP handling for the updater.
 *
 * Entries are listed by parsing the central directory directly rather than by asking an
 * external tool, so ZIP-SLIP is rejected on our own terms *before* anything is extracted,
 * whatever the platform's unzip implementation would have done.
 *
 * Extraction and creation still shell out, because there is no ZIP writer in the Node standard
 * library. Only tools that ship with Windows 10+ (PowerShell, bsdtar as `tar`) or the build
 * machine's own `zip` are used — the Owner PC needs no development tools installed.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 65535;

/** True for an entry that could escape the extraction directory. */
export function isUnsafeEntryName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return true;
  if (name.includes('\0')) return true;
  if (path.isAbsolute(name)) return true;
  if (/^[A-Za-z]:/u.test(name)) return true;
  const normalized = name.replace(/\\/gu, '/');
  if (normalized.startsWith('//')) return true; // UNC
  const segments = normalized.split('/');
  return segments.some((segment) => segment === '..');
}

/** Rejects unsafe entries and returns the normalised, relative entry list. */
export function assertSafeEntries(entries: readonly string[]): string[] {
  const unsafe = entries.filter((entry) => isUnsafeEntryName(entry));
  if (unsafe.length > 0) {
    throw new ArchiveError(
      `The update package contains ${unsafe.length} unsafe path(s), for example "${unsafe[0]}". `
      + 'Refusing to extract it.',
    );
  }
  return entries.map((entry) => entry.replace(/\\/gu, '/'));
}

/** Reads the ZIP central directory and returns every entry name. */
export function listZipEntries(zipPath: string): string[] {
  const handle = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    if (size < EOCD_MIN_SIZE) throw new ArchiveError('The update package is not a readable ZIP archive.');

    const searchFrom = Math.max(0, size - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
    const tail = Buffer.alloc(size - searchFrom);
    fs.readSync(handle, tail, 0, tail.length, searchFrom);

    const eocdOffset = findEocd(tail);
    if (eocdOffset < 0) throw new ArchiveError('The update package is not a readable ZIP archive.');

    // A Zip64 locator immediately before the EOCD means a >4GB archive; this project's
    // packages are far smaller, so refuse rather than silently misread the directory.
    if (eocdOffset >= 20 && tail.readUInt32LE(eocdOffset - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw new ArchiveError('Zip64 archives are not supported by the TNP updater.');
    }

    const totalEntries = tail.readUInt16LE(eocdOffset + 10);
    const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (directoryOffset === 0xffffffff) {
      throw new ArchiveError('Zip64 archives are not supported by the TNP updater.');
    }

    const directory = Buffer.alloc(Math.max(0, Math.min(size - directoryOffset, size)));
    fs.readSync(handle, directory, 0, directory.length, directoryOffset);

    const entries: string[] = [];
    let offset = 0;
    while (offset + 46 <= directory.length && entries.length < totalEntries) {
      if (directory.readUInt32LE(offset) !== CENTRAL_ENTRY_SIGNATURE) break;
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const nameStart = offset + 46;
      if (nameStart + nameLength > directory.length) break;
      entries.push(directory.subarray(nameStart, nameStart + nameLength).toString('utf8'));
      offset = nameStart + nameLength + extraLength + commentLength;
    }

    if (entries.length !== totalEntries) {
      throw new ArchiveError(
        `The update package directory is inconsistent: expected ${totalEntries} entries, read ${entries.length}.`,
      );
    }
    return entries;
  } finally {
    fs.closeSync(handle);
  }
}

function findEocd(buffer: Buffer): number {
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/** Extracts with the first tool that works, after the entries have already been validated. */
export function extractZip(zipPath: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  const attempts: Array<[string, string[]]> = process.platform === 'win32'
    ? [
      [
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/gu, "''")}' `
          + `-DestinationPath '${destination.replace(/'/gu, "''")}' -Force`,
        ],
      ],
      ['tar', ['-xf', zipPath, '-C', destination]],
    ]
    : [
      ['unzip', ['-q', '-o', zipPath, '-d', destination]],
      ['tar', ['-xf', zipPath, '-C', destination]],
      ['bsdtar', ['-xf', zipPath, '-C', destination]],
    ];

  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
    if (result.status === 0) return;
  }
  throw new ArchiveError(
    'The update package could not be extracted. On Windows this needs PowerShell or tar, '
    + 'both of which ship with Windows 10 and later.',
  );
}

/** Creates a ZIP of an already-prepared directory. Used by the publisher only. */
export function createZip(sourceDir: string, zipPath: string): void {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });

  const attempts: Array<[string, string[], string | undefined]> = process.platform === 'win32'
    ? [[
      'powershell',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${sourceDir.replace(/'/gu, "''")}\\*' `
        + `-DestinationPath '${zipPath.replace(/'/gu, "''")}' -Force`,
      ],
      undefined,
    ]]
    : [['zip', ['-qr', zipPath, '.'], sourceDir]];

  for (const [command, args, cwd] of attempts) {
    const result = spawnSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
    if (result.status === 0 && fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) return;
  }
  throw new ArchiveError('The update package could not be created; no zip tool is available.');
}

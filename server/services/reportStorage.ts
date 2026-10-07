import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReportCatalog, ReportLink } from '../db/reportCatalog';
import { ReportUnavailableError } from '../errors';
import { resolveContainedPath, resolveRealContainedPath, toSafeFileComponent } from './safePath';

export interface ReportAttachment {
  originalName: string;
  contentType?: string | null;
  contents: Uint8Array;
}

export type ReportState =
  | { state: 'attached'; link: ReportLink }
  | { state: 'no-report' }
  | { state: 'unavailable'; link: ReportLink };

export interface ReportStream {
  link: ReportLink;
  filePath: string;
  sizeBytes: number;
}

const MAX_REPORT_BYTES = 64 * 1024 * 1024;

/**
 * Managed report storage. Files are only reachable through the record they are linked to;
 * there is no directory listing and no way to ask for an arbitrary path.
 */
export class ReportStorage {
  constructor(
    private readonly catalog: ReportCatalog,
    private readonly reportsDir: string,
  ) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  get directory(): string {
    return this.reportsDir;
  }

  private storedNameFor(recordIdKey: string, originalName: string): string {
    const random = crypto.randomBytes(6).toString('hex');
    const safeOriginal = toSafeFileComponent(path.basename(originalName), 48);
    return `${toSafeFileComponent(recordIdKey, 40)}--${random}--${safeOriginal}`;
  }

  /**
   * Writes the bytes inside managed storage and links them to the record. Replacing an
   * existing report leaves the previous bytes on disk and links the new file instead.
   */
  attach(recordIdKey: string, attachment: ReportAttachment, now = new Date().toISOString()): ReportLink {
    if (attachment.contents.byteLength === 0) {
      throw new ReportUnavailableError('A report file must not be empty.');
    }
    if (attachment.contents.byteLength > MAX_REPORT_BYTES) {
      throw new ReportUnavailableError('The report file is larger than the supported limit.');
    }
    const originalName = toSafeFileComponent(path.basename(attachment.originalName || 'report'), 80);
    const storedName = this.storedNameFor(recordIdKey, originalName);
    const target = resolveContainedPath(this.reportsDir, storedName);

    const temporary = `${target}.uploading-${process.pid}`;
    fs.writeFileSync(temporary, attachment.contents);
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }

    return this.catalog.upsert({
      recordIdKey,
      storedName,
      originalName,
      contentType: normalizeContentType(attachment.contentType),
      sizeBytes: attachment.contents.byteLength,
      attachedAt: now,
    });
  }

  /** Distinguishes "never attached" from "linked but the bytes are gone". */
  inspect(recordIdKey: string): ReportState {
    const link = this.catalog.get(recordIdKey);
    if (!link) return { state: 'no-report' };
    if (!this.fileExists(link.storedName)) return { state: 'unavailable', link };
    return { state: 'attached', link };
  }

  /**
   * Resolves the linked file for streaming. A missing file keeps its link and surfaces an
   * explicit unavailable state instead of being silently cleared.
   */
  open(recordIdKey: string): ReportStream {
    const link = this.catalog.get(recordIdKey);
    if (!link) {
      throw new ReportUnavailableError('No report is linked to this record.');
    }

    const filePath = resolveRealContainedPath(this.reportsDir, link.storedName);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      throw new ReportUnavailableError('The linked report file is no longer available on the server.');
    }
    if (!stats.isFile()) {
      throw new ReportUnavailableError('The linked report is not a regular file.');
    }

    return { link, filePath, sizeBytes: stats.size };
  }

  /** Removes the association and keeps the stored bytes, as required. */
  unlink(recordIdKey: string): ReportLink | undefined {
    return this.catalog.unlink(recordIdKey);
  }

  private fileExists(storedName: string): boolean {
    try {
      return fs.statSync(resolveRealContainedPath(this.reportsDir, storedName)).isFile();
    } catch {
      return false;
    }
  }
}

function normalizeContentType(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed || null;
}

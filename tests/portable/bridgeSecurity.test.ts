import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BridgeValidationError,
  checkManagedReportPath,
  createFileTokenStore,
  describePickedFile,
  isOpaqueToken,
  normalizeBridgeRecordId,
  TOKEN_TTL_MS,
} from '../../desktop/main/bridgeCore';

function tempTree(): { root: string; reportsDir: string; outsideDir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'tnp-bridge-'));
  const reportsDir = path.join(root, 'reports');
  const outsideDir = path.join(root, 'outside');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  return { root, reportsDir, outsideDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('desktop bridge token store', () => {
  it('issues opaque UUID tokens', () => {
    const tokens = createFileTokenStore();
    const token = tokens.issue({ filePath: '/tmp/a.pdf', fileName: 'a.pdf', sizeBytes: 3 });
    expect(isOpaqueToken(token)).toBe(true);
    expect(token).not.toContain('/tmp/a.pdf');
  });

  it('is single use: a consumed token cannot be replayed', () => {
    const tokens = createFileTokenStore();
    const token = tokens.issue({ filePath: '/tmp/a.pdf', fileName: 'a.pdf', sizeBytes: 3 });
    expect(tokens.consume(token)?.filePath).toBe('/tmp/a.pdf');
    expect(tokens.consume(token)).toBeNull();
  });

  it('expires tokens after the TTL', () => {
    const now = 1_000_000;
    const tokens = createFileTokenStore({ ttlMs: TOKEN_TTL_MS });
    const token = tokens.issue({ filePath: '/tmp/a.pdf', fileName: 'a.pdf', sizeBytes: 3 }, now);
    expect(tokens.consume(token, now + TOKEN_TTL_MS - 1)).not.toBeNull();

    const late = tokens.issue({ filePath: '/tmp/b.pdf', fileName: 'b.pdf', sizeBytes: 3 }, now);
    expect(tokens.consume(late, now + TOKEN_TTL_MS + 1)).toBeNull();
  });

  it('rejects anything that is not an opaque token before touching the map', () => {
    const tokens = createFileTokenStore();
    tokens.issue({ filePath: '/tmp/a.pdf', fileName: 'a.pdf', sizeBytes: 3 });
    expect(tokens.consume('')).toBeNull();
    expect(tokens.consume('../../etc/passwd')).toBeNull();
    expect(tokens.consume('12345')).toBeNull();
    expect(tokens.consume(undefined as unknown as string)).toBeNull();
  });

  it('bounds the number of live tokens', () => {
    const tokens = createFileTokenStore({ maxTokens: 3 });
    const issued = [0, 1, 2, 3, 4].map((index) =>
      tokens.issue({ filePath: `/tmp/${index}.pdf`, fileName: `${index}.pdf`, sizeBytes: index }));
    expect(tokens.size()).toBeLessThanOrEqual(3);
    // The oldest entries were evicted, so only the most recent survive.
    expect(tokens.consume(issued[0] as string)).toBeNull();
    expect(tokens.consume(issued[4] as string)).not.toBeNull();
  });
});

describe('bridge record id normalisation', () => {
  it('treats 1, "1" and " 1 " as the same record', () => {
    expect(normalizeBridgeRecordId(1)).toBe(1);
    expect(normalizeBridgeRecordId('1')).toBe(1);
    expect(normalizeBridgeRecordId(' 1 ')).toBe(1);
  });

  it('keeps non-numeric ids as trimmed strings', () => {
    expect(normalizeBridgeRecordId('  260702006-VOC ')).toBe('260702006-VOC');
  });

  it('rejects empty and absurd ids', () => {
    expect(() => normalizeBridgeRecordId('')).toThrow(BridgeValidationError);
    expect(() => normalizeBridgeRecordId('   ')).toThrow(BridgeValidationError);
    expect(() => normalizeBridgeRecordId(null)).toThrow(BridgeValidationError);
    expect(() => normalizeBridgeRecordId({ id: 1 })).toThrow(BridgeValidationError);
    expect(() => normalizeBridgeRecordId('x'.repeat(500))).toThrow(BridgeValidationError);
  });
});

describe('managed report path containment', () => {
  it('accepts a regular file inside the managed folder', () => {
    const tree = tempTree();
    try {
      const file = path.join(tree.reportsDir, 'number_1--abc--report.pdf');
      writeFileSync(file, 'pdf');
      const check = checkManagedReportPath(file, tree.reportsDir);
      expect(check.allowed).toBe(true);
      expect(check.resolvedPath).toBe(file);
    } finally {
      tree.cleanup();
    }
  });

  it('rejects a file outside the managed folder', () => {
    const tree = tempTree();
    try {
      const outside = path.join(tree.outsideDir, 'secret.pdf');
      writeFileSync(outside, 'pdf');
      const check = checkManagedReportPath(outside, tree.reportsDir);
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(/outside/u);
    } finally {
      tree.cleanup();
    }
  });

  it('rejects traversal even when the resolved target exists', () => {
    const tree = tempTree();
    try {
      writeFileSync(path.join(tree.outsideDir, 'secret.pdf'), 'pdf');
      const traversal = path.join(tree.reportsDir, '..', 'outside', 'secret.pdf');
      const check = checkManagedReportPath(traversal, tree.reportsDir);
      expect(check.allowed).toBe(false);
    } finally {
      tree.cleanup();
    }
  });

  it('rejects a symlink that escapes the managed folder', () => {
    const tree = tempTree();
    try {
      const target = path.join(tree.outsideDir, 'secret.pdf');
      writeFileSync(target, 'pdf');
      const link = path.join(tree.reportsDir, 'escape.pdf');
      symlinkSync(target, link);

      const check = checkManagedReportPath(link, tree.reportsDir);
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(/outside/u);
    } finally {
      tree.cleanup();
    }
  });

  it('rejects relative paths, directories and missing files', () => {
    const tree = tempTree();
    try {
      expect(checkManagedReportPath('reports/a.pdf', tree.reportsDir).allowed).toBe(false);
      expect(checkManagedReportPath(tree.reportsDir, tree.reportsDir).allowed).toBe(false);
      expect(checkManagedReportPath(path.join(tree.reportsDir, 'absent.pdf'), tree.reportsDir).allowed).toBe(false);
      expect(checkManagedReportPath(null, tree.reportsDir).allowed).toBe(false);
      expect(checkManagedReportPath(42, tree.reportsDir).allowed).toBe(false);
    } finally {
      tree.cleanup();
    }
  });
});

describe('picker results', () => {
  it('rejects a directory selected as a file', () => {
    const tree = tempTree();
    try {
      expect(() => describePickedFile(tree.reportsDir)).toThrow(BridgeValidationError);
    } finally {
      tree.cleanup();
    }
  });

  it('reports the base name and size for a real file', () => {
    const tree = tempTree();
    try {
      const file = path.join(tree.outsideDir, 'Countermeasure 260702006.pdf');
      writeFileSync(file, 'hello');
      expect(describePickedFile(file)).toEqual({
        filePath: file,
        fileName: 'Countermeasure 260702006.pdf',
        sizeBytes: 5,
      });
    } finally {
      tree.cleanup();
    }
  });
});

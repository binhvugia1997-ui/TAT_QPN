import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MANIFEST_FILENAME, serializeManifest } from '../../desktop/update/manifest';
import type { UpdateManifest } from '../../desktop/update/manifest';
import { validateUpdateSource } from '../../desktop/update/source';

/**
 * Settings-side validation of a configured update folder.
 *
 * These cases are the ones an operator actually hits, and every one of them is otherwise silent:
 * the updater logs a soft failure at start and the Owner PC keeps running the old build forever.
 * A half-published folder is the important one — the manifest is written last, so "manifest
 * present, package missing" should not be reachable, but a manual copy or a deleted archive makes
 * it real, and the client must be told rather than left to fail mid-download.
 */

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tnp-update-source-'));
}

const PACKAGE_NAME = 'tnp-test-1.2.3-build7-win-x64.zip';

function manifestFor(overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    product: 'TNP Defect Management System',
    version: '1.2.3',
    build: 7,
    channel: 'test',
    architecture: 'win-x64',
    package: PACKAGE_NAME,
    sha256: 'a'.repeat(64),
    size: 11,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A folder holding a complete, publishable update: the manifest and a package of the right size. */
function createReadyShare(overrides: Partial<UpdateManifest> = {}): { dir: string; cleanup(): void } {
  const dir = createTempDir();
  const manifest = manifestFor(overrides);
  const bytes = Buffer.alloc(manifest.size, 7);
  fs.writeFileSync(path.join(dir, manifest.package), bytes);
  fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), serializeManifest(manifest));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('validating a configured update folder', () => {
  it('accepts a folder whose manifest and package are both present', async () => {
    const share = createReadyShare();
    try {
      const result = await validateUpdateSource(share.dir, { channel: 'test' });

      expect(result.state).toBe('ready');
      expect(result.usable).toBe(true);
      expect(result.manifest).toEqual({
        version: '1.2.3',
        build: 7,
        channel: 'test',
        package: PACKAGE_NAME,
      });
      expect(result.message).toContain('build 7');
    } finally {
      share.cleanup();
    }
  });

  it('reports an empty setting as normal, not as an error', async () => {
    const result = await validateUpdateSource('   ');

    expect(result.state).toBe('not-configured');
    expect(result.usable).toBe(false);
    // Not a failure: checking is off by design when nothing is configured.
    expect(result.message).toMatch(/not check for updates/u);
  });

  it('distinguishes a missing folder from a folder it cannot read', async () => {
    const missing = path.join(createTempDir(), 'nope');
    const result = await validateUpdateSource(missing);

    expect(result.state).toBe('unreachable');
    expect(result.usable).toBe(false);
    expect(result.message).toMatch(/could not be reached/u);
  });

  it('refuses a path that is a file rather than a folder', async () => {
    const dir = createTempDir();
    const file = path.join(dir, 'not-a-folder');
    fs.writeFileSync(file, 'x');
    try {
      const result = await validateUpdateSource(file);

      expect(result.usable).toBe(false);
      expect(result.message).toMatch(/not a folder/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the missing manifest instead of reporting an empty folder', async () => {
    const dir = createTempDir();
    try {
      const result = await validateUpdateSource(dir);

      expect(result.state).toBe('no-manifest');
      expect(result.usable).toBe(false);
      // The actionable half of the message: nothing has been published *yet* is different from
      // "the share is broken", and only one of them means the publisher still has work to do.
      expect(result.message).toContain(MANIFEST_FILENAME);
      expect(result.message).toMatch(/has not been published|Nothing has been published/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a manifest from another channel, because accepting it would cross the test/production line', async () => {
    const share = createReadyShare({ channel: 'production', build: 99 });
    try {
      const result = await validateUpdateSource(share.dir, { channel: 'test' });

      expect(result.state).toBe('invalid-manifest');
      expect(result.channelMatches).toBe(false);
      expect(result.usable).toBe(false);
      expect(result.message).toMatch(/production/u);
      // The manifest is still reported: "what is in there" is information the operator needs even
      // when the answer is "not for you".
      expect(result.manifest?.build).toBe(99);
    } finally {
      share.cleanup();
    }
  });

  it('catches a half-finished publish, where the manifest exists but its package does not', async () => {
    const share = createReadyShare();
    try {
      fs.rmSync(path.join(share.dir, PACKAGE_NAME));

      const result = await validateUpdateSource(share.dir, { channel: 'test' });

      expect(result.state).toBe('invalid-manifest');
      expect(result.usable).toBe(false);
      expect(result.message).toMatch(/incomplete/u);
      expect(result.message).toContain(PACKAGE_NAME);
    } finally {
      share.cleanup();
    }
  });

  it('catches a package that is the wrong size, i.e. a copy that was interrupted', async () => {
    const share = createReadyShare();
    try {
      // Same name, truncated content: everything a filename check can see is fine.
      fs.writeFileSync(path.join(share.dir, PACKAGE_NAME), Buffer.alloc(3));

      const result = await validateUpdateSource(share.dir, { channel: 'test' });

      expect(result.usable).toBe(false);
      expect(result.message).toMatch(/missing or the wrong size/u);
    } finally {
      share.cleanup();
    }
  });

  it('reports a manifest it cannot parse, quoting why', async () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), '{ not json');
    try {
      const result = await validateUpdateSource(dir, { channel: 'test' });

      expect(result.state).toBe('invalid-manifest');
      expect(result.message).toMatch(/not valid JSON|not a manifest/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never writes, even to a folder it can write to', async () => {
    const share = createReadyShare();
    try {
      const before = fs.readdirSync(share.dir).sort();
      await validateUpdateSource(share.dir, { channel: 'test' });

      // A client validating its source must not be able to leave a trace on the publisher's share.
      expect(fs.readdirSync(share.dir).sort()).toEqual(before);
      expect(fs.existsSync(path.join(share.dir, PACKAGE_NAME))).toBe(true);
    } finally {
      share.cleanup();
    }
  });

  it('stamps the answer with the time it was taken, so a stale result is recognisable', async () => {
    const fixed = new Date('2026-02-02T03:04:05.000Z');
    const result = await validateUpdateSource('', { now: () => fixed });

    // The panel shows this check's result until the next check, so it has to be datable.
    expect(result.checkedAt).toBe(fixed.toISOString());
  });
});

/**
 * §30 — the publisher.
 *
 * The publisher runs on the build/test machine, whose SQLite database, backups and reports are
 * TEST DATA. The two things that must never go wrong are: shipping that test data inside an
 * update package, and replacing the published manifest before the package is fully in place.
 * Both are asserted here against real files.
 */
import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PublishError,
  cleanStaleTempFiles,
  collectRuntimeForPackage,
  defaultPackageName,
  parsePublishArgs,
  publishUpdate,
  readAppVersionFile,
  readExistingManifest,
} from '../../desktop/update/publish';
import { listZipEntries } from '../../desktop/update/archive';
import { parseManifest, serializeManifest } from '../../desktop/update/manifest';
import { FORBIDDEN_PACKAGE_PATHS, inspectPackageEntries, isForbiddenPackageEntry } from '../../desktop/update/packageInspect';
import { createRuntimeFixture, createTempDir, listRuntimeEntries } from './helpers';
import { FIXTURE_BUILD, FIXTURE_VERSION, PRODUCTION_BACKUP, PRODUCTION_DB } from './helpers';

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function publish(options: {
  source: string;
  target: string;
  build?: number;
  version?: string;
  channel?: string;
  notes?: string;
  packageName?: string;
}) {
  const logs: string[] = [];
  return publishUpdate({
    sourceDir: options.source,
    targetDir: options.target,
    version: options.version ?? FIXTURE_VERSION,
    build: options.build ?? FIXTURE_BUILD,
    channel: options.channel ?? 'test',
    releaseNotes: options.notes,
    packageName: options.packageName,
    log: (line) => { logs.push(line); },
  }).then((result) => ({ result, logs }));
}

describe('publishing a TEST update', () => {
  it('produces a runtime-only package plus a manifest that describes it exactly', async () => {
    const parent = createTempDir('publish');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      const { result } = await publish({ source: source.runtimeRoot, target });
      expect(result.ok).toBe(true);
      expect(result.manifest).not.toBeNull();

      const manifest = result.manifest!;
      expect(manifest.product).toBe('TNP Defect Management System');
      expect(manifest.channel).toBe('test');
      expect(manifest.build).toBe(FIXTURE_BUILD);
      expect(manifest.architecture).toBe('win-x64');

      const published = fs.readFileSync(path.join(target, manifest.package));
      expect(published.length).toBe(manifest.size);
      expect(sha256(published)).toBe(manifest.sha256);

      // What is on the share parses, and describes the file that is on the share.
      const reparsed = readExistingManifest(target)!;
      expect(reparsed.sha256).toBe(manifest.sha256);
      expect(reparsed.package).toBe(manifest.package);
      expect(fs.existsSync(path.join(target, reparsed.package))).toBe(true);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('writes the manifest last, after the package is verified and renamed', async () => {
    const parent = createTempDir('order');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      const { result } = await publish({ source: source.runtimeRoot, target });
      const steps = result.steps;
      expect(steps).toEqual([
        'collect-runtime',
        'inspect-tree',
        'create-zip',
        'inspect-archive',
        'sha256',
        'copy-temp-package',
        'verify-destination-size',
        'verify-destination-sha256',
        'rename-package',
        'write-manifest-temp',
        'replace-manifest-last',
        'verify-published-manifest',
      ]);
      expect(steps.indexOf('replace-manifest-last')).toBe(steps.length - 2);
      expect(steps.indexOf('verify-destination-sha256')).toBeLessThan(steps.indexOf('rename-package'));
      expect(steps.indexOf('rename-package')).toBeLessThan(steps.indexOf('replace-manifest-last'));
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('never puts data, backups, reports or the updater working area into the package', async () => {
    const parent = createTempDir('excludes');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      // Even with an abandoned updater working area sitting in the portable folder.
      fs.mkdirSync(path.join(source.runtimeRoot, '.tnp-update', 'download'), { recursive: true });
      fs.writeFileSync(path.join(source.runtimeRoot, '.tnp-update', 'download', 'old.zip'), 'junk');

      const { result } = await publish({ source: source.runtimeRoot, target });
      const entries = listZipEntries(path.join(target, result.manifest!.package));

      for (const entry of entries) {
        const first = entry.split(/[\\/]/u)[0] as string;
        expect(['data', 'backups', 'reports', '.tnp-update', '.git']).not.toContain(first);
      }
      expect(entries.some((entry) => entry.includes('tnp.db'))).toBe(false);
      expect(entries.some((entry) => entry.includes('desktop-settings.json'))).toBe(false);
      expect(entries.some((entry) => entry.includes('record-1-report.pdf'))).toBe(false);
      expect(entries.some((entry) => entry.includes('server.log'))).toBe(false);

      // And the inspection agrees.
      expect(inspectPackageEntries(entries).ok).toBe(true);
      // The source's production data was never moved or altered.
      expect(fs.readFileSync(source.dbFile).equals(PRODUCTION_DB)).toBe(true);
      expect(fs.readFileSync(source.backupFile, 'utf8')).toBe(PRODUCTION_BACKUP);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses to publish when the assembled folder carries a database', async () => {
    const parent = createTempDir('leaky-source');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      // A stray database dropped somewhere inside the runtime must be caught, not shipped.
      fs.mkdirSync(path.join(source.runtimeRoot, 'resources', 'app', 'server-runtime', 'data'), { recursive: true });
      fs.writeFileSync(path.join(source.runtimeRoot, 'resources', 'app', 'server-runtime', 'data', 'tnp.db'), 'test data');

      await expect(publish({ source: source.runtimeRoot, target })).rejects.toThrow(/not runtime-only/u);
      expect(fs.existsSync(path.join(target, 'version.json'))).toBe(false);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses to publish an equal or older build over a newer one', async () => {
    const parent = createTempDir('gate');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      await publish({ source: source.runtimeRoot, target, build: 7 });

      await expect(publish({ source: source.runtimeRoot, target, build: 7 })).rejects.toThrow(/refusing to publish build 7/u);
      await expect(publish({ source: source.runtimeRoot, target, build: 6 })).rejects.toThrow(/refusing to publish build 6/u);

      // A newer build is fine, and it replaces the manifest.
      const { result } = await publish({ source: source.runtimeRoot, target, build: 8 });
      expect(result.manifest!.build).toBe(8);
      expect(readExistingManifest(target)!.build).toBe(8);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('leaves the previous manifest valid when publishing fails part-way', async () => {
    const parent = createTempDir('atomic');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      const first = await publish({ source: source.runtimeRoot, target, build: 7 });
      const firstManifest = fs.readFileSync(path.join(target, 'version.json'), 'utf8');

      // Publish a build whose source will fail inspection, after the gate has passed. The
      // company workbook is on the forbidden list by name, wherever it is dropped.
      fs.writeFileSync(
        path.join(source.runtimeRoot, 'resources', 'app', 'EXCEL_EXPORT_FILE_20261002181424.xlsx'),
        'company workbook',
      );
      await expect(publish({ source: source.runtimeRoot, target, build: 9 })).rejects.toThrow(/not runtime-only/u);

      // The share is exactly as it was: same manifest, no half-written temp file.
      expect(fs.readFileSync(path.join(target, 'version.json'), 'utf8')).toBe(firstManifest);
      expect(fs.readdirSync(target).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
      expect(readExistingManifest(target)!.build).toBe(first.result.manifest!.build);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('leaves no temporary files behind after a successful publish', async () => {
    const parent = createTempDir('notmp');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      await publish({ source: source.runtimeRoot, target });
      const entries = fs.readdirSync(target);
      expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
      expect(entries.filter((entry) => entry.endsWith('.partial'))).toEqual([]);
      expect(entries).toContain('version.json');
      expect(entries.filter((entry) => entry.endsWith('.zip'))).toHaveLength(1);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('preserves unrelated files already on the share, including another channel', async () => {
    const parent = createTempDir('coexist');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'readme.txt'), 'owner notes');
      fs.writeFileSync(path.join(target, 'tnp-production-9.9.9-build99-win-x64.zip'), 'a production package');
      fs.mkdirSync(path.join(target, 'production'), { recursive: true });
      fs.writeFileSync(path.join(target, 'production', 'version.json'), 'a production manifest');

      await publish({ source: source.runtimeRoot, target });

      expect(fs.readFileSync(path.join(target, 'readme.txt'), 'utf8')).toBe('owner notes');
      expect(fs.readFileSync(path.join(target, 'tnp-production-9.9.9-build99-win-x64.zip'), 'utf8')).toBe('a production package');
      expect(fs.readFileSync(path.join(target, 'production', 'version.json'), 'utf8')).toBe('a production manifest');
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('removes stale temporary files from earlier failed runs', async () => {
    const parent = createTempDir('stale');
    const target = path.join(parent, 'share');
    fs.mkdirSync(target, { recursive: true });
    const stale = path.join(target, 'tnp-test-old.zip.tmp');
    const fresh = path.join(target, 'tnp-test-new.zip.tmp');
    fs.writeFileSync(stale, 'abandoned');
    fs.writeFileSync(fresh, 'in progress');
    const eightHours = 8 * 60 * 60 * 1000;
    fs.utimesSync(stale, new Date(Date.now() - eightHours), new Date(Date.now() - eightHours));

    const removed = cleanStaleTempFiles(target, Date.now());
    expect(removed).toEqual(['tnp-test-old.zip.tmp']);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('rejects an unsafe package name before anything is written', async () => {
    const parent = createTempDir('badname');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      for (const name of ['../escape.zip', 'C:\\evil.zip', '\\\\server\\share\\evil.zip', 'data/tnp.db']) {
        await expect(publish({ source: source.runtimeRoot, target, packageName: name })).rejects.toThrow(PublishError);
      }
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects an invalid channel identifier', async () => {
    const parent = createTempDir('badchannel');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      await expect(publish({ source: source.runtimeRoot, target, channel: 'TEST' })).rejects.toThrow(/channel/u);
      await expect(publish({ source: source.runtimeRoot, target, channel: '' })).rejects.toThrow(/channel/u);
      await expect(publish({ source: source.runtimeRoot, target, build: 0 })).rejects.toThrow(/build number/u);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a source folder that does not exist or holds no runtime', async () => {
    const parent = createTempDir('emptysource');
    const target = path.join(parent, 'share');
    const empty = path.join(parent, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    try {
      await expect(publish({ source: path.join(parent, 'missing'), target })).rejects.toThrow(/does not exist/u);
      await expect(publish({ source: empty, target })).rejects.toThrow(/no runtime content/u);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('derives a safe, channel-scoped package name', () => {
    const name = defaultPackageName('0.3.0', 7, 'test');
    expect(name).toBe('tnp-test-0.3.0-build7-win-x64.zip');
    expect(isForbiddenPackageEntry(name)).toBeNull();
    // Hostile version strings are neutralised rather than trusted.
    expect(defaultPackageName('../../evil', 7, 'test')).not.toMatch(/\.\./u);
    expect(defaultPackageName('0.3.0', 7, '../..')).not.toMatch(/\//u);
  });

  it('reads the version and build from the authoritative package.json', async () => {
    const parent = createTempDir('pkgjson');
    const file = path.join(parent, 'package.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: '1.2.3', tnpBuild: 42 }), 'utf8');
      expect(readAppVersionFile(file)).toEqual({ version: '1.2.3', build: 42 });

      fs.writeFileSync(file, JSON.stringify({ version: '1.2.3' }), 'utf8');
      expect(() => readAppVersionFile(file)).toThrow(/tnpBuild/u);

      fs.writeFileSync(file, JSON.stringify({ tnpBuild: 42 }), 'utf8');
      expect(() => readAppVersionFile(file)).toThrow(/version/u);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('parses its own command line, defaulting to the test channel', () => {
    const options = parsePublishArgs(['--source', 'artifacts/build', '--target', '\\\\PC\\share']);
    expect(options.sourceDir).toBe('artifacts/build');
    expect(options.targetDir).toBe('\\\\PC\\share');
    expect(options.channel).toBe('test');
    expect(() => parsePublishArgs(['--source', 'only-one'])).toThrow(/Usage/u);

    const explicit = parsePublishArgs(['--source', 'a', '--target', 'b', '--channel', 'PROD', '--notes', 'n']);
    expect(explicit.channel).toBe('prod');
    expect(explicit.releaseNotes).toBe('n');
  });

  it('collects exactly the runtime entries and skips everything persistent', () => {
    const parent = createTempDir('collect');
    const source = createRuntimeFixture(parent, { label: 'collect' });
    const destination = path.join(parent, 'out');
    try {
      const entries = collectRuntimeForPackage(source.runtimeRoot, destination);
      expect(entries).toContain('resources');
      expect(entries).toContain('TNP Defect Management TEST.exe');
      for (const forbidden of FORBIDDEN_PACKAGE_PATHS) expect(entries).not.toContain(forbidden);
      expect(fs.existsSync(path.join(destination, 'resources', 'app', 'package.json'))).toBe(true);
      expect(fs.existsSync(path.join(destination, 'data'))).toBe(false);

      // The collection matches what a client would need.
      expect(inspectPackageEntries(listRuntimeEntries(destination)).ok).toBe(true);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('publishes release notes when they are supplied', async () => {
    const parent = createTempDir('notes');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      const { result } = await publish({ source: source.runtimeRoot, target, notes: 'Fixed the export.' });
      expect(result.manifest!.releaseNotes).toBe('Fixed the export.');
      expect(parseManifest(fs.readFileSync(path.join(target, 'version.json'), 'utf8')).releaseNotes).toBe('Fixed the export.');
      expect(serializeManifest(result.manifest!)).toContain('Fixed the export.');
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

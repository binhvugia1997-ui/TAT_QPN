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
  checkPublishTarget,
  cleanStaleTempFiles,
  collectRuntimeForPackage,
  defaultPackageName,
  nextPublishableBuild,
  parsePublishArgs,
  publishUpdate,
  readAppVersionFile,
  writeAppVersionFile,
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
  bumpBuild?: boolean;
  requireEmptyTarget?: boolean;
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
    bumpBuild: options.bumpBuild,
    requireEmptyTarget: options.requireEmptyTarget,
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
        'check-target',
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
      // The share is validated before a package is built, so an unusable folder costs nothing.
      expect(steps[0]).toBe('check-target');
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

/**
 * Phase E — publishing to a *fixed LAN destination* on a shared build machine.
 *
 * Two things change once several developers publish to one folder, and both are asserted here
 * against real files on a real temp folder (the closest thing to a share this host can offer):
 *
 *   1. The destination has to be proven reachable and writable *before* an hour of building is
 *      spent, and a typo'd UNC must not silently become a local folder.
 *   2. The build number has to advance safely. A hard "your number is taken" failure produces
 *      operators who edit package.json under pressure and publish a build nobody reviewed; the
 *      publisher therefore bumps to the next free build, and can write that number back so the
 *      next build agrees with what the Owner PC will report as installed.
 */
describe('validating the LAN update folder', () => {
  it('accepts a real folder and proves it is writable by writing to it', () => {
    const parent = createTempDir('target-ok');
    try {
      const check = checkPublishTarget(parent, { create: false });

      expect(check.ok).toBe(true);
      expect(check.existed).toBe(true);
      expect(check.created).toBe(false);
      expect(check.reason).toBeNull();
      // The probe file is gone: a publisher that litters the share is a bug.
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('creates a missing folder when allowed, and reports that it did', () => {
    const parent = createTempDir('target-create');
    const nested = path.join(parent, 'TAT QPN', 'updates');
    try {
      const check = checkPublishTarget(nested, { create: true });

      expect(check.ok).toBe(true);
      expect(check.created).toBe(true);
      expect(fs.existsSync(nested)).toBe(true);
      expect(fs.readdirSync(nested)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses to invent a folder when only a check was asked for', () => {
    const parent = createTempDir('target-nocreate');
    const missing = path.join(parent, 'does-not-exist');
    try {
      const check = checkPublishTarget(missing, { create: false });

      expect(check.ok).toBe(false);
      expect(check.reason).toBe('unreachable');
      expect(fs.existsSync(missing)).toBe(false);
      expect(check.message).toMatch(/does not exist/u);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('reports a file used as a folder, rather than trying to write a package into it', () => {
    const parent = createTempDir('target-file');
    const file = path.join(parent, 'version.json');
    try {
      fs.writeFileSync(file, 'not a folder', 'utf8');
      const check = checkPublishTarget(file, { create: true });

      expect(check.ok).toBe(false);
      expect(check.reason).toBe('not-a-directory');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('recognises a UNC target and reports how deep below the share it sits', () => {
    expect(checkPublishTarget('\\\\192.168.103.12\\ReportExtractor_Update\\TAT QPN\\updates').shareDepth).toBe(4);
    expect(checkPublishTarget('\\\\PC\\share').shareDepth).toBe(2);
    expect(checkPublishTarget('/tmp/local-share').shareDepth).toBeNull();
    // A path an Explorer address bar produced (forward slashes) is still recognised.
    expect(checkPublishTarget('//192.168.103.12/ReportExtractor_Update/TAT QPN/updates').shareDepth).toBe(4);
  });

  it('refuses a Windows namespace path instead of writing into it', () => {
    for (const value of ['\\\\?\\UNC\\server\\share', '\\\\.\\PhysicalDrive0']) {
      const check = checkPublishTarget(value, { create: true });
      expect(check.ok, value).toBe(false);
      expect(check.reason, value).toBe('unsafe-path');
    }
  });

  it('refuses an empty target', () => {
    expect(checkPublishTarget('').reason).toBe('unsafe-path');
    expect(checkPublishTarget('   ').reason).toBe('unsafe-path');
  });

  it('stops a publish whose folder cannot be written, before packaging anything', async () => {
    const parent = createTempDir('target-unwritable');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const blocker = path.join(parent, 'blocker');
    try {
      // A path where the target must be a file: mkdir over it fails with ENOTDIR/EEXIST.
      fs.writeFileSync(blocker, 'in the way', 'utf8');

      await expect(publish({ source: source.runtimeRoot, target: path.join(blocker, 'share') }))
        .rejects.toThrow(PublishError);
      // Nothing of ours was created inside the way-blocking file's directory.
      expect(fs.readdirSync(parent)).toContain('blocker');
      expect(fs.existsSync(path.join(parent, 'blocker', 'share'))).toBe(false);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('advancing the build number safely', () => {
  it('keeps the package.json build when the share is behind it', () => {
    expect(nextPublishableBuild(12, null)).toEqual({ build: 12, bumped: false });
    expect(nextPublishableBuild(12, 11)).toEqual({ build: 12, bumped: false });
    expect(nextPublishableBuild(12, 1)).toEqual({ build: 12, bumped: false });
  });

  it('moves to the next free build when the share is level with or ahead of it', () => {
    expect(nextPublishableBuild(12, 12)).toEqual({ build: 13, bumped: true });
    expect(nextPublishableBuild(12, 30)).toEqual({ build: 31, bumped: true });
  });

  it('is tolerant of a garbage published build rather than refusing to publish', () => {
    expect(nextPublishableBuild(12, -3)).toEqual({ build: 12, bumped: false });
    expect(nextPublishableBuild(12, Number.NaN)).toEqual({ build: 12, bumped: false });
  });

  it('refuses a nonsense requested build', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => nextPublishableBuild(bad, null)).toThrow(/positive integer/u);
    }
  });

  it('publishes a bumped build by default, and says so in the result', async () => {
    const parent = createTempDir('bump');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      await publish({ source: source.runtimeRoot, target, build: 7 });

      // A second run at the same number is not a failure; it becomes build 8.
      const again = await publish({ source: source.runtimeRoot, target, build: 7, bumpBuild: true });
      expect(again.result.ok).toBe(true);
      expect(again.result.manifest!.build).toBe(8);
      expect(again.result.requestedBuild).toBe(7);
      expect(again.result.buildBumped).toBe(true);
      expect(again.result.message).toMatch(/Published as build 8 \(requested 7\)/u);
      // ...and the bump is announced in the log the operator reads.
      expect(again.logs.join('\n')).toMatch(/build 7 is already published; bumping to 8/u);
      expect(again.result.steps).toContain('bump-build');

      // The older package stays on the share: a rollback target is still available.
      expect(fs.readdirSync(target).filter((entry) => entry.endsWith('.zip'))).toHaveLength(2);
      expect(readExistingManifest(target)!.build).toBe(8);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps bumping opt-in for programmatic callers, so a number nobody built is never invented', async () => {
    const parent = createTempDir('bump-off');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      await publish({ source: source.runtimeRoot, target, build: 7 });

      await expect(publish({ source: source.runtimeRoot, target, build: 7 }))
        .rejects.toThrow(/refusing to publish build 7/u);
      // The manifest is untouched, not half-written.
      expect(readExistingManifest(target)!.build).toBe(7);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('never writes anything when it refuses to bump', async () => {
    const parent = createTempDir('bump-clean');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      const first = await publish({ source: source.runtimeRoot, target, build: 7 });
      const before = fs.readdirSync(target).sort();

      await expect(publish({ source: source.runtimeRoot, target, build: 6 })).rejects.toThrow(/refusing/u);

      expect(fs.readdirSync(target).sort()).toEqual(before);
      expect(readExistingManifest(target)!.build).toBe(first.result.manifest!.build);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('never publishing onto someone else’s manifest', () => {
  it('refuses a target that already publishes a different channel', async () => {
    const parent = createTempDir('channel-guard');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(
        path.join(target, 'version.json'),
        serializeManifest({
          product: 'TNP Defect Management System',
          channel: 'production',
          version: '9.9.9',
          build: 99,
          architecture: 'win-x64',
          package: 'tnp-production-9.9.9-build99-win-x64.zip',
          sha256: 'a'.repeat(64),
          size: 12,
          publishedAt: new Date().toISOString(),
        }),
        'utf8',
      );

      await expect(publish({ source: source.runtimeRoot, target, build: 100, bumpBuild: true }))
        .rejects.toThrow(/already publishes channel "production"/u);

      // The production manifest and its package are exactly as they were.
      expect(readExistingManifest(target)!.channel).toBe('production');
      expect(readExistingManifest(target)!.build).toBe(99);
      expect(fs.readdirSync(target)).toEqual(['version.json']);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('honours an explicit demand for an untouched target', async () => {
    const parent = createTempDir('empty-guard');
    const source = createRuntimeFixture(parent, { label: 'source' });
    const target = path.join(parent, 'share');
    try {
      await publish({ source: source.runtimeRoot, target, build: 5, requireEmptyTarget: true });
      expect(readExistingManifest(target)!.build).toBe(5);

      await expect(publish({ source: source.runtimeRoot, target, build: 6, requireEmptyTarget: true }))
        .rejects.toThrow(/--require-empty-target/u);
      expect(readExistingManifest(target)!.build).toBe(5);
    } finally {
      source.cleanup();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('the publish command line', () => {
  it('treats its switches as switches, so the next flag is not swallowed as a value', () => {
    const options = parsePublishArgs([
      '--source', 'artifacts/build',
      '--target', '\\\\192.168.103.12\\ReportExtractor_Update\\TAT QPN\\updates',
      '--bump-build',
      '--fail-if-exists',
      '--notes', 'first LAN publish',
    ]);

    expect(options.targetDir).toBe('\\\\192.168.103.12\\ReportExtractor_Update\\TAT QPN\\updates');
    expect(options.bumpBuild).toBe(true);
    expect(options.requireEmptyTarget).toBe(true);
    // The value after a switch still belongs to --notes.
    expect(options.releaseNotes).toBe('first LAN publish');
    expect(options.channel).toBe('test');
  });

  it('bumps by default and can be told not to', () => {
    expect(parsePublishArgs(['--source', 'a', '--target', 'b']).bumpBuild).toBe(true);
    expect(parsePublishArgs(['--source', 'a', '--target', 'b', '--no-bump-build']).bumpBuild).toBe(false);
  });

  it('allows a check-only invocation with no source at all', () => {
    const options = parsePublishArgs(['--target', '\\\\PC\\share\\upd', '--check-only']);

    expect(options.checkOnly).toBe(true);
    expect(options.sourceDir).toBe('');
    expect(() => parsePublishArgs(['--target', 'b'])).toThrow(/Usage/u);
    expect(() => parsePublishArgs(['--source', 'a'])).toThrow(/Usage/u);
  });

  it('still rejects an empty target for a check', () => {
    expect(() => parsePublishArgs(['--check-only'])).toThrow(/Usage/u);
  });
});

describe('writing the bumped build back to package.json', () => {
  it('updates only the version and build keys and preserves everything else', () => {
    const parent = createTempDir('pkg-write');
    const file = path.join(parent, 'package.json');
    try {
      fs.writeFileSync(file, JSON.stringify({
        name: 'tnp-defect-management-dev',
        private: true,
        version: '0.2.0',
        tnpBuild: 1,
        scripts: { build: 'vite build' },
      }, null, 2), 'utf8');

      writeAppVersionFile(file, { version: '0.3.0', build: 9 });

      const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(written.version).toBe('0.3.0');
      expect(written.tnpBuild).toBe(9);
      expect(written.name).toBe('tnp-defect-management-dev');
      expect(written.private).toBe(true);
      expect(written.scripts).toEqual({ build: 'vite build' });
      // No temp file left behind in the repository.
      expect(fs.readdirSync(parent)).toEqual(['package.json']);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('reads back exactly what it wrote', () => {
    const parent = createTempDir('pkg-roundtrip');
    const file = path.join(parent, 'package.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', tnpBuild: 1 }), 'utf8');
      writeAppVersionFile(file, { version: '1.4.2', build: 42 });

      expect(readAppVersionFile(file)).toEqual({ version: '1.4.2', build: 42 });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('refuses a non-positive build and an unreadable file', () => {
    const parent = createTempDir('pkg-bad');
    const file = path.join(parent, 'package.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', tnpBuild: 1 }), 'utf8');
      expect(() => writeAppVersionFile(file, { version: '1.0.1', build: 0 })).toThrow(/positive integer/u);
      expect(() => writeAppVersionFile(file, { version: '1.0.1', build: 1.5 })).toThrow(/positive integer/u);
      expect(() => writeAppVersionFile(path.join(parent, 'missing.json'), { version: '1', build: 1 })).toThrow(/could not be read/u);
      // The refusal left the original intact.
      expect(readAppVersionFile(file)).toEqual({ version: '1.0.0', build: 1 });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contract between the three things that must agree for the portable build to launch:
 *   1. what tsconfig.desktop.json emits,
 *   2. what scripts/package-portable.mjs copies and names as the Electron entry,
 *   3. where desktop/main/main.ts looks for the preload.
 *
 * These are strings in different files, so drift here produces a folder that opens and
 * immediately dies. Asserting them together makes that a test failure instead.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

/**
 * Strips block and line comments so assertions about code are not tripped by prose that
 * merely mentions an identifier.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

describe('portable package contract', () => {
  const desktopTsConfig = JSON.parse(read('tsconfig.desktop.json')) as {
    compilerOptions: { outDir: string; module: string };
    include: string[];
  };

  it('compiles the desktop wrapper to CommonJS into dist-desktop', () => {
    expect(desktopTsConfig.compilerOptions.outDir).toBe('dist-desktop');
    // Electron's main and preload runtimes require CommonJS here.
    expect(desktopTsConfig.compilerOptions.module).toBe('CommonJS');
    expect(desktopTsConfig.include).toContain('desktop/**/*.ts');
  });

  it('has the sources the packaged entry points at', () => {
    expect(existsSync(path.join(repoRoot, 'desktop/main/main.ts'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'desktop/preload/preload.ts'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'server/index.ts'))).toBe(true);
    expect(existsSync(path.join(repoRoot, 'src/data/legacy-base-data.json'))).toBe(true);
  });

  it('names an Electron entry that matches the compiled layout after copying', () => {
    const packager = read('scripts/package-portable.mjs');

    // The packager must copy the whole of dist-desktop so the sibling dist-desktop/server/
    // output travels with dist-desktop/desktop/. Copying only the desktop subtree is what
    // broke the Windows build: serverProcess.js requires ../../server/startupSignals.
    expect(packager).toContain("cpSync(resolve(repoRoot, 'dist-desktop'), resolve(appDir, 'dist')");
    expect(packager).not.toContain("'dist-desktop', 'desktop'");
    expect(packager).toContain("main: 'dist/desktop/main/main.js'");

    // main.ts resolves the preload from dist/desktop/main/ to dist/desktop/preload/preload.js.
    const main = read('desktop/main/main.ts');
    expect(main).toContain("'..', 'preload', 'preload.js'");
  });

  it('verifies the packaged tree contains the desktop process module closure', () => {
    const packager = read('scripts/package-portable.mjs');
    // verifyPackage must fail the build if the sibling module is missing, not just check
    // that the entry file exists.
    expect(packager).toContain("'resources/app/dist/server/startupSignals.js'");
    expect(packager).toContain("'resources/app/dist/desktop/main/main.js'");
  });

  it('copies the server runtime where the packaged path resolver looks for it', () => {
    const packager = read('scripts/package-portable.mjs');
    const paths = read('desktop/main/paths.ts');

    expect(packager).toContain("'dist-server'");
    expect(packager).toContain("'server-runtime'");
    expect(paths).toContain("'server-runtime', 'server', 'index.js'");
    expect(packager).toContain("'resources/app/server-runtime/server/index.js'");
  });

  it('ships the seed and the web bundle under the packaged names', () => {
    const packager = read('scripts/package-portable.mjs');
    const paths = read('desktop/main/paths.ts');

    expect(packager).toContain("'seed/legacy-base-data.json'");
    expect(paths).toContain("'seed', 'legacy-base-data.json'");
    expect(packager).toContain("'web'");
    expect(paths).toContain("'web'");
  });

  it('hands the batch publisher the folder the packager actually creates', () => {
    // Fourth cross-file string, and the one that broke the one-click publish silently: the FOLDER is
    // hyphenated (`TNP-Defect-Management-TEST-win-x64`) while only the launcher inside it carries
    // spaces. The batch script had the product name as its folder, so step 7 looked for a launcher
    // that the build never wrote there and refused to publish — on Windows only, where nobody could
    // see why. Reading the default out of the packager rather than repeating it is the fix.
    const packager = read('scripts/package-portable.mjs');
    const folder = /const FOLDER_NAME = argv\.folderName \?\? '([^']+)'/.exec(packager)?.[1];
    const launcher = /const APP_NAME = '([^']+)'/.exec(packager)?.[1];
    expect(folder, 'the packager must keep a single default folder name').toBeTruthy();
    expect(launcher, 'the packager must keep a single product name').toBeTruthy();

    const publish = read('BUILD_AND_PUBLISH_TNP_TEST.bat');
    expect(publish, `the publish script must look in ${folder}`).toContain(
      `set "PORTABLE_DIR=%REPO_ROOT%\\artifacts\\${folder}"`,
    );
    expect(publish).toContain(`if not exist "%PORTABLE_DIR%\\${launcher}.exe"`);
    // An operator who built with --folder-name has one documented way to redirect the run.
    expect(publish).toContain('set "PORTABLE_DIR=%TNP_PORTABLE_DIR%"');
    expect(publish).toContain('if not defined PORTABLE_DIR set');

    expect(read('UPDATE_AND_BUILD_TNP.bat')).toContain(`artifacts\\${folder}`);
  });

  it('refuses to ship company data or runtime folders', () => {
    const packager = read('scripts/package-portable.mjs');
    expect(packager).toContain('EXCEL_EXPORT_FILE_20261002181424.xlsx');
    expect(packager).toContain('Refusing to ship');
    expect(packager).toContain('exactly 191 records');
  });

  it('uses an already-extracted runtime without touching the network', () => {
    const packager = read('scripts/package-portable.mjs');
    // The extracted-runtime check must come before the download, so an offline recovery
    // (manual download or manual extraction into .cache/) needs no network at all.
    const extractedCheck = packager.indexOf('Using the extracted runtime in');
    const downloadStep = packager.indexOf('Downloading ${url}');
    expect(extractedCheck).toBeGreaterThan(-1);
    expect(downloadStep).toBeGreaterThan(-1);
    expect(extractedCheck).toBeLessThan(downloadStep);
  });

  it('never changes the pinned Electron version when the download is unavailable', () => {
    const packager = read('scripts/package-portable.mjs');
    expect(packager).toContain('BLOCKED');
    expect(packager).toContain('was NOT changed');
    // A refused download must not leave a half-built folder behind.
    expect(packager).toContain('no mirror was substituted');
    // An ESM script cannot call require(); that would be a hard runtime failure.
    expect(codeOnly(packager)).not.toContain('require(');
  });

  it('pins Electron in package.json so the build is reproducible', () => {
    const pkg = JSON.parse(read('package.json')) as {
      devDependencies: Record<string, string>;
      main: string;
      scripts: Record<string, string>;
    };
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(pkg.main).toBe('dist-desktop/desktop/main/main.js');
    expect(pkg.scripts['package:portable']).toContain('scripts/package-portable.mjs');
  });
});

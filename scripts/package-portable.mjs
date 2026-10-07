/**
 * Assembles the Windows TEST **portable** build: a plain folder the owner can copy to a
 * Desktop, a USB stick or a network share and run by double-clicking the .exe. No installer,
 * no registry entries, no admin rights, no GitHub Release.
 *
 *   npm run package:portable
 *
 * Layout produced in artifacts/<name>/ :
 *   TNP Defect Management TEST.exe        Electron launcher
 *   *.dll, *.pak, ...                     Electron runtime
 *   resources/app/                        this app
 *     package.json                        main -> dist/desktop/main/main.js
 *     dist/                               the whole of dist-desktop (CommonJS):
 *       desktop/main/, desktop/preload/     the desktop wrapper
 *       server/                             modules the desktop imports from server/
 *     server-runtime/                     compiled Phase 5 server (CommonJS, node: only)
 *     seed/legacy-base-data.json          the 191 canonical records
 *     web/                                built React UI
 *   READ ME FIRST.txt                     owner instructions
 *
 * At first run the app creates data/, backups/ and reports/ next to the .exe, or in the
 * per-user app-data folder if that location is read-only.
 *
 * The Electron runtime zip is the only thing fetched from the network, and only from the
 * official github.com release for the pinned version (or an ELECTRON_MIRROR the owner sets
 * themselves). If that download is unavailable the script stops and reports BLOCKED without
 * changing the pinned version and without producing a half-built folder.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path, { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const argv = parseArgs(process.argv.slice(2));
const APP_NAME = 'TNP Defect Management TEST';
const FOLDER_NAME = argv.folderName ?? 'TNP-Defect-Management-TEST-win-x64';
const ARTIFACTS_DIR = argv.out ? resolve(argv.out) : resolve(repoRoot, 'artifacts');
const CACHE_DIR = resolve(repoRoot, '.cache');

const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const ELECTRON_VERSION = (argv.electronVersion ?? pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? '')
  .replace(/^[\^~]/u, '');

const TARGET_PLATFORM = argv.platform ?? 'win32';
const TARGET_ARCH = argv.arch ?? 'x64';

main().catch((error) => {
  process.stderr.write(`\nPackaging failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  if (!ELECTRON_VERSION) {
    throw new Error('No Electron version is pinned in package.json; refusing to guess one.');
  }

  line(`Packaging ${APP_NAME} (${TARGET_PLATFORM}-${TARGET_ARCH}, Electron ${ELECTRON_VERSION})`);

  const required = [
    ['dist/index.html', 'npm run build'],
    ['dist-server/server/index.js', 'npm run build:server'],
    ['dist-desktop/desktop/main/main.js', 'npm run build:desktop'],
    ['dist-desktop/desktop/preload/preload.js', 'npm run build:desktop'],
    ['src/data/legacy-base-data.json', 'the canonical seed must exist'],
  ];
  for (const [relative, hint] of required) {
    if (!existsSync(resolve(repoRoot, relative))) {
      throw new Error(`Missing ${relative}. Run: ${hint}`);
    }
  }

  const seedRecords = JSON.parse(readFileSync(resolve(repoRoot, 'src/data/legacy-base-data.json'), 'utf8'));
  if (!Array.isArray(seedRecords) || seedRecords.length !== 191) {
    throw new Error(`The seed must contain exactly 191 records, found ${Array.isArray(seedRecords) ? seedRecords.length : 'not an array'}.`);
  }

  const electronRoot = await obtainElectronRuntime();

  const target = resolve(ARTIFACTS_DIR, FOLDER_NAME);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  line('Copying the Electron runtime…');
  cpSync(electronRoot, target, { recursive: true });

  const appDir = resolve(target, 'resources', 'app');
  mkdirSync(appDir, { recursive: true });

  line('Copying the desktop wrapper…');
  // The whole of dist-desktop, not just dist-desktop/desktop. tsc emits the desktop program
  // with its original directory shape, so the compiled desktop/main/serverProcess.js imports
  // "../../server/startupSignals" and expects dist-desktop/server/ to sit beside
  // dist-desktop/desktop/. Copying only the desktop subtree silently drops that sibling and
  // the packaged app dies at startup with "Cannot find module". Copying the output tree
  // verbatim keeps the complete module closure intact, including anything the desktop
  // imports from server/ in future.
  cpSync(resolve(repoRoot, 'dist-desktop'), resolve(appDir, 'dist'), { recursive: true });

  line('Copying the Phase 5 server runtime…');
  cpSync(resolve(repoRoot, 'dist-server'), resolve(appDir, 'server-runtime'), { recursive: true });

  line('Copying the seed and the web UI…');
  mkdirSync(resolve(appDir, 'seed'), { recursive: true });
  cpSync(resolve(repoRoot, 'src/data/legacy-base-data.json'), resolve(appDir, 'seed/legacy-base-data.json'));
  cpSync(resolve(repoRoot, 'dist'), resolve(appDir, 'web'), { recursive: true });

  writeFileSync(
    resolve(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'tnp-defect-management-test',
        productName: APP_NAME,
        version: pkg.version ?? '0.0.0',
        // The updater orders builds on this integer, never on the version string.
        tnpBuild: Number(pkg.tnpBuild) || 0,
        // CommonJS: both the desktop wrapper and the server runtime are compiled to it.
        type: 'commonjs',
        main: 'dist/desktop/main/main.js',
        private: true,
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(resolve(target, 'READ ME FIRST.txt'), readmeText());

  // Refuse to ship anything that is not part of the app.
  const forbidden = [
    'resources/app/server-runtime/EXCEL_EXPORT_FILE_20261002181424.xlsx',
    'resources/app/web/data',
    'resources/app/web/backups',
    'resources/app/web/reports',
  ];
  for (const relative of forbidden) {
    if (existsSync(resolve(target, relative))) {
      throw new Error(`Refusing to ship ${relative}: it must never be part of a distribution.`);
    }
  }

  verifyPackage(target);

  const sizeMb = (directorySizeBytes(target) / (1024 * 1024)).toFixed(1);
  line('');
  line(`Portable build ready: ${target}`);
  line(`  size      ${sizeMb} MB`);
  line(`  launcher  ${join(target, launcherName())}`);
  line('  Run it by double-clicking the launcher. On first start it creates data/, backups/');
  line('  and reports/ next to the launcher and seeds 191 canonical records.');
  if (argv.zip) await createZip(target);
}

/** Uses an already-downloaded runtime when present, otherwise fetches the official zip. */
async function obtainElectronRuntime() {
  // `npm install` normally downloads the runtime for the host platform only, so this hits
  // when packaging for the host itself; a cross-platform build falls through to the download.
  const localDist = resolve(repoRoot, 'node_modules', 'electron', 'dist');
  if (existsSync(resolve(localDist, launcherName()))) {
    line('Using the Electron runtime already present in node_modules/electron/dist.');
    return localDist;
  }

  const zipName = `electron-v${ELECTRON_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}.zip`;
  const cached = resolve(CACHE_DIR, zipName);
  const extracted = resolve(CACHE_DIR, `electron-v${ELECTRON_VERSION}-${TARGET_PLATFORM}-${TARGET_ARCH}`);

  // An already-extracted runtime wins, so a manual download/extraction needs no re-download.
  if (existsSync(resolve(extracted, launcherName())) || existsSync(resolve(extracted, 'electron.exe'))) {
    line(`Using the extracted runtime in ${extracted}.`);
    return extracted;
  }

  if (!existsSync(cached)) {
    const mirror = process.env.ELECTRON_MIRROR;
    const url = mirror
      ? `${mirror.replace(/\/$/u, '')}/v${ELECTRON_VERSION}/${zipName}`
      : `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${zipName}`;

    mkdirSync(CACHE_DIR, { recursive: true });
    line(`Downloading ${url}`);
    line('(this is the only network step; the version is the pinned one and is never changed)');

    let failure = '';
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok) {
        failure = `HTTP ${response.status} from ${url}`;
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        // An HTML error page must not be mistaken for a runtime archive.
        if (bytes.length < 1024 * 1024) {
          failure = `The download was only ${bytes.length} bytes, which is not an Electron runtime.`;
        } else {
          writeFileSync(cached, bytes);
          line(`Downloaded ${(bytes.length / (1024 * 1024)).toFixed(1)} MB.`);
        }
      }
    } catch (error) {
      failure = error instanceof Error ? `${error.message}` : String(error);
    }

    if (failure) {
      if (existsSync(cached)) rmSync(cached, { force: true });
      throw new Error(
        `\nBLOCKED: the Electron runtime could not be downloaded in this environment.\n`
        + `  wanted: v${ELECTRON_VERSION} ${TARGET_PLATFORM}-${TARGET_ARCH}\n`
        + `  from:   ${url}\n`
        + `  error:  ${failure}\n`
        + '\nThe pinned Electron version was NOT changed and no mirror was substituted.\n'
        + 'Run the same command on the Windows PC that will use the build:\n'
        + '  npm install\n  npm run package:portable\n'
        + 'If that machine is also restricted, download the zip manually into .cache/ with the\n'
        + `name ${zipName}, or extract it into .cache/${path.basename(extracted)}/, and re-run\n`
        + 'npm run package:portable.',
      );
    }
  } else {
    line(`Using the cached archive ${basename(cached)}.`);
  }

  if (!existsSync(resolve(extracted, launcherName()))) {
    if (existsSync(extracted)) rmSync(extracted, { recursive: true, force: true });
    mkdirSync(extracted, { recursive: true });
    line('Extracting the runtime…');
    if (!extractZip(cached, extracted)) {
      throw new Error(
        `Could not extract ${zipName}. Install unzip (or bsdtar), or extract it manually into:\n  ${extracted}`,
      );
    }
  }
  return extracted;
}

function extractZip(zipFile, destination) {
  const attempts = [
    ['unzip', ['-q', '-o', zipFile, '-d', destination]],
    ['tar', ['-xf', zipFile, '-C', destination]],
    ['bsdtar', ['-xf', zipFile, '-C', destination]],
  ];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: 'ignore' });
    if (result.status === 0 && existsSync(resolve(destination, launcherName()))) return true;
  }
  return false;
}

function launcherName() {
  return TARGET_PLATFORM === 'win32' ? `${APP_NAME}.exe` : 'electron';
}

/** The Electron zip ships `electron.exe`; the portable build renames it to the product name. */
function verifyPackage(target) {
  const launcher = resolve(target, launcherName());
  if (!existsSync(launcher)) {
    const generic = resolve(target, TARGET_PLATFORM === 'win32' ? 'electron.exe' : 'electron');
    if (!existsSync(generic)) throw new Error('The Electron launcher is missing from the packaged folder.');
    // Rename rather than copy so the runtime keeps its relative layout.
    renameSync(generic, launcher);
  }

  const checks = [
    'resources/app/package.json',
    'resources/app/dist/desktop/main/main.js',
    'resources/app/dist/desktop/preload/preload.js',
    // The desktop main process requires this from ../../server/, so it must travel with it.
    'resources/app/dist/server/startupSignals.js',
    'resources/app/server-runtime/server/index.js',
    'resources/app/server-runtime/package.json',
    'resources/app/seed/legacy-base-data.json',
    'resources/app/web/index.html',
    // Phase 7: the standalone updater helper is spawned from inside the runtime, so it has to
    // ship with it or an update can never be applied on the Owner PC.
    'resources/app/dist/desktop/update/helperMain.js',
  ];
  for (const relative of checks) {
    const full = resolve(target, relative);
    if (!existsSync(full)) throw new Error(`The packaged build is incomplete: ${relative} is missing.`);
    if (!statSync(full).isFile()) throw new Error(`The packaged build is corrupt: ${relative} is not a file.`);
  }
  line(`Verified ${checks.length + 1} packaged files.`);
}

async function createZip(target) {
  const zipPath = `${target}.zip`;
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });
  const attempts = process.platform === 'win32'
    ? [['powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${target}\\*' -DestinationPath '${zipPath}' -Force`]]]
    : [['zip', ['-qr', zipPath, basename(target)]]];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { cwd: ARTIFACTS_DIR, stdio: 'inherit' });
    if (result.status === 0 && existsSync(zipPath)) {
      line(`Zip written: ${zipPath}`);
      return;
    }
  }
  line('Zip skipped: no zip tool is available here. The folder itself is the deliverable.');
}

function directorySizeBytes(dir) {
  let total = 0;
  for (const entry of readdirRecursive(dir)) {
    try {
      total += statSync(entry).size;
    } catch {
      // Ignore entries that disappear while measuring.
    }
  }
  return total;
}

function readdirRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readdirRecursive(full));
    else out.push(full);
  }
  return out;
}

function readmeText() {
  return [
    `${APP_NAME} — portable TEST build`,
    '='.repeat(52),
    '',
    'HOW TO RUN',
    `  Double-click "${launcherName()}".`,
    '  No installation and no administrator rights are needed.',
    '',
    'WHERE YOUR DATA LIVES',
    '  On first run the app creates three folders next to this file:',
    '    data/      the SQLite database, its lock file and the server log',
    '    backups/   automatic daily, pre-import and manual snapshots',
    '    reports/   report files attached to records',
    '  Copying this whole folder copies everything. If the folder is read-only',
    '  (for example on a locked share) the app stores data in your Windows user',
    '  profile instead and says so on the System page.',
    '',
    'FIRST START',
    '  A fresh database is created and filled with the 191 canonical records.',
    '  An existing database is always preserved and never reseeded.',
    '',
    'OTHER PCs ON THE SAME NETWORK',
    '  By default the server listens on 127.0.0.1 only, so this PC alone can',
    '  reach the data. LAN access is off until you turn it on from the System',
    '  page and restart. Windows may then ask to allow the app on Private',
    '  networks; that is the Windows firewall, and this app never changes it.',
    '',
    'SECURITY — PLEASE READ',
    '  This is a TEST build. It has no sign-in and no encryption. Anyone who can',
    '  reach the server can read and change every record, so only enable LAN on a',
    '  trusted internal network, and never expose it to the Internet.',
    '',
    'IF IT DOES NOT START',
    '  Read data/server.log, and make sure no other copy of this app is running',
    '  against the same folder. Port 8787 is used by default; if it is taken the',
    '  app picks another free port automatically.',
    '',
  ].join('\n');
}

function line(text) {
  process.stdout.write(`${text}\n`);
}

function parseArgs(args) {
  const out = {};
  for (const arg of args) {
    const match = /^--([\w-]+)(?:=(.*))?$/u.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    // Accept --folder-name and --folderName alike.
    const camel = key.replace(/-([a-z])/gu, (_all, letter) => letter.toUpperCase());
    out[camel] = value === undefined ? true : value;
  }
  return out;
}

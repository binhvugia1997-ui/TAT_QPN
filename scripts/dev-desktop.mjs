/**
 * Developer desktop run: builds what is missing, then launches Electron against the
 * repository so `data/`, `backups/` and `reports/` stay in the usual gitignored places
 * instead of being created next to the Electron binary.
 *
 *   npm run desktop
 *
 * This is for developing the wrapper. The owner uses `npm run package:portable`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function run(script) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.stderr.write(`\n\`npm run ${script}\` failed.\n`);
    process.exit(result.status ?? 1);
  }
}

run('build:server');
run('build:desktop');
if (!existsSync(resolve(repoRoot, 'dist', 'index.html'))) {
  run('build');
}

const electron = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
if (!existsSync(electron)) {
  process.stderr.write(
    '\nThe Electron binary is not installed, so the desktop wrapper cannot run here.\n'
    + 'Install it on a machine that can download it, then run: npm run desktop\n'
    + 'The web build still works without it: npm run dev\n',
  );
  process.exit(1);
}

const child = spawn(electron, [repoRoot], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    // Keeps dev data in the repository's own gitignored folders.
    TNP_DATA_ROOT: process.env.TNP_DATA_ROOT ?? repoRoot,
  },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

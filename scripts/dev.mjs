import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Development convenience: runs the authoritative Node/SQLite server and the Vite dev
 * server together. Vite proxies `/api` to the local server, so the browser only ever uses
 * same-origin relative URLs.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.TNP_PORT ?? '8787';
const lanEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.TNP_LAN ?? '').toLowerCase());

const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:server'], {
  cwd: root,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const entry = resolve(root, 'dist-server', 'server', 'index.js');
if (!existsSync(entry)) {
  process.stderr.write(`The server entry "${entry}" is missing after the build.\n`);
  process.exit(1);
}

const children = [];

function start(name, command, args) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, TNP_PORT: port } });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    process.stdout.write(`[${name}] exited with code ${code}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('server', process.execPath, [entry, ...(lanEnabled ? ['--lan'] : [])]);
start('web', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:web']);

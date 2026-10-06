/**
 * The standalone updater helper.
 *
 * A running Electron app cannot replace its own executable, so the desktop spawns this script
 * as a **separate, detached process** using the Electron binary itself as a plain Node runtime
 * (`ELECTRON_RUN_AS_NODE=1`). It needs no Node, npm, Python or any other tool on the Owner PC.
 *
 * Sequence:
 *   1. wait for the TNP processes to exit (never force-killed while waiting)
 *   2. back up the current runtime into `.tnp-update/runtime-backup/`
 *   3. replace the runtime from the validated staging directory
 *   4. relaunch TNP
 *   5. on any failure, roll the runtime back and relaunch the previous build
 *
 * Production data is never enumerated here: `data/`, `backups/` and `reports/` are excluded by
 * the layout contract, and every filesystem operation is guarded against touching them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { applyRuntime, backupRuntime, rollbackRuntime, verifyPreserved } from './install';
import type { InstallPlan } from './install';
import type { UpdateLayout } from './layout';

export interface HelperPlan {
  runtimeRoot: string;
  updateDir: string;
  /** Absolute path of the file this plan was read from; used when re-spawning. */
  planFile: string;
  stagedDir: string;
  backupRoot: string;
  runtimeEntries: string[];
  previousBuild: number;
  targetBuild: number;
  /** PID of the TNP process that spawned this helper. */
  waitForPid: number;
  waitForExitMs: number;
  /** Executable to relaunch, and its working directory. */
  relaunchCommand: string;
  relaunchArgs: string[];
  relaunchCwd: string;
  logFile: string;
  resultFile: string;
}

export interface HelperResult {
  ok: boolean;
  stage: 'BACKUP' | 'INSTALL' | 'ROLLBACK' | 'COMPLETE' | 'FAILED';
  previousBuild: number;
  targetBuild: number;
  message: string;
  preserved: string[];
  rolledBack: boolean;
  finishedAt: string;
}

const DEFAULT_WAIT_MS = 30_000;

export function parseHelperArgs(argv: readonly string[]): { planFile: string } {
  let planFile = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--plan') {
      planFile = String(argv[index + 1] ?? '');
      index += 1;
    }
  }
  if (!planFile) throw new Error('The updater helper requires --plan <file>.');
  return { planFile };
}

export function readHelperPlan(file: string): HelperPlan {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HelperPlan>;
  const required: Array<keyof HelperPlan> = [
    'runtimeRoot', 'updateDir', 'stagedDir', 'backupRoot', 'runtimeEntries',
    'previousBuild', 'targetBuild', 'waitForPid', 'relaunchCommand', 'logFile', 'resultFile',
  ];
  for (const key of required) {
    if (parsed[key] === undefined) throw new Error(`The updater plan is missing "${String(key)}".`);
  }
  return {
    runtimeRoot: String(parsed.runtimeRoot),
    updateDir: String(parsed.updateDir),
    planFile: String(parsed.planFile ?? ''),
    stagedDir: String(parsed.stagedDir),
    backupRoot: String(parsed.backupRoot),
    runtimeEntries: Array.isArray(parsed.runtimeEntries) ? parsed.runtimeEntries.map(String) : [],
    previousBuild: Number(parsed.previousBuild),
    targetBuild: Number(parsed.targetBuild),
    waitForPid: Number(parsed.waitForPid),
    waitForExitMs: Number(parsed.waitForExitMs) || DEFAULT_WAIT_MS,
    relaunchCommand: String(parsed.relaunchCommand),
    relaunchArgs: Array.isArray(parsed.relaunchArgs) ? parsed.relaunchArgs.map(String) : [],
    relaunchCwd: String(parsed.relaunchCwd ?? parsed.runtimeRoot),
    logFile: String(parsed.logFile),
    resultFile: String(parsed.resultFile),
  };
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means it is gone; EPERM means it exists but is not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitForExit(pid: number, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(200);
  }
  return !isProcessRunning(pid);
}

/** Builds the layout the install routines guard against, from the plan. */
export function layoutFromPlan(plan: HelperPlan): UpdateLayout {
  const runtimeRoot = path.resolve(plan.runtimeRoot);
  return {
    runtimeRoot,
    updateDir: path.resolve(plan.updateDir),
    downloadDir: path.join(plan.updateDir, 'download'),
    stagingDir: path.resolve(plan.stagedDir),
    runtimeBackupDir: path.resolve(plan.backupRoot),
    planFile: path.join(plan.updateDir, 'update-plan.json'),
    updateLogFile: plan.logFile,
    preservedDirs: [
      path.join(runtimeRoot, 'data'),
      path.join(runtimeRoot, 'backups'),
      path.join(runtimeRoot, 'reports'),
      path.resolve(plan.updateDir),
    ],
  };
}

export interface RunHelperOptions {
  plan: HelperPlan;
  sleep?: (ms: number) => Promise<void>;
  relaunch?: (plan: HelperPlan) => void;
  log?: (line: string) => void;
}

/**
 * Runs the whole helper sequence. Kept free of `process.exit` and of direct spawning so it can
 * be unit tested; `main` below is the thin process entry point.
 */
export async function runHelper(options: RunHelperOptions): Promise<HelperResult> {
  const { plan } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const log = options.log ?? (() => undefined);
  const layout = layoutFromPlan(plan);

  const base = {
    previousBuild: plan.previousBuild,
    targetBuild: plan.targetBuild,
    preserved: [] as string[],
    rolledBack: false,
    finishedAt: new Date().toISOString(),
  };

  log(`waiting for TNP (pid ${plan.waitForPid}) to exit, up to ${plan.waitForExitMs} ms`);
  const exited = await waitForExit(plan.waitForPid, plan.waitForExitMs, sleep);
  if (!exited) {
    // Fail safe: leave the current, working runtime completely alone.
    const message = `TNP was still running after ${plan.waitForExitMs} ms; the update was abandoned.`;
    log(message);
    return { ...base, ok: false, stage: 'FAILED', message, rolledBack: false };
  }

  const installPlan: InstallPlan = {
    runtimeRoot: layout.runtimeRoot,
    updateDir: layout.updateDir,
    stagedDir: layout.stagingDir,
    backupDir: path.join(layout.runtimeBackupDir, `runtime-build${plan.targetBuild}`),
    runtimeEntries: plan.runtimeEntries,
    previousBuild: plan.previousBuild,
    targetBuild: plan.targetBuild,
    createdAt: new Date().toISOString(),
  };

  log(`backing up the current runtime to ${installPlan.backupDir}`);
  let backup;
  try {
    backup = backupRuntime(installPlan, layout);
  } catch (error) {
    const message = `The runtime backup failed: ${error instanceof Error ? error.message : String(error)}`;
    log(message);
    relaunch(options);
    return { ...base, ok: false, stage: 'FAILED', message, rolledBack: false };
  }
  if (!backup.ok) {
    log(backup.message);
    relaunch(options);
    return { ...base, ok: false, stage: 'BACKUP', message: backup.message, rolledBack: false };
  }
  log(backup.message);

  log('replacing the runtime');
  try {
    const applied = applyRuntime(installPlan, layout);
    log(applied.message);
  } catch (error) {
    const message = `The runtime install failed: ${error instanceof Error ? error.message : String(error)}`;
    log(`${message} — rolling back`);
    const rolled = rollbackRuntime(installPlan, layout);
    log(rolled.message);
    relaunch(options);
    return {
      ...base,
      ok: false,
      stage: 'ROLLBACK',
      message: `${message} Rolled back: ${rolled.ok ? 'yes' : 'no'}.`,
      rolledBack: rolled.ok,
      preserved: verifyPreserved(layout).missing,
    };
  }

  const preserved = verifyPreserved(layout);
  if (!preserved.ok) {
    // Production data missing is far worse than a failed update: roll the runtime back and
    // report loudly rather than continuing into an unknown state.
    const message = `Production data is missing after the install: ${preserved.missing.join(', ')}`;
    log(`${message} — rolling back`);
    const rolled = rollbackRuntime(installPlan, layout);
    relaunch(options);
    return { ...base, ok: false, stage: 'ROLLBACK', message, rolledBack: rolled.ok, preserved: preserved.missing };
  }

  log('runtime replaced; relaunching TNP');
  relaunch(options);
  return {
    ...base,
    ok: true,
    stage: 'COMPLETE',
    message: `Updated from build ${plan.previousBuild} to build ${plan.targetBuild}.`,
    preserved: [],
    rolledBack: false,
  };
}

function relaunch(options: RunHelperOptions): void {
  if (options.relaunch) {
    options.relaunch(options.plan);
    return;
  }
  spawn(options.plan.relaunchCommand, options.plan.relaunchArgs, {
    cwd: options.plan.relaunchCwd,
    detached: true,
    stdio: 'ignore',
  }).unref();
}

/** Process entry point: `electron.exe` with ELECTRON_RUN_AS_NODE=1, or plain node. */
/**
 * @param overrides only used by tests, so they can prove the result file is written without
 * really launching an executable.
 */
export async function main(
  argv: readonly string[],
  overrides: { relaunch?: (plan: HelperPlan) => void } = {},
): Promise<number> {
  const { planFile } = parseHelperArgs(argv);
  const plan = readHelperPlan(planFile);

  const log = (line: string): void => {
    try {
      fs.mkdirSync(path.dirname(plan.logFile), { recursive: true });
      fs.appendFileSync(plan.logFile, `${new Date().toISOString()} [updater] ${line}\n`, 'utf8');
    } catch {
      // Logging must never stop the update.
    }
  };

  let result: HelperResult;
  try {
    result = await runHelper({ plan, log, relaunch: overrides.relaunch });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    log(`the updater failed: ${message}`);
    result = {
      ok: false,
      stage: 'FAILED',
      previousBuild: plan.previousBuild,
      targetBuild: plan.targetBuild,
      message: `The updater failed: ${error instanceof Error ? error.message : String(error)}`,
      preserved: [],
      rolledBack: false,
      finishedAt: new Date().toISOString(),
    };
  }

  try {
    fs.mkdirSync(path.dirname(plan.resultFile), { recursive: true });
    fs.writeFileSync(plan.resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } catch {
    // The result file is for diagnostics; failing to write it must not fail the update.
  }
  log(`finished: ${result.stage} — ${result.message}`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

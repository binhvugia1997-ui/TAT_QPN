import { closeContext, createContext } from './context';
import { createHttpServer } from './http/app';
import { acquireDatabaseLock, DatabaseLockError } from './lock';
import { getLanAddresses } from './lan';
import { describePath, resolveRuntimePaths } from './paths';
import type { ConfigOverrides } from './config';

interface CliOptions {
  overrides: ConfigOverrides;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const overrides: ConfigOverrides = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--lan') overrides.lanEnabled = true;
    else if (argument === '--no-lan') overrides.lanEnabled = false;
    else if (argument === '--port') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--port requires a positive integer.');
      overrides.port = value;
      index += 1;
    } else if (argument === '--host') {
      const value = argv[index + 1];
      if (!value) throw new Error('--host requires an address.');
      overrides.bindHost = value;
      index += 1;
    }
  }
  return { overrides };
}

async function main(): Promise<void> {
  const paths = resolveRuntimePaths();
  const { overrides } = parseArgs(process.argv.slice(2));

  let releaseLock: (() => void) | undefined;
  let context: Awaited<ReturnType<typeof createContext>> | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;

  const shutdown = (signal: string) => {
    process.stdout.write(`\n[${signal}] Shutting down the TNP server…\n`);
    try {
      server?.close();
    } catch {
      // Already closed.
    }
    if (context) closeContext(context);
    releaseLock?.();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    releaseLock = acquireDatabaseLock(paths.lockFile, paths.databaseFile);
  } catch (error) {
    if (error instanceof DatabaseLockError) {
      process.stderr.write(`Startup refused: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  context = await createContext({ paths, configOverrides: overrides });
  const { config } = context;

  server = createHttpServer({ context });
  const httpServer = server;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.bindHost, resolve);
  });

  const address = httpServer.address();
  const actualPort = address && typeof address === 'object' ? address.port : config.port;

  process.stdout.write(
    [
      '',
      '  TNP Defect Management — local server (Phase 5)',
      `  Storage      SQLite at ${describePath(paths, paths.databaseFile)}`,
      `  Schema       version ${context.database.userVersion}`,
      `  Records      ${context.records.count()}`,
      `  Seed         ${context.seed.alreadyInitialized ? 'existing database preserved' : `${context.seed.seeded} canonical records seeded`}`,
      `  Bind         ${config.bindHost}:${actualPort}`,
      `  Local URL    http://127.0.0.1:${actualPort}`,
      `  LAN          ${config.lanEnabled ? 'ENABLED' : 'disabled (localhost only)'}`,
      ...context.config.lanEnabled
        ? getLanAddresses(actualPort).map((entry) => `  LAN URL      ${entry.url}  (${entry.interface})`)
        : ['  LAN URL      enable with --lan or TNP_LAN=1, then restart'],
      `  Backups      ${describePath(paths, paths.backupsDir)}`,
      `  Reports      ${describePath(paths, paths.reportsDir)}`,
      '',
      config.lanEnabled
        ? '  WARNING: LAN mode has no authentication and no TLS. Use it only on a trusted'
        + '\n           internal network, and allow the app through the Windows Private-network'
        + '\n           firewall if other PCs cannot connect.'
        : '',
      '',
    ].filter((line, index, all) => !(line === '' && index > 0 && all[index - 1] === ''))
      .join('\n'),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`The TNP server could not start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The lists that have to agree about the desktop bridge, checked from the files themselves.
 *
 * The bridge is a whitelist in two directions: the main process registers a fixed set of IPC
 * channels, and the preload exposes a fixed set of methods that may call them. Add a handler and
 * forget the preload list and the page gets "No handler registered" at run time; add a preload
 * method and forget the handler and the same happens in the other direction. Neither is visible in
 * a type check, because `ipcRenderer.invoke` takes a plain string.
 *
 * So this reads the sources rather than importing them: the thing under test is the wiring between
 * files, and importing either one pulls in Electron.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

/** Extracts the members of an `as const` string array, e.g. `export const BRIDGE_CHANNELS = [...]`. */
function channelArray(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`);
  expect(start, `${name} should be declared`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('] as const', start));
  return [...body.matchAll(/'(tnp:[a-z0-9-]+)'/gu)].map((match) => match[1] as string);
}

const bridge = read('desktop/main/bridge.ts');
const updater = read('desktop/main/updater.ts');
const preload = read('desktop/preload/preload.ts');
const types = read('desktop/types/tnpDesktop.ts');

const registered = [...channelArray(bridge, 'BRIDGE_CHANNELS'), ...channelArray(updater, 'UPDATE_CHANNELS')];
const allowed = channelArray(preload, 'ALLOWED_CHANNELS');
/** The push channel: main → renderer only, so it is never `invoke`d. */
const pushChannel = /const UPDATE_EVENT_CHANNEL = '(tnp:[a-z0-9-]+)'/u.exec(preload)?.[1] ?? '';

/** Channels the preload actually calls, taken from the `call('tnp:…')` sites rather than a scan. */
const invoked = [...preload.matchAll(/call(?:<[^>]*>)?\('(tnp:[a-z0-9-]+)'/gu)].map((match) => match[1] as string);

/** The body of one `handle('tnp:x', …)` registration, sliced up to the next registration. */
function handlerBody(source: string, channel: string): string {
  const start = source.indexOf(`handle('${channel}'`);
  expect(start, `${channel} should have a handler`).toBeGreaterThan(-1);
  const next = source.indexOf('\n  handle(', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('desktop bridge channel wiring', () => {
  it('registers every channel the preload is allowed to call', () => {
    expect(registered.length).toBeGreaterThan(8);
    for (const channel of allowed) {
      expect(registered, `${channel} is exposed but never registered`).toContain(channel);
    }
  });

  it('calls only whitelisted channels from the preload', () => {
    expect(invoked.length).toBeGreaterThan(8);
    for (const channel of new Set(invoked)) {
      expect(allowed, `${channel} is called without being whitelisted`).toContain(channel);
    }
  });

  it('keeps the state push channel out of the invokable list', () => {
    // A renderer that could invoke `tnp:update-state` could feed the preload's own listener. The
    // event channel is deliberately registered nowhere: it is broadcast at, not called.
    expect(pushChannel).toBe('tnp:update-state');
    expect(allowed).not.toContain(pushChannel);
    expect(registered).not.toContain(pushChannel);
    expect(invoked).not.toContain(pushChannel);
    expect(preload).toContain(`ipcRenderer.on(UPDATE_EVENT_CHANNEL`);
  });

  it('has no registered channel that the preload does not know about', () => {
    // A handler nobody can call is dead code that still needs securing; a channel the page wants
    // must be added in both places on purpose.
    const unreachable = registered.filter((channel) => !allowed.includes(channel) && !invoked.includes(channel));
    expect(unreachable).toEqual([]);
  });

  it('exposes in the preload every method the bridge interface promises', () => {
    const interfaceBody = types.slice(types.indexOf('export interface TnpDesktopBridge'));
    const methods = [...interfaceBody.matchAll(/^ {2}([a-zA-Z]+)\(/gmu)].map((match) => match[1] as string);
    expect(methods.length).toBeGreaterThan(10);

    const exposed = [...preload.matchAll(/^ {2}([a-zA-Z]+): /gmu)].map((match) => match[1] as string);
    for (const method of methods) {
      expect(exposed, `TnpDesktopBridge.${method}() has no preload implementation`).toContain(method);
    }
  });

  it('routes the update-folder check through its own channel, not through state loading', () => {
    // Reading a dead share blocks until SMB times out. `get-desktop-state` runs on every panel open
    // and refresh, so validating a source must be a separate, operator-initiated call — the one
    // architectural decision in this feature that keeps the Settings page from hanging.
    expect(allowed).toContain('tnp:validate-update-source');
    expect(registered).toContain('tnp:validate-update-source');

    const stateHandler = handlerBody(bridge, 'tnp:get-desktop-state');
    expect(stateHandler.length).toBeGreaterThan(0);
    expect(stateHandler).not.toContain('validateUpdateSource');
    expect(stateHandler).not.toMatch(/readFile|statSync|fs\.promises\.stat/u);
    // The validation handler is the only one that touches the configured folder, and it is a read.
    expect(handlerBody(bridge, 'tnp:validate-update-source')).toContain('validateUpdateSource(');
    expect(handlerBody(bridge, 'tnp:validate-update-source')).not.toMatch(/writeFile|mkdir|rmSync|copyFile/u);
  });
});

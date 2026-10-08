/**
 * Preload bridge. Runs in an isolated context with `contextIsolation` on and `sandbox` on,
 * so it has no Node globals of its own beyond what is imported here.
 *
 * It exposes exactly the members of `TnpDesktopBridge` and nothing else: each one is a fixed
 * channel name, and `ipcRenderer.invoke` is never handed to the page. Results are unwrapped
 * here so the renderer only ever sees a value or a message.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  TnpDesktopBridge,
  TnpDesktopState,
  TnpDesktopSettings,
  TnpPickResult,
  TnpUpdateSourceValidation,
  TnpUpdateState,
} from '../types/tnpDesktop';

/** Whitelist: a channel not in this list can never be reached from the page. */
const ALLOWED_CHANNELS = [
  'tnp:get-desktop-state',
  'tnp:pick-report-file',
  'tnp:attach-report',
  'tnp:open-report',
  'tnp:reveal-data-folder',
  'tnp:create-backup',
  'tnp:set-lan-enabled',
  'tnp:set-workstation-label',
  'tnp:validate-update-source',
  'tnp:restart-server',
  'tnp:get-update-state',
  'tnp:check-update',
  'tnp:install-update',
  'tnp:dismiss-update',
  'tnp:set-update-source',
] as const;

/** The one channel the desktop pushes to. The page cannot send on it. */
const UPDATE_EVENT_CHANNEL = 'tnp:update-state';

type AllowedChannel = (typeof ALLOWED_CHANNELS)[number];

interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

async function call<T>(channel: AllowedChannel, ...args: unknown[]): Promise<T> {
  if (!(ALLOWED_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error('That desktop action is not available.');
  }
  const envelope = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>;
  if (!envelope || envelope.ok !== true) {
    throw new Error(envelope?.error ?? 'The desktop could not complete that action.');
  }
  return envelope.value as T;
}

const bridge: TnpDesktopBridge = {
  isDesktop: true,
  getDesktopState: () => call<TnpDesktopState>('tnp:get-desktop-state'),
  pickReportFile: () => call<TnpPickResult>('tnp:pick-report-file'),
  attachReport: (recordId, token) => call<unknown>('tnp:attach-report', recordId, token),
  openReport: (recordId) => call<{ opened: boolean; fileName: string }>('tnp:open-report', recordId),
  revealDataFolder: () => call<{ opened: boolean; path: string }>('tnp:reveal-data-folder'),
  createBackup: () => call<unknown>('tnp:create-backup'),
  setLanEnabled: (enabled) =>
    call<{ settings: TnpDesktopSettings; restartRequired: boolean }>('tnp:set-lan-enabled', enabled),
  setWorkstationLabel: (label) =>
    call<{ settings: TnpDesktopSettings; restartRequired: boolean }>('tnp:set-workstation-label', label),
  restartServer: () => call<{ baseUrl: string; port: number }>('tnp:restart-server'),
  getUpdateState: () => call<TnpUpdateState>('tnp:get-update-state'),
  checkForUpdate: () => call<{ status: string }>('tnp:check-update'),
  installUpdate: () => call<{ started: boolean }>('tnp:install-update'),
  dismissUpdate: () => call<{ dismissed: boolean }>('tnp:dismiss-update'),
  setUpdateSource: (source) =>
    call<{ source: string; state: TnpUpdateState }>('tnp:set-update-source', source),
  // A read of the share, so it can be slow; the page calls it from a button and shows a spinner.
  validateUpdateSource: (source) =>
    call<TnpUpdateSourceValidation>('tnp:validate-update-source', source),
  onUpdateState: (listener) => {
    const handler = (_event: unknown, state: TnpUpdateState): void => { listener(state); };
    ipcRenderer.on(UPDATE_EVENT_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(UPDATE_EVENT_CHANNEL, handler); };
  },
};

contextBridge.exposeInMainWorld('tnpDesktop', bridge);

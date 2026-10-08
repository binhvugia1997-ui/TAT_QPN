/**
 * The only surface the renderer can reach on the desktop wrapper.
 *
 * Every member maps to one whitelisted IPC channel; there is deliberately no generic
 * `invoke`, no `send`, and no way to pass a filesystem path in from the page. Attach takes an
 * opaque single-use token that the main process minted from its own native file picker, and
 * open takes only a canonical record id.
 */

export interface TnpDesktopServerSummary {
  running: boolean;
  port: number | null;
  baseUrl: string | null;
  pid: number | null;
}

export interface TnpDesktopLayoutSummary {
  root: string;
  dataDir: string;
  backupsDir: string;
  reportsDir: string;
  databaseFile: string;
  portable: boolean;
  rootNote: string;
}

export interface TnpDesktopSettings {
  lanEnabled: boolean;
  port: number;
  workstationLabel: string;
  /** LAN folder holding version.json and update packages; empty means checking is off. */
  updateSource: string;
  updateChannel: string;
  updateChecksEnabled: boolean;
}

/**
 * The renderer's view of the updater. Deliberately a plain data shape, re-declared here rather
 * than imported from the updater modules: the page must not pull in Node-typed code.
 */
export type TnpUpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'up-to-date'
  | 'unavailable'
  | 'update-available'
  | 'downloading'
  | 'installing'
  | 'complete'
  | 'failed';

export type TnpUpdateStage =
  | 'CHECKING'
  | 'COPYING'
  | 'VERIFYING'
  | 'VALIDATING'
  | 'STAGING'
  | 'WAITING_FOR_EXIT'
  | 'INSTALLING'
  | 'ROLLING_BACK'
  | 'RESTARTING'
  | 'COMPLETE'
  | 'FAILED';

export interface TnpUpdateProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  transferRate: number;
  stage: TnpUpdateStage;
}

export interface TnpUpdateState {
  phase: TnpUpdatePhase;
  stage: TnpUpdateStage | null;
  local: { version: string; build: number };
  available: {
    version: string;
    build: number;
    publishedAt: string;
    releaseNotes: string | null;
    size: number;
    package: string;
    source: string;
  } | null;
  progress: TnpUpdateProgress | null;
  error: string | null;
  lastResult: {
    ok: boolean;
    stage: string;
    previousBuild: number;
    targetBuild: number;
    message: string;
  } | null;
  source: string | null;
}

/**
 * The Settings-side answer to "is this update folder right?" — a re-declaration of the main
 * process result, kept as plain data because the page must not import Node-typed modules.
 */
export interface TnpUpdateSourceValidation {
  state:
    | 'not-configured'
    | 'unreachable'
    | 'not-readable'
    | 'read-only'
    | 'no-manifest'
    | 'invalid-manifest'
    | 'ready';
  source: string;
  message: string;
  usable: boolean;
  manifest: { version: string; build: number; channel: string; package: string } | null;
  channelMatches: boolean | null;
  checkedAt: string;
}

/** What this installation actually is, so a published build can be recognised as already running. */
export interface TnpDesktopUpdateSummary {
  installed: { version: string; build: number } | null;
  channel: string;
  checksEnabled: boolean;
  /** The folder the updater resolved, i.e. what it will really read, not what was typed. */
  resolvedSource: string | null;
  /** False in a development checkout, where no update folder can be used at all. */
  updateCapable: boolean;
}

export interface TnpDesktopState {
  server: TnpDesktopServerSummary;
  status: Record<string, unknown> | null;
  statusError: string | null;
  layout: TnpDesktopLayoutSummary;
  settings: TnpDesktopSettings;
  security: { authentication: boolean; tls: boolean; warning: string };
  /**
   * Present only in the desktop build. Deliberately computed without touching the filesystem: a
   * dead share can take seconds to time out, and this state is read on every panel open and
   * refresh. Validating a source is therefore a separate, explicit call.
   */
  update?: TnpDesktopUpdateSummary;
}

export interface TnpPickResult {
  canceled: boolean;
  token?: string;
  fileName?: string;
  sizeBytes?: number;
}

export interface TnpDesktopBridge {
  /** Build marker so the page can tell the desktop wrapper from a plain browser tab. */
  readonly isDesktop: true;
  getDesktopState(): Promise<TnpDesktopState>;
  pickReportFile(): Promise<TnpPickResult>;
  /** Sends the picked file to the server, which stores it inside managed storage. */
  attachReport(recordId: string | number, token: string): Promise<unknown>;
  /** Asks Windows to open the record's managed report in its default application. */
  openReport(recordId: string | number): Promise<{ opened: boolean; fileName: string }>;
  revealDataFolder(): Promise<{ opened: boolean; path: string }>;
  createBackup(): Promise<unknown>;
  /** Persists the preference; the server must be restarted for it to take effect. */
  setLanEnabled(enabled: boolean): Promise<{ settings: TnpDesktopSettings; restartRequired: boolean }>;
  setWorkstationLabel(label: string): Promise<{ settings: TnpDesktopSettings; restartRequired: boolean }>;
  restartServer(): Promise<{ baseUrl: string; port: number }>;

  /** LAN update controls. Only meaningful in the packaged portable build. */
  getUpdateState(): Promise<TnpUpdateState>;
  checkForUpdate(): Promise<{ status: string }>;
  /** Copies, verifies, validates and stages the update, then hands over to the helper. */
  installUpdate(): Promise<{ started: boolean }>;
  /** [Later]: do not offer this build again until TNP is restarted. */
  dismissUpdate(): Promise<{ dismissed: boolean }>;
  /**
   * Saves the folder and reports what was stored — the normalised value, which can differ from what
   * was typed (a trailing separator, `/` instead of a backslash).
   */
  setUpdateSource(source: string): Promise<{ source: string; state: TnpUpdateState }>;
  /** Reads the folder and reports whether an update could actually be installed from it. */
  validateUpdateSource(source: string): Promise<TnpUpdateSourceValidation>;
  /** Subscribes to updater state pushes; returns the unsubscribe function. */
  onUpdateState(listener: (state: TnpUpdateState) => void): () => void;
}

declare global {
  interface Window {
    tnpDesktop?: TnpDesktopBridge;
  }
}

export {};

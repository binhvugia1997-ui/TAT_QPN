/** Shared state shapes for the update UI and the updater log. */

/**
 * The stage list and the stage type live in `transfer.ts` so there is exactly one definition
 * shared by the byte progress reporter, the updater and the UI.
 */
export { UPDATE_STAGES } from './transfer';
export type { UpdateStage, TransferProgress as UpdateTransferProgress } from './transfer';
import type { UpdateStage } from './transfer';

export type UpdatePhase =
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

export interface UpdateProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  transferRate: number;
  stage: UpdateStage;
}

export interface AppVersionSummary {
  version: string;
  build: number;
}

export interface AvailableUpdateSummary {
  version: string;
  build: number;
  publishedAt: string;
  releaseNotes: string | null;
  size: number;
  package: string;
  source: string;
}

export interface UpdateState {
  phase: UpdatePhase;
  stage: UpdateStage | null;
  local: AppVersionSummary;
  available: AvailableUpdateSummary | null;
  progress: UpdateProgress | null;
  error: string | null;
  /** Result of the last helper run, read back after a restart. */
  lastResult: { ok: boolean; stage: string; previousBuild: number; targetBuild: number; message: string } | null;
  source: string | null;
}

export function initialUpdateState(local: AppVersionSummary): UpdateState {
  return {
    phase: 'idle',
    stage: null,
    local,
    available: null,
    progress: null,
    error: null,
    lastResult: null,
    source: null,
  };
}


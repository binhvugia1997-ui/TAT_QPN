export interface ImportFileSummary {
  fileName: string;
  added: number;
  updated: number;
  unchanged: number;
  total: number;
  error?: string;
}

export interface ImportHistoryEntry {
  id: string;
  importedAt: string;
  files: ImportFileSummary[];
  added: number;
  updated: number;
  unchanged: number;
  total: number;
}

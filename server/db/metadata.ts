import type { SqliteDatabase } from './connection';

export class MetadataStore {
  constructor(private readonly database: SqliteDatabase) {}

  get(key: string): string | undefined {
    return this.database.get<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key])?.value;
  }

  set(key: string, value: string, now = new Date().toISOString()): void {
    this.database.run(
      'INSERT INTO metadata (key, value, updated_at) VALUES (?,?,?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, now],
    );
  }
}

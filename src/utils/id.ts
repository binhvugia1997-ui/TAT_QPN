let fallbackCounter = 0;

export function createRecordId(prefix = 'record'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  fallbackCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

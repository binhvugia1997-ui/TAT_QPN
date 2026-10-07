/**
 * Browser-side boundary to the authoritative local Node/SQLite server. Every path is
 * same-origin and relative, so the same code works behind the Vite dev proxy, behind the
 * production static server, and from a LAN workstation.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Raised when the server reports that another client changed the record first. */
export class RecordConflictError extends ApiError {
  constructor(
    message: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
    readonly idKey: string,
  ) {
    super(409, 'conflict', message);
    this.name = 'RecordConflictError';
  }
}

export class ServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUnavailableError';
  }
}

function toError(status: number, payload: unknown): ApiError {
  const body = (payload ?? {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' ? body.message : `The server returned status ${status}.`;
  const code = typeof body.error === 'string' ? body.error : 'server-error';

  if (status === 409 && code === 'conflict') {
    return new RecordConflictError(
      message,
      Number(body.expectedVersion ?? 0),
      Number(body.currentVersion ?? 0),
      String(body.idKey ?? ''),
    );
  }
  return new ApiError(status, code, message, body.details);
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ServerUnavailableError(
      `Could not reach the local TNP server at ${path}. Start it with "npm run dev" or "npm start".`
      + ` (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) throw toError(response.status, parsed);
  return parsed as T;
}

export const apiClient = {
  get: <T>(path: string) => send<T>('GET', path),
  post: <T>(path: string, body?: unknown) => send<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => send<T>('PATCH', path, body),
  delete: <T>(path: string) => send<T>('DELETE', path),
  /** Uploads raw bytes; the file name travels in a header because the body is the file. */
  upload: async <T>(path: string, fileName: string, contents: Blob): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: {
          'X-TNP-File-Name': encodeURIComponent(fileName),
          'Content-Type': contents.type || 'application/octet-stream',
        },
        body: contents,
      });
    } catch (error) {
      throw new ServerUnavailableError(
        `Could not reach the local TNP server at ${path}. (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) throw toError(response.status, parsed);
    return parsed as T;
  },
};

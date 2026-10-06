/** Errors that map onto a specific HTTP status code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class RecordConflictError extends Error {
  constructor(
    readonly idKey: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `Record "${idKey}" changed on the server (expected revision ${expectedVersion}, server is at ${currentVersion}).`,
    );
    this.name = 'RecordConflictError';
  }
}

export class RecordNotFoundError extends Error {
  constructor(idKey: string) {
    super(`Record "${idKey}" was not found.`);
    this.name = 'RecordNotFoundError';
  }
}

export class ValidationFailedError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation-failed', message, details);
    this.name = 'ValidationFailedError';
  }
}

/** Path traversal, symlink escape or any access outside managed storage. */
export class StorageSecurityError extends HttpError {
  constructor(message: string) {
    super(403, 'forbidden-path', message);
    this.name = 'StorageSecurityError';
  }
}

export class ReportUnavailableError extends HttpError {
  constructor(message: string) {
    super(404, 'report-unavailable', message);
    this.name = 'ReportUnavailableError';
  }
}

export class DuplicateRecordError extends HttpError {
  constructor(existingIdKey: string, fingerprint: string) {
    super(409, 'duplicate-record', `A record with the same identity already exists (${existingIdKey}).`, {
      existingIdKey,
      fingerprint,
    });
    this.name = 'DuplicateRecordError';
  }
}

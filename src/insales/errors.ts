/**
 * API error from InSales platform.
 * Contains HTTP status and optional diagnostic headers.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly usage?: string;
  public readonly retryAfter?: string;

  constructor(status: number, usage?: string, retryAfter?: string, detail?: string) {
    super(detail ?? `InSales API error: ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.usage = usage;
    this.retryAfter = retryAfter;
  }
}

/**
 * Protocol error — malformed parameters, invalid signature, etc.
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Storage error — database unavailable, constraint violation, etc.
 */
export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageError';
    if (cause instanceof Error) this.cause = cause;
  }
}
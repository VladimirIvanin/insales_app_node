/**
 * Public failure of an InSales API call.
 * `http` is a response status, `transport` is the network or the local request,
 * `response` is a body that does not match the operation.
 */
export class InsalesError extends Error {
  readonly kind: 'http' | 'transport' | 'response';

  constructor(kind: 'http' | 'transport' | 'response', message: string) {
    super(message);
    this.name = 'InsalesError';
    this.kind = kind;
  }
}

/**
 * HTTP status that the operation does not treat as success.
 * The message does not include the response body.
 */
export class ApiError extends InsalesError {
  public readonly status: number;
  public readonly usage?: string;
  public readonly retryAfter?: string;

  constructor(status: number, usage?: string, retryAfter?: string, detail?: string) {
    super('http', detail ?? `InSales API error: ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.usage = usage;
    this.retryAfter = retryAfter;
  }
}

/** DNS, connection, timeout, or a path that never leaves the process. */
export class TransportError extends InsalesError {
  constructor(message: string) {
    super('transport', message);
    this.name = 'TransportError';
  }
}

/** JSON or a required field does not match the operation. The body is not stored. */
export class ResponseError extends InsalesError {
  constructor(message: string) {
    super('response', message);
    this.name = 'ResponseError';
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

/**
 * Typed application error + the canonical response envelope builders.
 *
 * Clients branch on `code`, never on `message`. Internal detail (stack traces,
 * driver messages, file paths, hostnames) never crosses this boundary in
 * production. See docs/SECURITY_AND_RELIABILITY.md 15.
 */
import {
  ERROR_STATUS_MAP,
  type ApiErrorCode,
  type ApiErrorDetail,
  type ApiFailure,
  type ApiSuccess,
} from '@itp/shared';

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly statusCode: number;
  public readonly details?: ApiErrorDetail[];
  /** Operational errors are expected; non-operational ones indicate a bug. */
  public readonly isOperational: boolean;
  /** Internal-only context for logs. NEVER serialised into a response. */
  public readonly internalContext?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: {
      statusCode?: number;
      details?: ApiErrorDetail[];
      cause?: unknown;
      isOperational?: boolean;
      internalContext?: Record<string, unknown>;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = options.statusCode ?? ERROR_STATUS_MAP[code];
    this.details = options.details;
    this.isOperational = options.isOperational ?? true;
    this.internalContext = options.internalContext;
    Error.captureStackTrace?.(this, ApiError);
  }

  static notFound(message = 'The requested resource was not found.'): ApiError {
    return new ApiError('NOT_FOUND', message);
  }

  static validation(message: string, details?: ApiErrorDetail[]): ApiError {
    return new ApiError('VALIDATION_ERROR', message, { details });
  }

  static internal(message = 'An unexpected error occurred.', cause?: unknown): ApiError {
    return new ApiError('INTERNAL_SERVER_ERROR', message, { cause, isOperational: false });
  }

  static dependencyUnavailable(dependency: string, cause?: unknown): ApiError {
    return new ApiError(
      'DEPENDENCY_UNAVAILABLE',
      `A required dependency is unavailable: ${dependency}.`,
      { cause, internalContext: { dependency } },
    );
  }

  static notImplemented(feature: string): ApiError {
    return new ApiError(
      'NOT_IMPLEMENTED',
      `${feature} is not implemented yet.`,
    );
  }
}

/** Build the success envelope. */
export function successEnvelope<T>(data: T, requestId: string): ApiSuccess<T> {
  return {
    success: true,
    data,
    meta: { requestId, timestamp: new Date().toISOString() },
  };
}

/**
 * Build the failure envelope.
 * `stack` is attached only when `includeStack` is true (never in production).
 */
export function failureEnvelope(
  error: ApiError,
  requestId: string,
  includeStack: boolean,
): ApiFailure {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {}),
      ...(includeStack && error.stack ? { stack: error.stack } : {}),
    },
  };
}

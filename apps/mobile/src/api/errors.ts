/**
 * Normalised API errors.
 *
 * Every failure - envelope errors, HTTP status anomalies, network failures,
 * timeouts, malformed bodies - becomes an `ApiError`. Callers branch on the
 * stable `code`, never on messages. Human-readable text is produced in the UI
 * layer; stack traces and internals are never surfaced.
 */
import type { ApiErrorCode, ApiErrorDetail } from '@itp/shared';

export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR' | 'TIMEOUT' | 'MALFORMED_RESPONSE' | 'ABORTED';

export class ApiError extends Error {
  constructor(
    public readonly code: ClientErrorCode,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string,
    public readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Safe (read) requests may be retried on these. */
  get isRetryable(): boolean {
    return (
      this.code === 'NETWORK_ERROR' ||
      this.code === 'TIMEOUT' ||
      this.code === 'DEPENDENCY_UNAVAILABLE' ||
      this.code === 'SERVICE_UNAVAILABLE' ||
      (this.status !== undefined && this.status >= 500)
    );
  }

  get isAuthError(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }

  get isOffline(): boolean {
    return this.code === 'NETWORK_ERROR' || this.code === 'TIMEOUT';
  }

  /** Field-level issue for a form field, if the server returned one. */
  fieldError(field: string): string | undefined {
    return this.details?.find((d) => d.field === field || d.field.endsWith(`.${field}`))?.issue;
  }
}

/** Map an ApiError to a short, human-readable sentence. No internals. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'NETWORK_ERROR':
        return 'Cannot reach the server. Check your connection and try again.';
      case 'TIMEOUT':
        return 'The server took too long to respond. Try again.';
      case 'UNAUTHENTICATED':
        return 'Your session has expired. Sign in again.';
      case 'FORBIDDEN':
        return 'Your account is not allowed to do that.';
      case 'NOT_FOUND':
        return 'That record no longer exists, or you no longer have access to it.';
      case 'CONFLICT':
        return error.message || 'The server rejected this change because the record changed.';
      case 'VALIDATION_ERROR':
        return error.message || 'Some information is missing or invalid.';
      case 'RATE_LIMITED':
        return 'Too many attempts. Wait a moment and try again.';
      case 'DEPENDENCY_UNAVAILABLE':
      case 'SERVICE_UNAVAILABLE':
        return 'A platform service is temporarily unavailable. Try again shortly.';
      default:
        return error.message || 'Something went wrong. Try again.';
    }
  }
  return 'Something went wrong. Try again.';
}

/**
 * 404 + centralised error handling.
 *
 * Guarantees:
 *  - every error response uses the shared failure envelope
 *  - stack traces never reach a production client
 *  - unexpected errors are logged in full but reported generically
 */
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ApiError, failureEnvelope } from '../core/api-error.js';
import { getConfig } from '../config/env.js';

/** Terminal 404 handler - mounted after all routes. */
export function notFoundHandler() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(
      new ApiError('NOT_FOUND', `Route not found: ${req.method} ${req.path}`, {
        internalContext: { method: req.method, path: req.path },
      }),
    );
  };
}

/** Normalise anything thrown into an ApiError. */
function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return new ApiError('PAYLOAD_TOO_LARGE', 'The uploaded file exceeds the size limit.', {
        cause: err,
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return new ApiError('VALIDATION_ERROR', 'Only a single file named "file" is accepted.', {
        cause: err,
      });
    }
    return new ApiError('VALIDATION_ERROR', `Upload rejected: ${err.code}.`, { cause: err });
  }

  if (err instanceof SyntaxError && 'body' in err) {
    // express.json() parse failure
    return new ApiError('VALIDATION_ERROR', 'Request body is not valid JSON.', { cause: err });
  }

  if (typeof err === 'object' && err !== null) {
    const candidate = err as { type?: string; status?: number; message?: string };

    if (candidate.type === 'entity.too.large' || candidate.status === 413) {
      return new ApiError('PAYLOAD_TOO_LARGE', 'Request body exceeds the configured size limit.', {
        cause: err,
      });
    }
    if (candidate.status === 415) {
      return new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported content type.', { cause: err });
    }
  }

  return ApiError.internal('An unexpected error occurred.', err);
}

/** Express error middleware. The 4-arg signature is required by Express. */
export function errorHandler() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const config = getConfig();
    const apiError = toApiError(err);
    const requestId = req.requestId ?? 'unknown';

    const logPayload = {
      code: apiError.code,
      status: apiError.statusCode,
      method: req.method,
      path: req.path,
      ...(apiError.internalContext ?? {}),
    };

    if (apiError.statusCode >= 500) {
      req.log?.error({ ...logPayload, err: apiError }, apiError.message);
    } else {
      req.log?.warn(logPayload, apiError.message);
    }

    // Stack traces are development-only. Production clients get code + message.
    const includeStack = !config.isProduction && apiError.statusCode >= 500;

    // A non-operational (unexpected) error must not leak its internal message.
    const safeError = apiError.isOperational
      ? apiError
      : new ApiError(apiError.code, 'An unexpected error occurred.', {
          statusCode: apiError.statusCode,
        });
    if (includeStack) safeError.stack = apiError.stack;

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(apiError.statusCode).json(failureEnvelope(safeError, requestId, includeStack));
  };
}

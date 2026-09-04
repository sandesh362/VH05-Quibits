/**
 * Request correlation: assigns/propagates X-Request-Id and attaches a
 * request-scoped logger. Every log line and every error response carries the
 * same id, which is what makes a failure traceable across Express -> FastAPI.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '@itp/shared';
import { requestLogger, type Logger } from '../core/logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
      startTime: number;
    }
  }
}

/** Only accept a client-supplied id if it is safe to echo back into a header. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId =
      incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : `req_${randomUUID()}`;

    req.requestId = requestId;
    req.startTime = Date.now();
    req.log = requestLogger(requestId);

    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  };
}

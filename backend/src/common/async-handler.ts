/**
 * Wrap an async route handler so a rejected promise reaches the error
 * middleware.
 *
 * Express 4 does not await handlers: an async function that throws produces an
 * unhandled rejection and a request that hangs until timeout. Every async
 * handler in this codebase goes through here.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

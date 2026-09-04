/**
 * Access logging.
 *
 * Logs method, path, status, duration and request id. Deliberately does NOT log
 * request bodies: later phases carry user questions and manual content, and
 * docs/SECURITY_AND_RELIABILITY.md 15 forbids logging those.
 */
import type { NextFunction, Request, Response } from 'express';

/** Health probes fire every few seconds; keep them at trace level. */
const LOW_NOISE_PATHS = new Set(['/health', '/ready', '/healthz', '/livez']);

const isLowNoise = (path: string): boolean =>
  [...LOW_NOISE_PATHS].some((p) => path.endsWith(p));

export function requestLogging() {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      const durationMs = Date.now() - req.startTime;
      const payload = {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs,
      };

      if (res.statusCode >= 500) {
        req.log.error(payload, 'request failed');
      } else if (res.statusCode >= 400) {
        req.log.warn(payload, 'request rejected');
      } else if (isLowNoise(req.path)) {
        req.log.trace(payload, 'request completed');
      } else {
        req.log.info(payload, 'request completed');
      }
    });

    next();
  };
}

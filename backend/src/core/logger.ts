/**
 * Structured logging (pino).
 *
 * Redaction is enforced at the logger level so a careless `log.info(req.body)`
 * cannot leak a credential. See docs/SECURITY_AND_RELIABILITY.md 15.
 */
import pino, { type Logger } from 'pino';
import { getConfig } from '../config/env.js';

/**
 * Paths scrubbed from every log record.
 * Never logged: passwords, tokens, cookies, auth headers, internal tokens.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-token"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.refreshToken',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'jwtSecret',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'INTERNAL_SERVICE_TOKEN',
  'MONGO_ROOT_PASSWORD',
  'apiKey',
  'QDRANT_API_KEY',
];

function createLogger(): Logger {
  const config = getConfig();

  // Pretty output for humans in dev; newline-delimited JSON everywhere else.
  const usePretty = !config.isProduction && !config.isTest;

  return pino({
    name: config.appName,
    level: config.isTest ? 'silent' : config.logLevel,
    base: {
      service: 'backend',
      version: config.version,
      env: config.nodeEnv,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss.l',
              ignore: 'pid,hostname,service,version,env',
              messageFormat: '{msg}',
            },
          },
        }
      : {}),
  });
}

let instance: Logger | null = null;

export function getLogger(): Logger {
  instance ??= createLogger();
  return instance;
}

/** Child logger bound to a request id. */
export function requestLogger(requestId: string): Logger {
  return getLogger().child({ requestId });
}

export type { Logger };

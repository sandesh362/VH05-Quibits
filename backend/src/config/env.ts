/**
 * Environment configuration + validation.
 *
 * Fails LOUDLY at boot on missing or placeholder secrets rather than silently
 * defaulting to something insecure. See docs/SECURITY_AND_RELIABILITY.md 19.
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// backend/src/config -> backend/src -> backend -> repo root
const repoRoot = path.resolve(here, '..', '..', '..');

// Prefer the root .env used by Docker Compose and the frontend. The backend
// fallback keeps `npm run dev` usable when run directly from backend/.
// Real environment variables always win - dotenv never overrides them.
const envFiles = [path.join(repoRoot, '.env'), path.join(repoRoot, 'backend', '.env')];
const envFile = envFiles.find((file) => existsSync(file));
if (envFile) {
  loadDotenv({ path: envFile });
}

/**
 * Placeholder values shipped in .env.example. If any of these survive into a
 * real boot, the operator forgot to generate secrets.
 */
const PLACEHOLDER_VALUES = new Set([
  'change_me_generate_with_openssl_rand_hex_32',
  'change_me_use_a_different_openssl_rand_hex_32',
  'changeme',
  'change_me',
  'secret',
  'your-secret-here',
]);

const isPlaceholder = (value: string): boolean =>
  PLACEHOLDER_VALUES.has(value.trim().toLowerCase());

/** A secret must be >= 32 chars and must not be a shipped placeholder. */
const secretSchema = (label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .min(32, `${label} must be at least 32 characters (generate: openssl rand -hex 32)`)
    .refine((v) => !isPlaceholder(v), {
      message: `${label} is still the .env.example placeholder. Generate a real value: openssl rand -hex 32`,
    });

const booleanish = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const portSchema = (fallback: number) =>
  z.coerce.number().int().min(1).max(65535).default(fallback);

const envSchema = z
  .object({
    // Application
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().min(1).default('industrial-troubleshooting-platform'),
    PORT: portSchema(8080),
    API_PREFIX: z
      .string()
      .default('/api/v1')
      .refine((v) => v.startsWith('/'), { message: 'API_PREFIX must start with "/"' }),

    // HTTP
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    REQUEST_BODY_LIMIT: z.string().default('1mb'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .optional(),
    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),

    // MongoDB
    MONGODB_URI: z
      .string({ required_error: 'MONGODB_URI is required' })
      .min(1)
      .refine((v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'), {
        message: 'MONGODB_URI must start with mongodb:// or mongodb+srv://',
      })
      .refine((v) => !v.includes('mongodb.net'), {
        message:
          'MongoDB Atlas (mongodb.net) is not permitted. This platform must run fully locally.',
      }),
    MONGO_DB_NAME: z.string().min(1).default('itp'),
    MONGO_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),

    // Qdrant
    QDRANT_URL: z.string().url().default('http://localhost:6333'),
    QDRANT_API_KEY: z.string().optional().default(''),

    // RAG service
    RAG_SERVICE_URL: z.string().url().default('http://localhost:8000'),
    RAG_API_PREFIX: z.string().default('/internal/v1'),
    INTERNAL_SERVICE_TOKEN: secretSchema('INTERNAL_SERVICE_TOKEN'),

    // Ollama (probed by the RAG service; Express only reports configuration)
    OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
    OLLAMA_CHAT_MODEL: z.string().optional().default(''),
    OLLAMA_EMBEDDING_MODEL: z.string().default('nomic-embed-text'),

    // Storage
    STORAGE_ROOT: z.string().default('./storage'),

    // Security placeholders (no auth logic exists in Phase 1)
    JWT_SECRET: secretSchema('JWT_SECRET'),
    JWT_EXPIRATION: z.string().default('15m'),
    JWT_REFRESH_SECRET: secretSchema('JWT_REFRESH_SECRET'),
    JWT_REFRESH_EXPIRATION: z.string().default('7d'),

    // Testing escape hatch: skip dependency probes in unit tests
    DISABLE_DEPENDENCY_CHECKS: booleanish,
  })
  .superRefine((env, ctx) => {
    if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_SECRET',
      });
    }
  });

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly appName: string;
  readonly version: string;
  readonly port: number;
  readonly apiPrefix: string;
  readonly corsOrigins: string[];
  readonly requestBodyLimit: string;
  readonly logLevel: string;
  readonly healthCheckTimeoutMs: number;
  readonly mongo: {
    readonly uri: string;
    readonly dbName: string;
    readonly connectTimeoutMs: number;
  };
  readonly qdrant: { readonly url: string; readonly apiKey: string };
  readonly ragService: {
    readonly url: string;
    readonly apiPrefix: string;
    readonly internalToken: string;
  };
  readonly ollama: {
    readonly baseUrl: string;
    readonly chatModel: string;
    readonly embeddingModel: string;
  };
  readonly storageRoot: string;
  readonly jwt: {
    readonly secret: string;
    readonly expiration: string;
    readonly refreshSecret: string;
    readonly refreshExpiration: string;
  };
  readonly disableDependencyChecks: boolean;
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Parse and validate an environment object. Exported separately from the
 * singleton so tests can validate arbitrary inputs without touching process.env.
 */
export function parseConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.join('.') || '(root)';
      return `${field}: ${issue.message}`;
    });
    throw new ConfigValidationError(issues);
  }

  const env = result.data;
  const defaultLogLevel = env.NODE_ENV === 'production' ? 'info' : 'debug';

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    appName: env.APP_NAME,
    version: '0.1.0',
    port: env.PORT,
    apiPrefix: env.API_PREFIX.replace(/\/+$/, ''),
    corsOrigins: env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    requestBodyLimit: env.REQUEST_BODY_LIMIT,
    logLevel: env.LOG_LEVEL ?? defaultLogLevel,
    healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    mongo: {
      uri: env.MONGODB_URI,
      dbName: env.MONGO_DB_NAME,
      connectTimeoutMs: env.MONGO_CONNECT_TIMEOUT_MS,
    },
    qdrant: { url: env.QDRANT_URL.replace(/\/+$/, ''), apiKey: env.QDRANT_API_KEY },
    ragService: {
      url: env.RAG_SERVICE_URL.replace(/\/+$/, ''),
      apiPrefix: env.RAG_API_PREFIX.replace(/\/+$/, ''),
      internalToken: env.INTERNAL_SERVICE_TOKEN,
    },
    ollama: {
      baseUrl: env.OLLAMA_BASE_URL.replace(/\/+$/, ''),
      chatModel: env.OLLAMA_CHAT_MODEL,
      embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
    },
    /**
     * Resolve a relative STORAGE_ROOT against the REPO ROOT, not the process
     * CWD. `npm run dev --workspace @itp/backend` runs with CWD=backend/, so a
     * bare './storage' would silently create a second backend/storage/ tree
     * that the RAG service never sees. Absolute paths (as set in Docker) are
     * used unchanged.
     */
    storageRoot: path.isAbsolute(env.STORAGE_ROOT)
      ? env.STORAGE_ROOT
      : path.resolve(repoRoot, env.STORAGE_ROOT),
    jwt: {
      secret: env.JWT_SECRET,
      expiration: env.JWT_EXPIRATION,
      refreshSecret: env.JWT_REFRESH_SECRET,
      refreshExpiration: env.JWT_REFRESH_EXPIRATION,
    },
    disableDependencyChecks: env.DISABLE_DEPENDENCY_CHECKS,
  });
}

let cached: AppConfig | null = null;

/** Validated singleton config. Throws ConfigValidationError on first bad access. */
export function getConfig(): AppConfig {
  cached ??= parseConfig();
  return cached;
}

/** Test-only: clear the memoised config. */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * Redact credentials from a URI before logging.
 * mongodb://user:pass@host:27017/db -> mongodb://***:***@host:27017/db
 */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/[^@/]+@/, '//***:***@');
}

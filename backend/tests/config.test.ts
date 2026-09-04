/**
 * Environment validation tests.
 *
 * The security promise "the app refuses to boot with a placeholder secret"
 * is only real if it is tested.
 */
import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseConfig, redactUri } from '../src/config/env.js';

/** Minimal environment that must always validate. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/itp',
    JWT_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    INTERNAL_SERVICE_TOKEN: 'c'.repeat(64),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('configuration validation', () => {
  it('accepts a valid environment', () => {
    const config = parseConfig(validEnv());
    expect(config.nodeEnv).toBe('test');
    expect(config.port).toBe(8080);
    expect(config.apiPrefix).toBe('/api/v1');
  });

  it('applies documented defaults for optional variables', () => {
    const config = parseConfig(validEnv());
    expect(config.qdrant.url).toBe('http://localhost:6333');
    expect(config.ollama.baseUrl).toBe('http://localhost:11434');
    expect(config.ollama.embeddingModel).toBe('nomic-embed-text');
    expect(config.mongo.dbName).toBe('itp');
    // Chat model is intentionally empty until an operator pulls one.
    expect(config.ollama.chatModel).toBe('');
  });

  it('rejects a missing MONGODB_URI', () => {
    expect(() => parseConfig(validEnv({ MONGODB_URI: undefined }))).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects a malformed MONGODB_URI', () => {
    expect(() => parseConfig(validEnv({ MONGODB_URI: 'postgres://localhost/db' }))).toThrow(
      /must start with mongodb/,
    );
  });

  it('rejects MongoDB Atlas (cloud services are forbidden)', () => {
    expect(() =>
      parseConfig(validEnv({ MONGODB_URI: 'mongodb+srv://u:p@cluster0.mongodb.net/db' })),
    ).toThrow(/must run fully locally/);
  });

  it('rejects the shipped placeholder JWT_SECRET', () => {
    expect(() =>
      parseConfig(validEnv({ JWT_SECRET: 'change_me_generate_with_openssl_rand_hex_32' })),
    ).toThrow(/placeholder/);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => parseConfig(validEnv({ JWT_SECRET: 'tooshort' }))).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects identical access and refresh secrets', () => {
    const same = 'd'.repeat(64);
    expect(() =>
      parseConfig(validEnv({ JWT_SECRET: same, JWT_REFRESH_SECRET: same })),
    ).toThrow(/must differ/);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => parseConfig(validEnv({ NODE_ENV: 'staging' }))).toThrow(ConfigValidationError);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => parseConfig(validEnv({ PORT: '99999' }))).toThrow(ConfigValidationError);
  });

  it('reports every problem at once rather than one at a time', () => {
    try {
      parseConfig(validEnv({ JWT_SECRET: 'short', MONGODB_URI: 'nope' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('parses a comma-separated CORS allowlist', () => {
    const config = parseConfig(
      validEnv({ CORS_ORIGIN: 'http://localhost:5173, http://localhost:3000' }),
    );
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'http://localhost:3000']);
  });

  it('strips trailing slashes from dependency URLs', () => {
    const config = parseConfig(validEnv({ QDRANT_URL: 'http://localhost:6333/' }));
    expect(config.qdrant.url).toBe('http://localhost:6333');
  });
});

describe('redactUri', () => {
  it('removes credentials from a connection string', () => {
    expect(redactUri('mongodb://user:secret@localhost:27017/itp')).toBe(
      'mongodb://***:***@localhost:27017/itp',
    );
  });

  it('leaves a credential-free URI unchanged', () => {
    expect(redactUri('mongodb://localhost:27017/itp')).toBe('mongodb://localhost:27017/itp');
  });

  it('never leaks the original password', () => {
    expect(redactUri('mongodb://admin:hunter2@host/db')).not.toContain('hunter2');
  });
});

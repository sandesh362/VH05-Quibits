import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Dependency probes hit real sockets; allow room for connection timeouts.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Config is a process-wide singleton - run files sequentially to avoid
    // cross-file interference from environment mutation.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
});

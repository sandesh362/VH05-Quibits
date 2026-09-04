import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode, command }) => {
  // Load the repo-root .env so the frontend shares one configuration file.
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');

  /**
   * The shared root .env sets NODE_ENV for the BACKEND (normally
   * `development`). Vite would otherwise honour it and emit a development
   * React build - unminified, with dev warnings, roughly twice the size - even
   * during `vite build`. Pin it for the build so the production image always
   * ships a production bundle.
   */
  if (command === 'build') {
    process.env.NODE_ENV = 'production';
  }

  const proxyTarget = env.VITE_DEV_PROXY_TARGET || 'http://localhost:8080';
  const webPort = Number(env.WEB_PORT || 5173);

  return {
    plugins: [react()],
    envDir: path.resolve(__dirname, '..'),

    server: {
      port: webPort,
      // Bind on all interfaces so the dev server works inside a container.
      host: '0.0.0.0',
      strictPort: false,
      /**
       * Vite blocks unknown Host headers by default. Local development is
       * covered by localhost, but when the dev server is reached through a
       * remote/proxied hostname (a container, a tunnel, a cloud sandbox) that
       * check rejects the request. VITE_ALLOWED_HOSTS accepts a comma-separated
       * list; set it to `true` to disable the check entirely.
       *
       * This relaxes a DEV-SERVER guard only. Production is served by nginx
       * from static files and is unaffected.
       */
      allowedHosts:
        env.VITE_ALLOWED_HOSTS === 'true'
          ? true
          : env.VITE_ALLOWED_HOSTS
            ? env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim())
            : ['localhost', '127.0.0.1', '.localhost', '.e2b.app'],
      /**
       * The browser only ever calls a RELATIVE path (/api/v1/...). The dev
       * server proxies it to Express. This keeps the app same-origin, removes
       * CORS from the picture, and means browser code never has to know the
       * backend's hostname - which matters because the browser is not
       * necessarily on the same host as the containers.
       */
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          // RAG generation can take up to RAG_REQUEST_TIMEOUT_MS (default 120s).
          timeout: 130_000,
          proxyTimeout: 130_000,
        },
      },
    },

    preview: {
      port: webPort,
      host: '0.0.0.0',
    },

    /**
     * Vite reads NODE_ENV from the shared root .env while resolving this
     * config, so a backend-oriented `NODE_ENV=development` would leak a React
     * development build into the production image. Replace the expression
     * explicitly at build time; this is what strips React's dev warnings and
     * invariant messages.
     */
    define:
      command === 'build'
        ? { 'process.env.NODE_ENV': JSON.stringify('production') }
        : {},

    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
      target: 'es2022',
    },

    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});

/**
 * Express application assembly.
 *
 * Exported separately from server.ts so tests can mount the app with supertest
 * without binding a port or starting the shutdown machinery.
 */
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { getConfig } from './config/env.js';
import { requestContext } from './middleware/request-context.js';
import { requestLogging } from './middleware/request-logging.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { systemRoutes } from './modules/system/system.routes.js';
import { authRoutes, userRoutes } from './modules/auth/auth.routes.js';
import { machineModelRoutes } from './modules/machine-models/machine-models.routes.js';
import { machineRoutes } from './modules/machines/machines.routes.js';
import { manualRoutes } from './modules/manuals/manuals.routes.js';
import { incidentRoutes } from './modules/incidents/incidents.routes.js';
import { maintenanceRoutes } from './modules/maintenance/maintenance.routes.js';
import { conversationRoutes } from './modules/conversations/conversations.routes.js';

export function createApp(): Express {
  const config = getConfig();
  const app = express();

  // Behind the nginx/Vite proxy in Docker; trust exactly one hop.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // --- Security headers -----------------------------------------------------
  // The API serves JSON only, so CSP/COEP are unnecessary here (the frontend
  // container sets its own). nosniff and frameguard still matter.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // --- Correlation + logging ------------------------------------------------
  app.use(requestContext());
  app.use(requestLogging());

  // --- CORS -----------------------------------------------------------------
  // Strict allowlist. In Docker the frontend is same-origin via the nginx
  // proxy, so CORS matters only for `npm run dev` on the host.
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin / curl / server-to-server requests have no Origin header.
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin not allowed by CORS: ${origin}`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 86_400,
    }),
  );

  // --- Body parsing ---------------------------------------------------------
  app.use(express.json({ limit: config.requestBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.requestBodyLimit }));

  // --- Routes ---------------------------------------------------------------
  const api = express.Router();

  // Unauthenticated operational endpoints.
  api.use(healthRoutes());
  api.use(systemRoutes());

  // Phase 2 domain routers. Each mounts its own authenticate()/authorize()
  // chain, so there is no app-wide auth middleware to accidentally bypass.
  api.use(authRoutes());
  api.use(userRoutes());
  api.use(machineModelRoutes());
  api.use(machineRoutes());
  api.use(manualRoutes());
  api.use(incidentRoutes());
  api.use(maintenanceRoutes());
  api.use(conversationRoutes());

  app.use(config.apiPrefix, api);

  // Unversioned liveness alias for container healthchecks, so the healthcheck
  // does not have to know API_PREFIX.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // --- Terminal handlers ----------------------------------------------------
  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}

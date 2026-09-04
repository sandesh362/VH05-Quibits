import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../common/async-handler.js';
import { authenticate, authorize } from '../../middleware/authenticate.js';
import { getConfig } from '../../config/env.js';
import * as controller from './manuals.controller.js';

/**
 * Multer is configured with MEMORY storage: the file is handed to the service
 * as a Buffer for hashing + validation, never written to disk based on the
 * client-supplied filename. The size limit is enforced by multer AND re-checked
 * in manual-files.service for defence in depth.
 */
export function manualUploadMiddleware() {
  const config = getConfig();
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.manualMaxFileSizeMb * 1024 * 1024 },
  }).single('file');
}

export function manualRoutes(): Router {
  const router = Router();
  const base = '/manuals';

  router.use(base, authenticate());

  router.get(base, authorize('manual.read'), asyncHandler(controller.list));
  router.get(`${base}/:id`, authorize('manual.read'), asyncHandler(controller.getById));
  router.post(base, authorize('manual.create'), manualUploadMiddleware(), asyncHandler(controller.create));
  router.patch(`${base}/:id`, authorize('manual.update'), asyncHandler(controller.update));
  router.delete(`${base}/:id`, authorize('manual.delete'), asyncHandler(controller.remove));
  router.post(`${base}/:id/reprocess`, authorize('manual.reprocess'), asyncHandler(controller.reprocess));
  router.get(`${base}/:id/pages`, authorize('manual.read'), asyncHandler(controller.listPages));
  router.get(`${base}/:id/chunks`, authorize('manual.read'), asyncHandler(controller.listChunks));
  router.get(`${base}/:id/processing-status`, authorize('manual.read'), asyncHandler(controller.processingStatus));

  return router;
}

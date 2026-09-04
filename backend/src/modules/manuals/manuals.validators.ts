import { z } from 'zod';
import { DOCUMENT_TYPES, MANUAL_SCOPES, PROCESSING_STATUSES } from '@itp/shared';
import { boundedText, objectIdSchema, paginationSchema } from '../../common/validation.js';

/**
 * Multipart metadata fields for a manual upload.
 *
 * NOTE: `fileSizeBytes`, `sha256`, `mimeType` and `originalFilename` are NOT
 * accepted here - the server computes them from the uploaded file so a client
 * cannot spoof a checksum or size. The file itself arrives as `multipart` and
 * is validated separately in `manual-files.service.ts`.
 */
export const createManualSchema = z
  .object({
    title: boundedText(3, 250, 'Title'),
    description: boundedText(0, 2000, 'Description').optional(),
    manufacturer: boundedText(0, 100, 'Manufacturer').optional(),
    scope: z.enum(MANUAL_SCOPES),
    machineModelId: objectIdSchema.optional(),
    machineId: objectIdSchema.optional(),
    documentType: z.enum(DOCUMENT_TYPES),
    documentNumber: boundedText(0, 100, 'Document number').optional(),
    documentVersion: boundedText(1, 50, 'Document version').optional(),
    revision: boundedText(0, 50, 'Revision').optional(),
    language: z.string().min(2).max(35).optional(),
    supersedesManualId: objectIdSchema.optional(),
  })
  .strict();

/**
 * Editable metadata only. Does NOT include processing status, checksum, size,
 * storage path, or the file - those belong to the pipeline.
 */
export const updateManualSchema = z
  .object({
    title: boundedText(3, 250, 'Title').optional(),
    description: boundedText(0, 2000, 'Description').optional(),
    manufacturer: boundedText(0, 100, 'Manufacturer').optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    documentNumber: boundedText(0, 100, 'Document number').optional(),
    documentVersion: boundedText(1, 50, 'Document version').optional(),
    revision: boundedText(0, 50, 'Revision').optional(),
    language: z.string().min(2).max(35).optional(),
    isCurrentVersion: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const listManualsSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    scope: z.enum(MANUAL_SCOPES).optional(),
    machineModelId: objectIdSchema.optional(),
    machineId: objectIdSchema.optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    // Filterable (useful for "what is still queued?") but not settable.
    processingStatus: z.enum(PROCESSING_STATUSES).optional(),
    manufacturer: z.string().max(100).optional(),
    documentVersion: z.string().max(50).optional(),
    uploadedBy: objectIdSchema.optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    language: z.string().max(35).optional(),
    isCurrentVersion: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

export const reprocessManualSchema = z
  .object({
    reason: boundedText(0, 500, 'Reason').optional(),
  })
  .strict();

export const listPagesSchema = paginationSchema.extend({
  sortBy: z.string().max(40).optional(),
});

export const listChunksSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    search: z.string().max(500).optional(),
    pageStart: z.coerce.number().int().min(1).optional(),
    pageEnd: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const listJobsSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    manualId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
    status: z.string().max(40).optional(),
    jobType: z.string().max(40).optional(),
  })
  .strict();

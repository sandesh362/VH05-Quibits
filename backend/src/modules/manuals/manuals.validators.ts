import { z } from 'zod';
import { DOCUMENT_TYPES, MANUAL_SCOPES, PROCESSING_STATUSES } from '@itp/shared';
import { boundedText, objectIdSchema, paginationSchema } from '../../common/validation.js';

/** 64 lowercase hex characters. Anything else is not a SHA-256 digest. */
const sha256Schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be a 64-character hexadecimal digest.');

/**
 * The filename is metadata for display only - it never becomes a path. Even
 * so, separators and traversal sequences are rejected so a stored value can
 * never be mistaken for a safe path by later code.
 */
const filenameSchema = boundedText(1, 255, 'Original filename').refine(
  (value) => !value.includes('/') && !value.includes('\\') && !value.includes('..'),
  { message: 'The filename must not contain path separators.' },
);

export const createManualSchema = z
  .object({
    title: boundedText(3, 250, 'Title'),
    scope: z.enum(MANUAL_SCOPES),
    machineModelId: objectIdSchema.optional(),
    machineId: objectIdSchema.optional(),
    documentType: z.enum(DOCUMENT_TYPES),
    documentVersion: boundedText(1, 50, 'Document version').optional(),
    language: z.string().min(2).max(35).optional(),
    originalFilename: filenameSchema,
    // 1 byte to 500 MB. Rejects both empty files and implausible sizes.
    fileSizeBytes: z.number().int().min(1).max(524_288_000),
    sha256: sha256Schema,
    mimeType: boundedText(3, 100, 'MIME type'),
    pageCount: z.number().int().min(1).max(50_000).optional(),
    supersedesManualId: objectIdSchema.optional(),
  })
  .strict();

/**
 * `processingStatus` and `indexedChunkCount` are ABSENT on purpose, and
 * `.strict()` turns any attempt to send them into a 400. This is the API-level
 * half of business rule 8: a manual can never be marked processed by hand.
 */
export const updateManualSchema = z
  .object({
    title: boundedText(3, 250, 'Title').optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    documentVersion: boundedText(1, 50, 'Document version').optional(),
    language: z.string().min(2).max(35).optional(),
    isCurrentVersion: z.boolean().optional(),
    pageCount: z.number().int().min(1).max(50_000).optional(),
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
    language: z.string().max(35).optional(),
    isCurrentVersion: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

import { z } from 'zod';
import { CRITICALITY_LEVELS, MACHINE_STATUSES } from '@itp/shared';
import {
  boundedText,
  objectIdSchema,
  pastOrPresentDate,
  paginationSchema,
} from '../../common/validation.js';

/**
 * Asset tags are normalised to uppercase and restricted to a safe character
 * set. Without normalisation "cnc-01" and "CNC-01" become two assets, and the
 * case-insensitive unique index would then reject the second one confusingly.
 */
const assetTagSchema = z
  .string()
  .trim()
  .min(1, 'Asset tag is required.')
  .max(50, 'Asset tag must be at most 50 characters.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/,
    'Asset tag may contain letters, numbers, dot, dash, underscore and slash only.',
  )
  .transform((value) => value.toUpperCase());

const locationSchema = z
  .object({
    site: boundedText(0, 100, 'Site').optional(),
    area: boundedText(0, 100, 'Area').optional(),
    line: boundedText(0, 100, 'Line').optional(),
    position: boundedText(0, 100, 'Position').optional(),
  })
  .strict()
  .optional();

export const createMachineSchema = z
  .object({
    assetTag: assetTagSchema,
    machineModelId: objectIdSchema,
    displayName: boundedText(1, 150, 'Display name').optional(),
    serialNumber: boundedText(1, 100, 'Serial number').optional(),
    location: locationSchema,
    status: z.enum(MACHINE_STATUSES).optional(),
    // Install/commission dates cannot be in the future.
    installedAt: pastOrPresentDate.optional(),
    commissionedAt: pastOrPresentDate.optional(),
    criticality: z.enum(CRITICALITY_LEVELS).optional(),
    notes: boundedText(0, 2000, 'Notes').optional(),
  })
  .strict();

/**
 * `assetTag` is absent by construction: it is immutable, and `.strict()` turns
 * an attempt to change it into a clear validation error rather than a silent
 * no-op.
 */
export const updateMachineSchema = createMachineSchema
  .omit({ assetTag: true })
  .partial()
  .extend({ modelChangeReason: boundedText(3, 500, 'Model change reason').optional() })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const listMachinesSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    status: z.enum(MACHINE_STATUSES).optional(),
    machineModelId: objectIdSchema.optional(),
    criticality: z.enum(CRITICALITY_LEVELS).optional(),
    site: z.string().max(100).optional(),
    search: z.string().max(120).optional(),
  })
  .strict();

import { z } from 'zod';
import { MAINTENANCE_TYPES } from '@itp/shared';
import {
  boundedText,
  dateSchema,
  objectIdSchema,
  pastOrPresentDate,
  paginationSchema,
} from '../../common/validation.js';

const partsSchema = z
  .array(
    z
      .object({
        partNumber: boundedText(1, 60, 'Part number'),
        name: boundedText(1, 150, 'Part name').optional(),
        quantity: z.number().int().min(1).max(1000).optional(),
      })
      .strict(),
  )
  .max(50, 'At most 50 replaced parts may be recorded on one record.')
  .optional();

const measurementsSchema = z
  .array(
    z
      .object({
        name: boundedText(1, 80, 'Measurement name'),
        value: z.number().finite(),
        unit: boundedText(1, 20, 'Unit').optional(),
        inSpec: z.boolean().optional(),
      })
      .strict(),
  )
  .max(50, 'At most 50 measurements may be recorded on one record.')
  .optional();

export const createMaintenanceSchema = z
  .object({
    machineId: objectIdSchema,
    maintenanceType: z.enum(MAINTENANCE_TYPES),
    title: boundedText(3, 200, 'Title'),
    description: boundedText(0, 5000, 'Description').optional(),
    // Work cannot have been performed in the future.
    performedAt: pastOrPresentDate,
    performedByExternal: boundedText(1, 150, 'External contractor').optional(),
    workOrderRef: boundedText(1, 80, 'Work order reference').optional(),
    partsReplaced: partsSchema,
    componentsServiced: z.array(boundedText(1, 100, 'Component')).max(50).optional(),
    measurements: measurementsSchema,
    durationMinutes: z.number().int().min(0).max(10_080).optional(),
    downtimeMinutes: z.number().int().min(0).max(525_600).optional(),
    // The only date allowed to be in the future: it is a schedule, not a record.
    nextDueAt: dateSchema.optional(),
    relatedIncidentId: objectIdSchema.optional(),
    notes: boundedText(0, 2000, 'Notes').optional(),
  })
  .strict();

/** machineId and relatedIncidentId are omitted: both are immutable. */
export const updateMaintenanceSchema = createMaintenanceSchema
  .omit({ machineId: true, relatedIncidentId: true })
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const listMaintenanceSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    machineId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
    maintenanceType: z.enum(MAINTENANCE_TYPES).optional(),
    performedFrom: dateSchema.optional(),
    performedTo: dateSchema.optional(),
    partNumber: z.string().max(60).optional(),
    dueBefore: dateSchema.optional(),
    search: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    (data) => !data.performedFrom || !data.performedTo || data.performedFrom <= data.performedTo,
    { path: ['performedTo'], message: 'performedTo must be on or after performedFrom.' },
  );

import { z } from 'zod';
import { INCIDENT_STATUSES, SEVERITIES } from '@itp/shared';
import {
  boundedText,
  dateSchema,
  objectIdSchema,
  pastOrPresentDate,
  paginationSchema,
} from '../../common/validation.js';

const tagsSchema = z
  .array(boundedText(1, 40, 'Tag'))
  .max(15, 'At most 15 tags are allowed.')
  .optional();

export const createIncidentSchema = z
  .object({
    machineId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
    title: boundedText(3, 200, 'Title'),
    errorCode: boundedText(1, 50, 'Error code').optional(),
    // The symptom text is the primary retrieval signal in Phase 4, so a
    // meaningful minimum is enforced rather than accepting "broken".
    symptomText: boundedText(10, 5000, 'Symptom description'),
    observedAt: pastOrPresentDate.optional(),
    severity: z.enum(SEVERITIES),
    assignedTo: objectIdSchema.optional(),
    downtimeMinutes: z.number().int().min(0).max(525_600).optional(),
    tags: tagsSchema,
  })
  .strict()
  .refine((data) => data.machineId !== undefined || data.machineModelId !== undefined, {
    path: ['machineId'],
    message: 'Provide either machineId or machineModelId.',
  });

/**
 * Resolution fields are deliberately absent from the update schema. With
 * `.strict()`, an attempt to PATCH `resolutionStatus` is a loud 400 rather
 * than a silently ignored field.
 */
export const updateIncidentSchema = z
  .object({
    title: boundedText(3, 200, 'Title').optional(),
    symptomText: boundedText(10, 5000, 'Symptom description').optional(),
    errorCode: boundedText(1, 50, 'Error code').nullable().optional(),
    severity: z.enum(SEVERITIES).optional(),
    status: z.enum(INCIDENT_STATUSES).optional(),
    assignedTo: objectIdSchema.nullable().optional(),
    downtimeMinutes: z.number().int().min(0).max(525_600).optional(),
    machineId: objectIdSchema.optional(),
    tags: tagsSchema,
    rootCauseText: boundedText(0, 5000, 'Root cause').optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

/** Both fields are mandatory: this is the whole point of the endpoint. */
export const confirmResolutionSchema = z
  .object({
    rootCauseText: boundedText(10, 5000, 'Root cause'),
    effectiveActionId: objectIdSchema,
    confirmationNote: boundedText(0, 1000, 'Confirmation note').optional(),
    verifiedByTest: z.boolean().optional(),
  })
  .strict();

export const reopenSchema = z
  .object({ reason: boundedText(5, 500, 'Reason') })
  .strict();

export const listIncidentsSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    status: z.enum(INCIDENT_STATUSES).optional(),
    resolutionStatus: z
      .enum(['unresolved', 'resolved_confirmed', 'temporarily_resolved', 'recurring'])
      .optional(),
    severity: z.enum(SEVERITIES).optional(),
    machineId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
    errorCode: z.string().max(50).optional(),
    assignedTo: objectIdSchema.optional(),
    reportedBy: objectIdSchema.optional(),
    // Query strings carry "true"/"false", so coerce explicitly.
    needsLinking: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    observedFrom: dateSchema.optional(),
    observedTo: dateSchema.optional(),
    search: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    (data) =>
      !data.observedFrom || !data.observedTo || data.observedFrom <= data.observedTo,
    { path: ['observedTo'], message: 'observedTo must be on or after observedFrom.' },
  );

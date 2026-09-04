/**
 * Incident action validators.
 */
import { z } from 'zod';
import { ACTION_RESULT_STATUSES, INCIDENT_ACTION_SOURCE_TYPES } from '@itp/shared';
import {
  boundedText,
  dateSchema,
  objectIdSchema,
  paginationSchema,
} from '../../common/validation.js';

const DESCRIPTION_MAX = 4_000;
const RESULT_MAX = 4_000;
const NOTE_MAX = 4_000;

export const listActionsSchema = paginationSchema.extend({
  actionType: z.enum(INCIDENT_ACTION_SOURCE_TYPES).optional(),
  confirmed: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  sortBy: z.string().min(1).max(40).optional(),
});

export type ListActionsQuery = z.infer<typeof listActionsSchema>;

export const createActionSchema = z
  .object({
    actionType: z.enum(INCIDENT_ACTION_SOURCE_TYPES).default('technician'),
    description: boundedText(3, DESCRIPTION_MAX, 'Description'),
    performedBy: objectIdSchema.nullable().optional(),
    sourceMessageId: objectIdSchema.nullable().optional(),
    sourceSuggestionId: z.string().min(1).max(64).nullable().optional(),
    sourceManualId: objectIdSchema.nullable().optional(),
    sourceManualVersion: boundedText(1, 100, 'Manual version').nullable().optional(),
    result: boundedText(1, RESULT_MAX, 'Result').optional(),
    resultStatus: z.enum(ACTION_RESULT_STATUSES).default('not_tested'),
    notes: boundedText(1, NOTE_MAX, 'Notes').optional(),
    performedAt: dateSchema.optional(),
  })
  .strict()
  .refine((v) => v.actionType === 'technician' || v.resultStatus === 'not_tested', {
    message: 'Only technician actions may record an observed result.',
    path: ['resultStatus'],
  });

export type CreateActionInput = z.infer<typeof createActionSchema>;

export const updateActionSchema = z
  .object({
    description: boundedText(3, DESCRIPTION_MAX, 'Description').optional(),
    result: boundedText(1, RESULT_MAX, 'Result').nullable().optional(),
    resultStatus: z.enum(ACTION_RESULT_STATUSES).optional(),
    notes: boundedText(1, NOTE_MAX, 'Notes').nullable().optional(),
    performedAt: dateSchema.optional(),
  })
  .strict();

export type UpdateActionInput = z.infer<typeof updateActionSchema>;

export const confirmActionSchema = z
  .object({
    note: boundedText(3, NOTE_MAX, 'Confirmation note'),
  })
  .strict();

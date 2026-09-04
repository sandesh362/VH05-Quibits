import { z } from 'zod';
import { ACTION_OUTCOMES, ACTION_TYPES } from '@itp/shared';
import { boundedText, pastOrPresentDate, paginationSchema } from '../../common/validation.js';

const partsSchema = z
  .array(
    z
      .object({
        partNumber: boundedText(1, 60, 'Part number'),
        name: boundedText(1, 150, 'Part name').optional(),
        quantity: z.number().int().min(1).max(1000).optional(),
        serial: boundedText(1, 100, 'Serial').optional(),
      })
      .strict(),
  )
  .max(30, 'At most 30 replaced parts may be recorded on one action.')
  .optional();

export const createActionSchema = z
  .object({
    actionText: boundedText(5, 5000, 'Action description'),
    actionType: z.enum(ACTION_TYPES).optional(),
    partsReplaced: partsSchema,
    toolsUsed: z.array(boundedText(1, 80, 'Tool')).max(20).optional(),
    /**
     * Required, with no default. An action whose outcome is unknown should say
     * `unknown` explicitly - defaulting it would quietly fill the dataset with
     * outcomes nobody actually recorded.
     */
    outcome: z.enum(ACTION_OUTCOMES),
    outcomeNote: boundedText(0, 2000, 'Outcome note').optional(),
    durationMinutes: z.number().int().min(0).max(10_080).optional(),
    performedAt: pastOrPresentDate.optional(),
    followedAiSuggestion: z.boolean().optional(),
    deviationReason: boundedText(0, 1000, 'Deviation reason').optional(),
  })
  .strict();

export const updateActionSchema = z
  .object({
    actionText: boundedText(5, 5000, 'Action description').optional(),
    outcome: z.enum(ACTION_OUTCOMES).optional(),
    outcomeNote: boundedText(0, 2000, 'Outcome note').optional(),
    actionType: z.enum(ACTION_TYPES).optional(),
    durationMinutes: z.number().int().min(0).max(10_080).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

/**
 * Overrides the shared `desc` default with `asc`.
 *
 * An action log is a narrative: "checked pressure, inspected pump, replaced
 * seal" only makes sense read forwards. Every other list is newest-first,
 * which is why the shared default stays `desc`.
 */
export const listActionsSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();

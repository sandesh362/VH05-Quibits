import { z } from 'zod';
import { CONVERSATION_STATUSES } from '@itp/shared';
import { boundedText, objectIdSchema, paginationSchema } from '../../common/validation.js';

export const createConversationSchema = z
  .object({
    title: boundedText(1, 200, 'Title').optional(),
    machineId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
  })
  .strict()
  .refine((data) => !(data.machineId && data.machineModelId), {
    path: ['machineModelId'],
    // A machine already implies its model; accepting both invites a
    // contradictory pair that would confuse retrieval scoping in Phase 4.
    message: 'Provide either machineId or machineModelId, not both.',
  });

export const updateConversationSchema = z
  .object({
    title: boundedText(1, 200, 'Title').optional(),
    status: z.enum(CONVERSATION_STATUSES).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const listConversationsSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    status: z.enum(CONVERSATION_STATUSES).optional(),
    machineId: objectIdSchema.optional(),
  })
  .strict();

export const listMessagesSchema = paginationSchema.strict();

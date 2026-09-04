import { z } from 'zod';
import { boundedText, objectIdSchema } from '../../common/validation.js';

export const ragQuerySchema = z
  .object({
    query: boundedText(1, 2000, 'Query'),
    machineId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
    manualId: objectIdSchema.optional(),
    manualVersion: z.string().trim().min(1).max(64).optional(),
    manualType: z.string().trim().min(1).max(64).optional(),
    manufacturer: z.string().trim().min(1).max(120).optional(),
    conversationId: objectIdSchema.optional(),
    includeInactive: z.boolean().optional(),
  })
  .strict();

export type RagQueryInput = z.infer<typeof ragQuerySchema>;

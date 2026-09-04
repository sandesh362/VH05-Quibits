import { z } from 'zod';
import { MACHINE_TYPES } from '@itp/shared';
import { boundedText, paginationSchema } from '../../common/validation.js';

/**
 * Aliases are capped at 20 entries. Unbounded arrays are a cheap denial-of-
 * service: 100k aliases in one document would bloat the index and every list
 * response that returns it.
 */
const aliasesSchema = z
  .array(boundedText(1, 80, 'Alias'))
  .max(20, 'At most 20 aliases are allowed.')
  .optional();

/**
 * Free-form spec bag, deliberately shallow-validated: manufacturers publish
 * wildly different attributes and a rigid schema would reject real data.
 * Key count and value size are bounded instead, and assertNoOperators has
 * already rejected `$`/dotted keys at the controller.
 */
const specificationsSchema = z
  .record(z.string().max(60), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 50, {
    message: 'At most 50 specification entries are allowed.',
  })
  .optional();

export const createMachineModelSchema = z
  .object({
    manufacturer: boundedText(1, 100, 'Manufacturer'),
    modelName: boundedText(1, 100, 'Model name'),
    machineType: z.enum(MACHINE_TYPES),
    aliases: aliasesSchema,
    // Range keeps typos ("19999") out without guessing at industrial history.
    modelYear: z.number().int().min(1900).max(2100).optional(),
    specifications: specificationsSchema,
    defaultLanguage: z.string().min(2).max(35).optional(),
    notes: boundedText(0, 2000, 'Notes').optional(),
  })
  .strict();

export const updateMachineModelSchema = createMachineModelSchema
  .partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const listMachineModelsSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    manufacturer: z.string().max(100).optional(),
    machineType: z.enum(MACHINE_TYPES).optional(),
    search: z.string().max(120).optional(),
  })
  .strict();

/** Deletes require a reason: the audit trail is useless without the "why". */
export const deleteSchema = z
  .object({ reason: boundedText(3, 500, 'Reason').optional() })
  .strict();

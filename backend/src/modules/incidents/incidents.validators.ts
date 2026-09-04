/**
 * Incident validators.
 *
 * Every id, enum, date and string length is checked server-side. Nothing
 * reaches a Mongo query unless it passed one of these schemas. Organization
 * identity is never accepted here - it is resolved from the authenticated
 * user in the service layer.
 */
import { z } from 'zod';
import {
  INCIDENT_SOURCES,
  INCIDENT_STATUSES,
  ISSUE_STATUSES,
  PRIORITIES,
  ROOT_CAUSE_STATUSES,
  SEVERITIES,
} from '@itp/shared';
import {
  boundedText,
  dateSchema,
  objectIdSchema,
  paginationSchema,
} from '../../common/validation.js';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
const SYMPTOM_MAX = 500;
const CONDITION_MAX = 500;
const ERROR_CODE_MAX = 64;
const TAG_MAX = 40;
const MAX_TAGS = 20;
const MAX_SYMPTOMS = 50;
const MAX_ERROR_CODES = 50;
const MAX_CONDITIONS = 50;
const NOTE_MAX = 4_000;
const RESULT_MAX = 4_000;

export const stringList = (max: number, maxItems: number, label: string) =>
  z
    .array(z.string().trim().min(1).max(max, `${label} entries must be at most ${max} characters.`))
    .max(maxItems, `At most ${maxItems} ${label.toLowerCase()} entries are allowed.`)
    .default([]);

export const errorCodeList = stringList(ERROR_CODE_MAX, MAX_ERROR_CODES, 'Error codes');
export const symptomList = stringList(SYMPTOM_MAX, MAX_SYMPTOMS, 'Symptoms');
export const conditionList = stringList(CONDITION_MAX, MAX_CONDITIONS, 'Operating conditions');
export const tagList = z
  .array(
    z.string().trim().min(1).max(TAG_MAX).transform((t) => t.toLowerCase()),
  )
  .max(MAX_TAGS)
  .default([]);

export const attachmentMetaSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'Attachment id must be URL-safe.'),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(127).regex(/^[\w.+-]+\/[\w.+-]+$/, 'Invalid MIME type.'),
    sizeBytes: z.number().int().min(0).max(50 * 1024 * 1024),
  })
  .strict();

export const createIncidentSchema = z
  .object({
    title: boundedText(3, TITLE_MAX, 'Title'),
    description: boundedText(3, DESCRIPTION_MAX, 'Description'),
    source: z.enum(INCIDENT_SOURCES).default('other'),
    machineId: objectIdSchema,
    machineModelId: objectIdSchema.optional(),
    conversationId: objectIdSchema.optional(),
    manualId: objectIdSchema.optional(),
    manualVersion: boundedText(1, 100, 'Manual version').optional(),
    assignedTo: objectIdSchema.nullable().optional(),
    severity: z.enum(SEVERITIES).default('medium'),
    priority: z.enum(PRIORITIES).default('medium'),
    issueStatus: z.enum(ISSUE_STATUSES).default('unknown'),
    symptoms: symptomList,
    errorCodes: errorCodeList,
    operatingConditions: conditionList,
    firstObservedAt: dateSchema.optional(),
    lastObservedAt: dateSchema.nullable().optional(),
    tags: tagList,
    attachments: z.array(attachmentMetaSchema).max(10).default([]),
  })
  .strict();

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const updateIncidentSchema = z
  .object({
    title: boundedText(3, TITLE_MAX, 'Title').optional(),
    description: boundedText(3, DESCRIPTION_MAX, 'Description').optional(),
    machineId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
    conversationId: objectIdSchema.nullable().optional(),
    manualId: objectIdSchema.nullable().optional(),
    manualVersion: boundedText(1, 100, 'Manual version').nullable().optional(),
    assignedTo: objectIdSchema.nullable().optional(),
    severity: z.enum(SEVERITIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    symptoms: symptomList.optional(),
    errorCodes: errorCodeList.optional(),
    operatingConditions: conditionList.optional(),
    firstObservedAt: dateSchema.optional(),
    lastObservedAt: dateSchema.nullable().optional(),
    tags: tagList.optional(),
    attachments: z.array(attachmentMetaSchema).max(10).optional(),
  })
  .strict();

export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;

export const statusChangeSchema = z
  .object({
    status: z.enum(INCIDENT_STATUSES),
    reason: boundedText(3, NOTE_MAX, 'Reason').optional(),
  })
  .strict();

export const issueStatusChangeSchema = z
  .object({
    issueStatus: z.enum(ISSUE_STATUSES),
    note: boundedText(1, NOTE_MAX, 'Note').optional(),
  })
  .strict();

export const rootCauseUpdateSchema = z
  .object({
    text: boundedText(3, NOTE_MAX, 'Root cause').optional(),
    status: z.enum(ROOT_CAUSE_STATUSES).optional(),
    note: boundedText(1, NOTE_MAX, 'Note').optional(),
  })
  .strict()
  .refine((v) => v.text !== undefined || v.status !== undefined, {
    message: 'Provide at least `text` or `status`.',
  });

export const rootCauseConfirmSchema = z
  .object({
    note: boundedText(3, NOTE_MAX, 'Confirmation note'),
    text: boundedText(3, NOTE_MAX, 'Root cause').optional(),
  })
  .strict();

export const rootCauseRejectSchema = z
  .object({
    reason: boundedText(3, NOTE_MAX, 'Rejection reason'),
  })
  .strict();

export const fixRecordSchema = z
  .object({
    description: boundedText(3, NOTE_MAX, 'Fix description'),
    result: boundedText(1, RESULT_MAX, 'Result').optional(),
    notes: boundedText(1, NOTE_MAX, 'Notes').optional(),
  })
  .strict();

export const fixConfirmSchema = z
  .object({
    note: boundedText(3, NOTE_MAX, 'Confirmation note'),
    result: boundedText(1, RESULT_MAX, 'Result').optional(),
  })
  .strict();

export const closeIncidentSchema = z
  .object({
    resolutionSummary: boundedText(3, RESULT_MAX, 'Resolution summary'),
  })
  .strict();

export const reopenIncidentSchema = z
  .object({
    reason: boundedText(3, NOTE_MAX, 'Reopening reason'),
  })
  .strict();

export const deleteIncidentSchema = z
  .object({
    reason: boundedText(3, NOTE_MAX, 'Deletion reason'),
  })
  .strict();

export const listIncidentsSchema = paginationSchema.extend({
  machineId: objectIdSchema.optional(),
  machineModelId: objectIdSchema.optional(),
  status: z.enum(INCIDENT_STATUSES).optional(),
  issueStatus: z.enum(ISSUE_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  rootCauseStatus: z.enum(ROOT_CAUSE_STATUSES).optional(),
  errorCode: z.string().trim().min(1).max(ERROR_CODE_MAX).optional(),
  tag: z.string().trim().min(1).max(TAG_MAX).optional(),
  reportedBy: objectIdSchema.optional(),
  assignedTo: objectIdSchema.optional(),
  source: z.enum(INCIDENT_SOURCES).optional(),
  createdFrom: dateSchema.optional(),
  createdTo: dateSchema.optional(),
  resolvedFrom: dateSchema.optional(),
  resolvedTo: dateSchema.optional(),
  search: z.string().trim().min(2).max(200).optional(),
  sortBy: z.string().min(1).max(40).optional(),
});

export type ListIncidentsQuery = z.infer<typeof listIncidentsSchema>;

export const incidentIdSchema = objectIdSchema;

import { z } from 'zod';
import {
  CONFIRMED_ISSUE_STATUSES,
  CONVERSATION_STATUSES,
  ISSUE_STATUSES,
  SUGGESTED_ACTION_STATUSES,
  TECHNICIAN_ACTION_STATUSES,
} from '@itp/shared';
import { boundedText, objectIdSchema, paginationSchema, pastOrPresentDate } from '../../common/validation.js';
import { getConfig } from '../../config/env.js';

function limits() {
  const conv = getConfig().conversation;
  return {
    title: conv.maxTitleLength,
    message: conv.maxMessageLength,
    summary: conv.maxIssueSummaryLength,
  };
}

export const createConversationSchema = z
  .object({
    title: boundedText(1, 200, 'Title').optional(),
    machineId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
    manualId: objectIdSchema.optional(),
    manualVersion: z.string().trim().min(1).max(64).optional(),
    issueSummary: boundedText(1, 2000, 'Issue summary').optional(),
    errorCodes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    symptoms: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
    operatingConditions: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const { title, summary } = limits();
    if (data.title && data.title.length > title) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: `Title must be at most ${title} characters.` });
    }
    if (data.issueSummary && data.issueSummary.length > summary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issueSummary'],
        message: `Issue summary must be at most ${summary} characters.`,
      });
    }
  });

export const updateConversationSchema = z
  .object({
    title: boundedText(1, 200, 'Title').optional(),
    issueSummary: boundedText(1, 2000, 'Issue summary').optional(),
    errorCodes: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    symptoms: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
    operatingConditions: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });

export const listConversationsSchema = paginationSchema
  .extend({
    sortBy: z.string().max(40).optional(),
    status: z.enum(CONVERSATION_STATUSES).optional(),
    issueStatus: z.enum(ISSUE_STATUSES).optional(),
    machineId: objectIdSchema.optional(),
    machineModelId: objectIdSchema.optional(),
    createdBy: objectIdSchema.optional(),
    createdFrom: z.coerce.date().optional(),
    createdTo: z.coerce.date().optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const listMessagesSchema = paginationSchema.strict();

export const postMessageSchema = z
  .object({
    content: boundedText(1, 5000, 'Message'),
    clientRequestId: z.string().trim().min(8).max(80).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const max = limits().message;
    if (data.content.length > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: `Message must be at most ${max} characters.`,
      });
    }
  });

export const closeConversationSchema = z
  .object({
    confirmationNote: boundedText(1, 2000, 'Confirmation note').optional(),
  })
  .strict();

export const reopenConversationSchema = z
  .object({
    note: boundedText(1, 2000, 'Note').optional(),
  })
  .strict();

export const archiveConversationSchema = z
  .object({
    note: boundedText(1, 2000, 'Note').optional(),
  })
  .strict();

export const issueStatusSchema = z
  .object({
    issueStatus: z.enum(ISSUE_STATUSES),
    confirmationNote: boundedText(1, 2000, 'Confirmation note').optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if ((CONFIRMED_ISSUE_STATUSES as readonly string[]).includes(data.issueStatus) && !data.confirmationNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmationNote'],
        message: 'A confirmation note is required when marking this issue status.',
      });
    }
  });

export const technicianActionSchema = z
  .object({
    action: boundedText(1, 2000, 'Action'),
    result: boundedText(1, 2000, 'Result').optional(),
    status: z.enum(TECHNICIAN_ACTION_STATUSES),
    performedAt: pastOrPresentDate.optional(),
    notes: boundedText(1, 2000, 'Notes').optional(),
    sourceMessageId: objectIdSchema.optional(),
    suggestionId: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const suggestionStatusSchema = z
  .object({
    status: z.enum(SUGGESTED_ACTION_STATUSES),
  })
  .strict();

export const listActionsSchema = paginationSchema.strict();

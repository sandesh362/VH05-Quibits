/**
 * Zod form schemas - client-side usability mirror of the backend validators
 * (backend/src/modules/...validators.ts). The backend remains the final
 * authority; these exist so the technician gets instant, field-level feedback.
 */
import { z } from 'zod';
import {
  ACTION_RESULT_STATUSES,
  INCIDENT_ACTION_SOURCE_TYPES,
  ISSUE_STATUSES,
  PRIORITIES,
  SEVERITIES,
} from '@itp/shared';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
const NOTE_MAX = 4_000;
const RESULT_MAX = 4_000;

export const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email or username is required.').email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const createIncidentSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters.').max(TITLE_MAX, `Title must be at most ${TITLE_MAX} characters.`),
  description: z
    .string()
    .trim()
    .min(3, 'Describe what happened (at least 3 characters).')
    .max(DESCRIPTION_MAX),
  machineId: z.string().min(1, 'Select the machine.'),
  severity: z.enum(SEVERITIES),
  priority: z.enum(PRIORITIES),
  symptoms: z.array(z.string().trim().min(1).max(500)).max(50, 'At most 50 symptoms.'),
  errorCodes: z.array(z.string().trim().min(1).max(64)).max(50, 'At most 50 error codes.'),
  operatingConditions: z.array(z.string().trim().min(1).max(500)).max(50),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  firstObservedAt: z.string().optional(),
  conversationId: z.string().optional(),
  manualId: z.string().optional(),
  manualVersion: z.string().optional(),
});
export type CreateIncidentValues = z.infer<typeof createIncidentSchema>;

export const updateIncidentFormSchema = createIncidentSchema.omit({ machineId: true, conversationId: true, manualId: true, manualVersion: true });
export type UpdateIncidentValues = z.infer<typeof updateIncidentFormSchema>;

export const recordActionSchema = z
  .object({
    actionType: z.enum(INCIDENT_ACTION_SOURCE_TYPES),
    description: z
      .string()
      .trim()
      .min(3, 'Describe the action (at least 3 characters).')
      .max(NOTE_MAX),
    result: z.string().trim().max(RESULT_MAX).optional(),
    resultStatus: z.enum(ACTION_RESULT_STATUSES),
    performedAt: z.string().optional(),
    notes: z.string().trim().max(NOTE_MAX).optional(),
  })
  .refine((values) => values.actionType === 'technician' || values.resultStatus === 'not_tested', {
    message: 'Only technician actions may record an observed result.',
    path: ['resultStatus'],
  });
export type RecordActionValues = z.infer<typeof recordActionSchema>;

export const confirmNoteSchema = z.object({
  note: z.string().trim().min(3, 'A short note is required (at least 3 characters).').max(NOTE_MAX),
});
export type ConfirmNoteValues = z.infer<typeof confirmNoteSchema>;

export const rejectReasonSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required (at least 3 characters).').max(NOTE_MAX),
});

export const rootCauseUpdateSchema = z.object({
  text: z.string().trim().min(3, 'Describe the suspected root cause (at least 3 characters).').max(NOTE_MAX),
});

export const fixRecordSchema = z.object({
  description: z.string().trim().min(3, 'Describe the fix (at least 3 characters).').max(NOTE_MAX),
  result: z.string().trim().max(RESULT_MAX).optional(),
  notes: z.string().trim().max(NOTE_MAX).optional(),
});

export const closeSchema = z.object({
  resolutionSummary: z.string().trim().min(3, 'Summarize the resolution (at least 3 characters).').max(RESULT_MAX),
});

export const reopenSchema = z.object({
  reason: z.string().trim().min(3, 'Explain why this incident is being reopened (at least 3 characters).').max(NOTE_MAX),
});

export const statusChangeSchema = z.object({
  status: z.enum(['open', 'investigating', 'waiting_for_information', 'waiting_for_parts', 'resolved', 'closed', 'reopened', 'cancelled']).optional(),
  issueStatus: z.enum(ISSUE_STATUSES).optional(),
  note: z.string().trim().max(NOTE_MAX).optional(),
});

export const messageSchema = z.object({
  content: z.string().trim().min(1, 'Type a question.').max(5000, 'Message must be at most 5000 characters.'),
});
export type MessageValues = z.infer<typeof messageSchema>;

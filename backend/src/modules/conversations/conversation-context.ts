/**
 * Conversation-aware context assembly for RAG.
 *
 * Technician-confirmed facts (actions, explicit context fields) are treated as
 * factual. Assistant statements are history only — never promoted into facts.
 * History is bounded by message count and character budget.
 */
import type { ConversationDoc, MessageDoc } from '../../database/collections.js';
import { getConfig } from '../../config/env.js';
import type { MessageStatus, MessageType, RagStatus } from '@itp/shared';

export interface HistoryTurn {
  role: 'user' | 'assistant' | 'system';
  messageType: string;
  content: string;
  confirmed: boolean;
}

export interface AssembledContext {
  machineId: string | null;
  machineModelId: string | null;
  manualId: string | null;
  manualVersion: string | null;
  issueSummary: string | null;
  errorCodes: string[];
  symptoms: string[];
  operatingConditions: string[];
  attemptedActions: string[];
  confirmedFindings: string[];
  recentMessages: HistoryTurn[];
  truncated: boolean;
}

export function hex(id: { toHexString(): string } | null | undefined): string | null {
  return id ? id.toHexString() : null;
}

export function assembleContext(
  conversation: ConversationDoc,
  messages: MessageDoc[],
  options?: { historyLimit?: number; characterLimit?: number },
): AssembledContext {
  const config = getConfig();
  const historyLimit = options?.historyLimit ?? config.conversation.historyMessageLimit;
  const characterLimit = options?.characterLimit ?? config.conversation.contextCharacterLimit;

  const relevant = messages.filter((m) =>
    ['question', 'answer', 'clarification', 'refusal', 'technician_note', 'action_record'].includes(
      m.message_type,
    ),
  );
  const recent = relevant.slice(-historyLimit);

  const turns: HistoryTurn[] = [];
  let used = 0;
  let truncated = relevant.length > recent.length;

  for (const message of recent) {
    const content = (message.content_text ?? '').trim();
    if (!content) continue;
    const confirmed = message.message_type === 'action_record' || message.message_type === 'technician_note';
    const piece = `${message.role}: ${content}`;
    if (used + piece.length > characterLimit) {
      truncated = true;
      break;
    }
    turns.push({
      role: message.role,
      messageType: message.message_type,
      content,
      confirmed,
    });
    used += piece.length;
  }

  return {
    machineId: hex(conversation.machine_id),
    machineModelId: hex(conversation.machine_model_id),
    manualId: hex(conversation.manual_id),
    manualVersion: conversation.manual_version ?? null,
    issueSummary: conversation.issue_summary ?? null,
    errorCodes: conversation.error_codes ?? [],
    symptoms: conversation.symptoms ?? [],
    operatingConditions: conversation.operating_conditions ?? [],
    attemptedActions: conversation.attempted_actions ?? [],
    confirmedFindings: conversation.confirmed_findings ?? [],
    recentMessages: turns,
    truncated,
  };
}

export function contextToInternalPayload(ctx: AssembledContext): Record<string, unknown> {
  return {
    issue_summary: ctx.issueSummary,
    error_codes: ctx.errorCodes,
    symptoms: ctx.symptoms,
    operating_conditions: ctx.operatingConditions,
    attempted_actions: ctx.attemptedActions,
    confirmed_findings: ctx.confirmedFindings,
    recent_messages: ctx.recentMessages.map((turn) => ({
      role: turn.role,
      message_type: turn.messageType,
      content: turn.content,
      confirmed: turn.confirmed,
    })),
  };
}

const PRONOUN_RE =
  /\b(it|that|this|those|them|the (component|alarm|error|issue|problem|part|valve|pump|filter))\b/i;

export interface AmbiguityResult {
  ambiguous: boolean;
  message: string | null;
}

/**
 * Follow-ups like "that did not solve it" are fine when there is a single
 * recent referent. They are ambiguous when the last assistant turn listed
 * several distinct suggested actions or sources.
 */
export function detectAmbiguousFollowUp(
  query: string,
  lastAssistant: MessageDoc | null,
): AmbiguityResult {
  const trimmed = query.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) {
    return { ambiguous: true, message: 'Please enter a question.' };
  }

  const suggestions = lastAssistant?.suggested_actions ?? [];
  const hasPronoun = PRONOUN_RE.test(trimmed);
  if (hasPronoun && suggestions.length >= 2 && wordCount <= 14) {
    const options = suggestions.map((s) => s.description).slice(0, 5);
    return {
      ambiguous: true,
      message: `Which suggested check are you referring to? ${options.join(' / ')}`,
    };
  }

  return { ambiguous: false, message: null };
}

export function ragStatusToMessageType(status: RagStatus | string | undefined): MessageType {
  switch (status) {
    case 'answered':
      return 'answer';
    case 'clarification_required':
      return 'clarification';
    case 'insufficient_evidence':
    case 'conflicting_evidence':
      return 'refusal';
    case 'processing_unavailable':
    case 'generation_failed':
      return 'system_notice';
    default:
      return 'answer';
  }
}

export function messageStatusForRag(status: RagStatus | string | undefined): MessageStatus {
  if (status === 'generation_failed' || status === 'processing_unavailable') return 'failed';
  return 'completed';
}

export function fingerprintContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function citationLabel(source: {
  manual_title?: string;
  manualTitle?: string;
  manual_version?: string | null;
  manualVersion?: string | null;
  page_start?: number;
  pageStart?: number;
  page_end?: number;
  pageEnd?: number;
}): string {
  const title = source.manual_title ?? source.manualTitle ?? 'Manual';
  const version = source.manual_version ?? source.manualVersion;
  const start = source.page_start ?? source.pageStart;
  const end = source.page_end ?? source.pageEnd;
  const versionBit = version ? `, version ${version}` : '';
  if (start == null) return `${title}${versionBit}`;
  if (end == null || end === start) return `${title}${versionBit}, page ${start}`;
  return `${title}${versionBit}, pages ${start}–${end}`;
}

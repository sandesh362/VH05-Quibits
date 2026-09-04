import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { ConversationDoc, MessageDoc } from '../src/database/collections.js';
import {
  assembleContext,
  citationLabel,
  detectAmbiguousFollowUp,
  fingerprintContent,
  messageStatusForRag,
  ragStatusToMessageType,
} from '../src/modules/conversations/conversation-context.js';

function conversation(overrides: Partial<ConversationDoc> = {}): ConversationDoc {
  const now = new Date();
  return {
    _id: new ObjectId(),
    user_id: new ObjectId(),
    created_by: new ObjectId(),
    title: 'Hydraulic startup alarm',
    machine_id: new ObjectId(),
    machine_model_id: new ObjectId(),
    manual_id: new ObjectId(),
    manual_version: '2.1',
    status: 'active',
    issue_status: 'investigating',
    issue_summary: 'Hydraulic pressure drops during startup',
    error_codes: ['E-104'],
    symptoms: ['Pressure drops after startup'],
    operating_conditions: [],
    attempted_actions: ['Checked hydraulic fluid level'],
    confirmed_findings: ['Fluid level was normal'],
    turn_count: 2,
    message_count: 2,
    last_message_at: now,
    started_at: now,
    issue_status_history: [],
    incident_ids: [],
    is_deleted: false,
    created_at: now,
    updated_at: now,
    schema_version: 1,
    ...overrides,
  } as ConversationDoc;
}

function message(
  conversationId: ObjectId,
  sequence: number,
  role: 'user' | 'assistant',
  content: string,
  extras: Partial<MessageDoc> = {},
): MessageDoc {
  const now = new Date();
  return {
    _id: new ObjectId(),
    conversation_id: conversationId,
    role,
    message_type: role === 'user' ? 'question' : 'answer',
    sequence,
    content_text: content,
    status: 'completed',
    sources: [],
    suggested_actions: [],
    created_at: now,
    updated_at: now,
    schema_version: 1,
    ...extras,
  } as MessageDoc;
}

describe('assembleContext', () => {
  it('treats technician actions as confirmed and assistant text as history', () => {
    const conv = conversation();
    const messages = [
      message(conv._id, 1, 'user', 'Why is E-104 appearing?'),
      message(conv._id, 2, 'assistant', 'Check the suction strainer.', {
        suggested_actions: [
          { id: 'suggestion-1', description: 'Check the suction strainer.', source_ids: ['source-1'], status: 'suggested' },
          { id: 'suggestion-2', description: 'Measure pressure at port P1.', source_ids: ['source-1'], status: 'suggested' },
        ],
      }),
      message(conv._id, 3, 'user', 'I already checked the fluid level.', { message_type: 'technician_note' }),
    ];
    const ctx = assembleContext(conv, messages, { historyLimit: 10, characterLimit: 6000 });
    expect(ctx.issueSummary).toBe('Hydraulic pressure drops during startup');
    expect(ctx.errorCodes).toEqual(['E-104']);
    expect(ctx.attemptedActions).toContain('Checked hydraulic fluid level');
    expect(ctx.confirmedFindings).toContain('Fluid level was normal');
    expect(ctx.recentMessages.some((t) => t.confirmed)).toBe(true);
    expect(ctx.recentMessages.find((t) => t.role === 'assistant')?.confirmed).toBe(false);
  });

  it('truncates history by message count and character budget', () => {
    const conv = conversation();
    const messages = Array.from({ length: 20 }, (_, i) =>
      message(conv._id, i + 1, i % 2 === 0 ? 'user' : 'assistant', `Turn ${i + 1} ${'x'.repeat(200)}`),
    );
    const ctx = assembleContext(conv, messages, { historyLimit: 4, characterLimit: 6000 });
    expect(ctx.recentMessages.length).toBeLessThanOrEqual(4);
    expect(ctx.truncated).toBe(true);

    const tight = assembleContext(conv, messages.slice(-6), { historyLimit: 10, characterLimit: 250 });
    expect(tight.recentMessages.length).toBeLessThan(6);
    expect(tight.truncated).toBe(true);
  });
});

describe('detectAmbiguousFollowUp', () => {
  it('asks for clarification when “it” could mean several suggested checks', () => {
    const last = message(new ObjectId(), 2, 'assistant', 'Two checks.', {
      suggested_actions: [
        { id: 'suggestion-1', description: 'Check the suction strainer.', source_ids: ['source-1'], status: 'suggested' },
        { id: 'suggestion-2', description: 'Inspect the relief valve.', source_ids: ['source-1'], status: 'suggested' },
      ],
    });
    const result = detectAmbiguousFollowUp('That did not solve it.', last);
    expect(result.ambiguous).toBe(true);
    expect(result.message).toMatch(/which/i);
  });

  it('does not flag a specific follow-up as ambiguous', () => {
    const last = message(new ObjectId(), 2, 'assistant', 'Two checks.', {
      suggested_actions: [
        { id: 'suggestion-1', description: 'Check the suction strainer.', source_ids: ['source-1'], status: 'suggested' },
        { id: 'suggestion-2', description: 'Inspect the relief valve.', source_ids: ['source-1'], status: 'suggested' },
      ],
    });
    const result = detectAmbiguousFollowUp('Where is the suction strainer located?', last);
    expect(result.ambiguous).toBe(false);
  });
});

describe('RAG status mapping', () => {
  it('maps statuses to message types without treating refusals as answers', () => {
    expect(ragStatusToMessageType('answered')).toBe('answer');
    expect(ragStatusToMessageType('clarification_required')).toBe('clarification');
    expect(ragStatusToMessageType('insufficient_evidence')).toBe('refusal');
    expect(ragStatusToMessageType('conflicting_evidence')).toBe('refusal');
    expect(ragStatusToMessageType('generation_failed')).toBe('system_notice');
    expect(messageStatusForRag('generation_failed')).toBe('failed');
    expect(messageStatusForRag('answered')).toBe('completed');
  });
});

describe('citationLabel', () => {
  it('formats title, version and page range without filesystem paths', () => {
    expect(
      citationLabel({
        manualTitle: 'Hydraulic Service Manual',
        manualVersion: '2.1',
        pageStart: 42,
        pageEnd: 43,
      }),
    ).toBe('Hydraulic Service Manual, version 2.1, pages 42–43');
  });
});

describe('fingerprintContent', () => {
  it('normalises whitespace so duplicate detection is stable', () => {
    expect(fingerprintContent('  Why is   E-104 appearing? ')).toBe('why is e-104 appearing?');
  });
});

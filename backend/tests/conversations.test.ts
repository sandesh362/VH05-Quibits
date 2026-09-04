/**
 * Phase 5 conversation workflow tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import {
  PREFIX,
  auth,
  createAllRoles,
  createUser,
  resetDb,
  seedMachine,
  setupTestApp,
  teardownTestApp,
  type TestUser,
} from './helpers/app.js';
import type { UserRole } from '@itp/shared';
import { collections, SCHEMA_VERSION } from '../src/database/collections.js';
import * as ragClient from '../src/modules/manuals/rag-client.service.js';

let app: Express;
let db: Db;
let users: Record<UserRole, TestUser>;
let answerRagMock: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  ({ app, db } = await setupTestApp());
});

afterAll(async () => {
  await teardownTestApp();
});

beforeEach(async () => {
  await resetDb();
  users = await createAllRoles(app, db);
  answerRagMock = vi.spyOn(ragClient, 'answerRag').mockReset();
});

function groundedAnswer(overrides: Record<string, unknown> = {}) {
  return {
    status: 'answered',
    answer: 'The selected manual identifies low hydraulic pressure during startup.',
    confidence: 'medium',
    evidence_sufficient: true,
    sources: [
      {
        source_id: 'source-1',
        chunk_id: 'chunk-1',
        manual_id: new ObjectId().toHexString(),
        manual_title: 'Hydraulic Service Manual',
        manual_version: '2.1',
        page_start: 42,
        page_end: 43,
        section_title: 'Startup alarms',
        machine_model_id: null,
        excerpt: 'E-104 indicates low hydraulic pressure during startup.',
      },
    ],
    suggested_actions: [
      {
        id: 'suggestion-1',
        description: 'Check the hydraulic fluid level.',
        source_ids: ['source-1'],
        status: 'suggested',
      },
    ],
    warnings: [],
    retrieval: { exact_matches: 1, semantic_matches: 2, final_context_chunks: 1 },
    ...overrides,
  };
}

async function seedManual(modelId: string, version = '2.1') {
  const now = new Date();
  const id = new ObjectId();
  await collections.manuals(db).insertOne({
    _id: id,
    title: 'Hydraulic Service Manual',
    scope: 'model',
    machine_model_id: new ObjectId(modelId),
    document_type: 'service',
    document_version: version,
    is_current_version: true,
    is_active: true,
    language: 'en',
    original_filename: 'hydraulic.pdf',
    storage_path: `manuals/${id.toHexString()}/original.pdf`,
    file_size_bytes: 1024,
    sha256: 'a'.repeat(64),
    mime_type: 'application/pdf',
    processing_status: 'completed',
    indexed_chunk_count: 12,
    uploaded_by: new ObjectId(users.admin.id),
    is_deleted: false,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  } as never);
  return id.toHexString();
}

async function openConversation(body: Record<string, unknown> = {}) {
  const seeded = await seedMachine(app, users.admin);
  const res = await request(app)
    .post(`${PREFIX}/conversations`)
    .set(...auth(users.technician))
    .send({
      title: 'Hydraulic startup alarm',
      machineId: seeded.machineId,
      issueSummary: 'Hydraulic pressure drops during startup',
      ...body,
    });
  expect(res.status).toBe(201);
  return { ...seeded, conversationId: res.body.data.conversation.id as string, created: res };
}

describe('conversation creation and scope', () => {
  it('creates a conversation bound to a machine and resolved model', async () => {
    const { machineId, modelId, created } = await openConversation();
    const conv = created.body.data.conversation;
    expect(conv.machineId).toBe(machineId);
    expect(conv.machineModelId).toBe(modelId);
    expect(conv.scopeSource).toBe('user_selected_machine');
    expect(conv.status).toBe('active');
    expect(conv.issueStatus).toBe('unknown');
    expect(conv.messageCount).toBe(0);
  });

  it('rejects a machine/model mismatch', async () => {
    const a = await seedMachine(app, users.admin);
    const b = await seedMachine(app, users.admin);
    const res = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ machineId: a.machineId, machineModelId: b.modelId, title: 'Mismatch' });
    expect(res.status).toBe(422);
  });

  it('rejects a manual that belongs to a different model', async () => {
    const a = await seedMachine(app, users.admin);
    const b = await seedMachine(app, users.admin);
    const manualId = await seedManual(b.modelId);
    const res = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ machineModelId: a.modelId, manualId, title: 'Wrong manual' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts a matching manual version', async () => {
    const { modelId } = await seedMachine(app, users.admin);
    const manualId = await seedManual(modelId, '2.1');
    const res = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ machineModelId: modelId, manualId, manualVersion: '2.1', title: 'Scoped' });
    expect(res.status).toBe(201);
    expect(res.body.data.conversation.manualId).toBe(manualId);
    expect(res.body.data.conversation.manualVersion).toBe('2.1');
  });
});

describe('list filters and pagination', () => {
  it('lists summary fields without messages', async () => {
    await openConversation();
    const res = await request(app).get(`${PREFIX}/conversations`).set(...auth(users.technician));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Hydraulic startup alarm');
    expect(res.body.data[0].issueStatus).toBe('unknown');
    expect(res.body.data[0].messages).toBeUndefined();
    expect(res.body.meta.pagination.total).toBe(1);
  });

  it('filters by issueStatus and machineId', async () => {
    const first = await openConversation();
    await request(app)
      .patch(`${PREFIX}/conversations/${first.conversationId}/issue-status`)
      .set(...auth(users.technician))
      .send({ issueStatus: 'investigating' });
    const res = await request(app)
      .get(`${PREFIX}/conversations?issueStatus=investigating&machineId=${first.machineId}`)
      .set(...auth(users.technician));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('sending messages', () => {
  it('persists user and assistant messages with citations', async () => {
    answerRagMock.mockResolvedValue(groundedAnswer());
    const { conversationId } = await openConversation();
    const res = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing during hydraulic startup?' });
    expect(res.status).toBe(200);
    expect(res.body.data.message.role).toBe('assistant');
    expect(res.body.data.message.messageType).toBe('answer');
    expect(res.body.data.rag.status).toBe('answered');
    expect(res.body.data.rag.sources[0].manualTitle).toBe('Hydraulic Service Manual');
    expect(res.body.data.conversation.issueStatus).toBe('investigating');
    expect(JSON.stringify(res.body)).not.toMatch(/storage_path|\/home\//);

    const listed = await request(app)
      .get(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician));
    expect(listed.body.data).toHaveLength(2);
    expect(listed.body.data[0].role).toBe('user');
    expect(listed.body.data[1].sources[0].pageStart).toBe(42);
  });

  it('continues with a follow-up and sends bounded conversation context', async () => {
    answerRagMock.mockResolvedValue(groundedAnswer());
    const { conversationId } = await openConversation();
    await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing during hydraulic startup?' });
    await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'What should I check first?' });
    expect(answerRagMock).toHaveBeenCalled();
    const lastCall = answerRagMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastCall.conversation_context).toBeTruthy();
    const ctx = lastCall.conversation_context as Record<string, unknown>;
    expect(ctx.issue_summary).toMatch(/Hydraulic/);
    expect(Array.isArray(ctx.recent_messages)).toBe(true);
  });

  it('handles insufficient evidence as a refusal, not a successful answer', async () => {
    answerRagMock.mockResolvedValue({
      status: 'insufficient_evidence',
      answer: null,
      evidence_sufficient: false,
      reason: 'INSUFFICIENT_EVIDENCE',
      message: 'The manuals do not support a reliable answer.',
      sources: [],
      warnings: [],
    });
    const { conversationId } = await openConversation();
    const res = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'What colour should we paint the hopper?' });
    expect(res.status).toBe(200);
    expect(res.body.data.rag.status).toBe('insufficient_evidence');
    expect(res.body.data.message.messageType).toBe('refusal');
    expect(res.body.data.conversation.issueStatus).not.toBe('resolved');
  });

  it('handles clarification_required', async () => {
    answerRagMock.mockResolvedValue({
      status: 'clarification_required',
      answer: null,
      evidence_sufficient: false,
      reason: 'MACHINE_MODEL_REQUIRED',
      message: 'Which machine or manual version are you referring to?',
      sources: [],
      warnings: [],
    });
    const created = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.technician))
      .send({ title: 'Unscoped' });
    const res = await request(app)
      .post(`${PREFIX}/conversations/${created.body.data.conversation.id}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing during hydraulic startup?' });
    expect(res.status).toBe(200);
    expect(res.body.data.rag.status).toBe('clarification_required');
    expect(res.body.data.message.messageType).toBe('clarification');
  });

  it('handles conflicting evidence', async () => {
    answerRagMock.mockResolvedValue({
      ...groundedAnswer(),
      status: 'conflicting_evidence',
      confidence: 'low',
      reason: 'VERSION_CONFLICT',
      message: 'Manual versions disagree on the relief setting.',
    });
    const { conversationId } = await openConversation();
    const res = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'What is the relief valve setting for E-104?' });
    expect(res.status).toBe(200);
    expect(res.body.data.rag.status).toBe('conflicting_evidence');
    expect(res.body.data.message.messageType).toBe('refusal');
  });

  it('stores the user message when RAG fails', async () => {
    answerRagMock.mockRejectedValue(new Error('boom'));
    const { conversationId } = await openConversation();
    const res = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing?' });
    expect(res.status).toBe(503);
    const listed = await request(app)
      .get(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician));
    expect(listed.body.data[0].role).toBe('user');
    expect(listed.body.data[0].content).toMatch(/E-104/);
    expect(listed.body.data.some((m: { status: string }) => m.status === 'failed')).toBe(true);
  });

  it('rejects empty and over-long messages', async () => {
    const { conversationId } = await openConversation();
    const empty = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: '' });
    expect(empty.status).toBe(422);
    const long = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'x'.repeat(5001) });
    expect(long.status).toBe(422);
  });

  it('prevents duplicate submissions in the short window', async () => {
    answerRagMock.mockResolvedValue(groundedAnswer());
    const { conversationId } = await openConversation();
    const body = { content: 'Why is error E-104 appearing during hydraulic startup?' };
    const first = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send(body);
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send(body);
    expect(second.status).toBe(409);
  });

  it('asks for clarification when a pronoun could mean several suggested checks', async () => {
    answerRagMock.mockResolvedValue(
      groundedAnswer({
        suggested_actions: [
          { id: 'suggestion-1', description: 'Check the suction strainer.', source_ids: ['source-1'], status: 'suggested' },
          { id: 'suggestion-2', description: 'Inspect the relief valve.', source_ids: ['source-1'], status: 'suggested' },
        ],
      }),
    );
    const { conversationId } = await openConversation();
    await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing during hydraulic startup?' });
    const follow = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'That did not solve it.' });
    expect(follow.status).toBe(200);
    expect(follow.body.data.rag.status).toBe('clarification_required');
  });
});

describe('technician actions and issue status', () => {
  it('records a technician action separately from AI suggestions', async () => {
    answerRagMock.mockResolvedValue(groundedAnswer());
    const { conversationId } = await openConversation();
    const asked = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing?' });
    const action = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/actions`)
      .set(...auth(users.technician))
      .send({
        action: 'Checked hydraulic fluid level',
        result: 'Fluid level was normal',
        status: 'completed',
        performedAt: '2026-09-04T10:00:00.000Z',
        notes: 'No visible leakage found.',
        sourceMessageId: asked.body.data.message.id,
        suggestionId: 'suggestion-1',
      });
    expect(action.status).toBe(201);
    expect(action.body.data.action.action).toBe('Checked hydraulic fluid level');
    expect(action.body.data.action.sourceMessageId).toBe(asked.body.data.message.id);

    const detail = await request(app)
      .get(`${PREFIX}/conversations/${conversationId}`)
      .set(...auth(users.technician));
    expect(detail.body.data.conversation.attemptedActions).toContain('Checked hydraulic fluid level');
    expect(detail.body.data.conversation.confirmedFindings).toContain('Fluid level was normal');
    expect(detail.body.data.conversation.issueStatus).not.toBe('resolved');
  });

  it('requires a confirmation note to mark resolved and never infers it from RAG', async () => {
    answerRagMock.mockResolvedValue(groundedAnswer());
    const { conversationId } = await openConversation();
    await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing?' });
    const missing = await request(app)
      .patch(`${PREFIX}/conversations/${conversationId}/issue-status`)
      .set(...auth(users.technician))
      .send({ issueStatus: 'resolved' });
    expect(missing.status).toBe(422);
    const ok = await request(app)
      .patch(`${PREFIX}/conversations/${conversationId}/issue-status`)
      .set(...auth(users.technician))
      .send({
        issueStatus: 'resolved',
        confirmationNote: 'Machine operated normally for 20 minutes after repair.',
      });
    expect(ok.status).toBe(200);
    expect(ok.body.data.conversation.issueStatus).toBe('resolved');
  });

  it('closes and reopens without deleting history', async () => {
    answerRagMock.mockResolvedValue(groundedAnswer());
    const { conversationId } = await openConversation();
    await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing?' });
    await request(app)
      .patch(`${PREFIX}/conversations/${conversationId}/issue-status`)
      .set(...auth(users.technician))
      .send({ issueStatus: 'unresolved', confirmationNote: 'Need a spare part.' });
    const closed = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/close`)
      .set(...auth(users.technician))
      .send({});
    expect(closed.status).toBe(200);
    expect(closed.body.data.conversation.status).toBe('closed');

    const blocked = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Any update?' });
    expect(blocked.status).toBe(422);

    const reopened = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/reopen`)
      .set(...auth(users.technician))
      .send({ note: 'Part arrived.' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.conversation.status).toBe('active');

    const history = await request(app)
      .get(`${PREFIX}/conversations/${conversationId}/messages`)
      .set(...auth(users.technician));
    expect(history.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('archives a conversation', async () => {
    const { conversationId } = await openConversation();
    const res = await request(app)
      .post(`${PREFIX}/conversations/${conversationId}/archive`)
      .set(...auth(users.technician))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.conversation.status).toBe('archived');
  });
});

describe('authorization', () => {
  it('hides another technician’s conversation and blocks their messages', async () => {
    const other = await createUser(app, db, 'technician', 'tech_other');
    const seeded = await seedMachine(app, users.admin);
    const created = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(other))
      .send({ title: 'Private', machineId: seeded.machineId });
    const id = created.body.data.conversation.id;
    const peek = await request(app).get(`${PREFIX}/conversations/${id}`).set(...auth(users.technician));
    expect(peek.status).toBe(404);
    const msg = await request(app)
      .post(`${PREFIX}/conversations/${id}/messages`)
      .set(...auth(users.technician))
      .send({ content: 'Why is error E-104 appearing?' });
    expect([404, 403]).toContain(msg.status);
  });

  it('lets a manager read any conversation', async () => {
    const { conversationId } = await openConversation();
    const res = await request(app)
      .get(`${PREFIX}/conversations/${conversationId}`)
      .set(...auth(users.manager));
    expect(res.status).toBe(200);
  });

  it('forbids a viewer from creating conversations', async () => {
    const res = await request(app)
      .post(`${PREFIX}/conversations`)
      .set(...auth(users.viewer))
      .send({ title: 'Nope' });
    expect(res.status).toBe(403);
  });
});


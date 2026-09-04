/**
 * Incident HTTP handlers. Thin: validation, actor resolution, service call,
 * envelope. All authorization state (org, machine, ownership) is resolved in
 * the service from the authenticated user - never from the body.
 */
import type { Request, Response } from 'express';
import { successEnvelope } from '../../core/api-error.js';
import {
  assertNoOperators,
  objectIdSchema,
  parseOrThrow,
  toObjectId,
} from '../../common/validation.js';
import { requireDb } from '../../common/repository.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as service from './incidents.service.js';
import {
  closeIncidentSchema,
  createIncidentSchema,
  deleteIncidentSchema,
  fixConfirmSchema,
  fixRecordSchema,
  issueStatusChangeSchema,
  listIncidentsSchema,
  reopenIncidentSchema,
  rootCauseConfirmSchema,
  rootCauseRejectSchema,
  rootCauseUpdateSchema,
  statusChangeSchema,
  updateIncidentSchema,
} from './incidents.validators.js';

function actorOf(req: Request) {
  const auth = requireAuth(req);
  return { id: toObjectId(auth.userId), username: auth.username, role: auth.role };
}

export async function create(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const input = parseOrThrow(createIncidentSchema, req.body);
  const incident = await service.create(requireDb(), input, actorOf(req), req.requestId);
  res.status(201).json(successEnvelope({ incident }, req.requestId));
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(listIncidentsSchema, req.query);
  const result = await service.list(requireDb(), query, actorOf(req));
  res.status(200).json({
    success: true,
    data: result.items,
    meta: {
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      pagination: result.pagination,
    },
  });
}

export async function getById(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const incident = await service.getById(requireDb(), toObjectId(id), actorOf(req));
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function update(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(updateIncidentSchema, req.body);
  const incident = await service.update(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function remove(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const { reason } = parseOrThrow(deleteIncidentSchema, req.body);
  const result = await service.cancel(requireDb(), toObjectId(id), reason, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident: result }, req.requestId));
}

export async function changeStatus(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const { status, reason } = parseOrThrow(statusChangeSchema, req.body);
  const incident = await service.changeStatus(requireDb(), toObjectId(id), status, reason, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function changeIssueStatus(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const { issueStatus, note } = parseOrThrow(issueStatusChangeSchema, req.body);
  const incident = await service.changeIssueStatus(requireDb(), toObjectId(id), issueStatus, note, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function updateRootCause(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(rootCauseUpdateSchema, req.body);
  const incident = await service.updateRootCause(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function confirmRootCause(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(rootCauseConfirmSchema, req.body);
  const incident = await service.confirmRootCause(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function rejectRootCause(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(rootCauseRejectSchema, req.body);
  const incident = await service.rejectRootCause(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function rootCauseHistory(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const history = await service.getRootCauseHistory(requireDb(), toObjectId(id), actorOf(req));
  res.status(200).json(successEnvelope({ history }, req.requestId));
}

export async function recordTemporaryFix(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(fixRecordSchema, req.body);
  const incident = await service.recordTemporaryFix(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(201).json(successEnvelope({ incident }, req.requestId));
}

export async function confirmTemporaryFix(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(fixConfirmSchema, req.body);
  const incident = await service.confirmTemporaryFix(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function recordPermanentFix(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(fixRecordSchema, req.body);
  const incident = await service.recordPermanentFix(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(201).json(successEnvelope({ incident }, req.requestId));
}

export async function confirmPermanentFix(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(fixConfirmSchema, req.body);
  const incident = await service.confirmPermanentFix(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function fixHistory(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const fixes = await service.getFixHistory(requireDb(), toObjectId(id), actorOf(req));
  res.status(200).json(successEnvelope({ fixes }, req.requestId));
}

export async function timeline(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const events = await service.timeline(requireDb(), toObjectId(id), actorOf(req));
  res.status(200).json(successEnvelope({ timeline: events }, req.requestId));
}

export async function similar(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const similar = await service.similar(requireDb(), toObjectId(id), actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ similar }, req.requestId));
}

export async function close(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(closeIncidentSchema, req.body);
  const incident = await service.close(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function reopen(req: Request, res: Response): Promise<void> {
  assertNoOperators(req.body);
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const input = parseOrThrow(reopenIncidentSchema, req.body);
  const incident = await service.reopen(requireDb(), toObjectId(id), input, actorOf(req), req.requestId);
  res.status(200).json(successEnvelope({ incident }, req.requestId));
}

export async function reindex(req: Request, res: Response): Promise<void> {
  const id = parseOrThrow(objectIdSchema, req.params.id);
  const result = await service.reindex(requireDb(), toObjectId(id), actorOf(req), req.requestId);
  res.status(202).json(successEnvelope({ incident: result }, req.requestId));
}

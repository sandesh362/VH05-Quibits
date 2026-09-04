/**
 * Create an incident from a troubleshooting conversation.
 *
 * Only explicit factual information is copied:
 *   - user-reported symptoms, error codes, operating conditions
 *   - machine / machine-model / manual scope
 *   - technician-confirmed actions (recorded through the conversation action
 *     log with a completed/attempted status)
 *
 * AI hypotheses and AI suggestions are NEVER copied as confirmed facts. They
 * stay in the conversation; the incident links back to it so a technician can
 * review the suggestions there. Nothing here confirms a root cause, a fix, or
 * an action result - the incident workflows require separate human
 * confirmation.
 */
import type { Db, ObjectId } from 'mongodb';
import { collections } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { toObjectId } from '../../common/validation.js';
import * as audit from '../audit/audit.service.js';
import { resolveActorOrg, type OrgActor } from '../organizations/organizations.service.js';
import * as incidents from '../incidents/incidents.service.js';
import * as actions from '../incident-actions/incident-actions.service.js';

export interface CreateFromConversationInput {
  title: string;
  description?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assignedTo?: string | null;
  tags?: string[];
}

export async function createIncidentFromConversation(
  db: Db,
  conversationId: ObjectId,
  input: CreateFromConversationInput,
  actor: OrgActor,
  requestId?: string,
) {
  const conversation = await collections
    .conversations(db)
    .findOne({ _id: conversationId, is_deleted: false });
  if (!conversation) throw ApiError.notFound('Conversation not found.');

  // The conversation must belong to the actor's organization (resolved via
  // its owner's org - conversations predate explicit org fields).
  const ownerOrg = await resolveActorOrg(db, conversation.user_id, '', '');
  if (!ownerOrg.orgId.equals(actor.orgId)) {
    throw ApiError.notFound('Conversation not found.');
  }

  if (!conversation.machine_id) {
    throw ApiError.validation(
      'This conversation has no machine scope. Link it to a machine before creating an incident.',
      [{ field: 'conversationId', issue: 'Conversation must be machine-scoped.' }],
    );
  }

  const descriptionParts: string[] = [];
  if (conversation.issue_summary) descriptionParts.push(`Issue summary: ${conversation.issue_summary}`);
  for (const finding of conversation.confirmed_findings ?? []) {
    descriptionParts.push(`Confirmed finding: ${finding}`);
  }
  if (input.description) descriptionParts.push(input.description);

  const incident = await incidents.create(
    db,
    {
      title: input.title,
      description:
        descriptionParts.join('\n') ||
        `Incident created from conversation ${conversation._id.toHexString()}.`,
      source: 'conversation',
      machineId: conversation.machine_id.toHexString(),
      machineModelId: conversation.machine_model_id
        ? conversation.machine_model_id.toHexString()
        : undefined,
      conversationId: conversation._id.toHexString(),
      manualId: conversation.manual_id ? conversation.manual_id.toHexString() : undefined,
      manualVersion: conversation.manual_version ?? undefined,
      assignedTo: input.assignedTo ?? (conversation.user_id ? conversation.user_id.toHexString() : null),
      severity: input.severity ?? 'medium',
      priority: input.priority ?? 'medium',
      issueStatus: conversation.issue_status ?? 'unknown',
      symptoms: conversation.symptoms ?? [],
      errorCodes: conversation.error_codes ?? [],
      operatingConditions: conversation.operating_conditions ?? [],
      tags: input.tags ?? [],
      attachments: [],
    },
    { id: actor.userId, username: actor.username, role: actor.role },
    requestId,
  );

  // Import technician-confirmed actions as technician actions. Their observed
  // results are recorded but NOT confirmed: confirmation is a separate,
  // explicit human act in the incident workflows.
  const performedActions = await collections
    .conversationActions(db)
    .find({
      conversation_id: conversation._id,
      status: { $in: ['attempted', 'completed'] },
    })
    .sort({ performed_at: 1 })
    .toArray();

  for (const action of performedActions) {
    await actions.record(
      db,
      toObjectId(incident.id),
      {
        actionType: 'technician',
        description: action.action,
        performedBy: action.created_by,
        sourceMessageId: action.source_message_id ?? null,
        result: action.result ?? null,
        resultStatus: 'not_tested',
        notes: `Imported from conversation ${conversation._id.toHexString()}.`,
        performedAt: action.performed_at,
        timeline: true,
      },
      actor,
      requestId,
    );
  }

  await audit.record(db, {
    action: audit.AUDIT_ACTIONS.incidentLinked,
    actor,
    entityType: 'incident',
    entityId: toObjectId(incident.id),
    requestId: requestId ?? null,
    metadata: {
      conversation_id: conversation._id.toHexString(),
      imported_action_count: performedActions.length,
    },
  });

  return { incident, importedActions: performedActions.length };
}

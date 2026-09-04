/**
 * Machine timeline (Phase 7).
 *
 * A merged, chronological view of everything that happened TO one machine:
 * maintenance records and incident events. Both source collections are
 * org-scoped; the timeline never crosses organization boundaries and never
 * invents events - it only merges records that already exist.
 */
import type { Db, ObjectId } from 'mongodb';
import { collections } from '../../database/collections.js';
import { ApiError } from '../../core/api-error.js';
import { liveFilter } from '../../common/repository.js';
import { toObjectId } from '../../common/validation.js';
import { requireLiveMachine } from '../machines/machines.service.js';
import { resolveActorOrg } from '../organizations/organizations.service.js';

type Actor = { id: ObjectId; username: string; role: string };

export interface TimelineQuery {
  from?: Date;
  to?: Date;
  limit?: number;
  kind?: 'all' | 'maintenance' | 'incident';
}

export interface MachineTimelineEvent {
  id: string;
  kind: 'maintenance' | 'incident';
  at: string;
  title: string;
  actorId: string | null;
  actorUsername: string | null;
  // maintenance events
  maintenanceType?: string | null;
  partsReplaced?: { partNumber: string; name: string | null }[];
  // incident events
  incidentId?: string | null;
  incidentNumber?: string | null;
  eventType?: string | null;
  previous?: unknown;
  next?: unknown;
  note?: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** A live event filter for the merged collection scan. */
function inWindow(query: TimelineQuery): Record<string, unknown> {
  const bounds: Record<string, unknown> = {};
  if (query.from) bounds.$gte = query.from;
  if (query.to) bounds.$lte = query.to;
  return bounds;
}

export async function machineTimeline(
  db: Db,
  machineId: ObjectId,
  query: TimelineQuery,
  actor: Actor,
): Promise<{ machine: Record<string, unknown>; timeline: MachineTimelineEvent[] }> {
  const org = await resolveActorOrg(db, actor.id, actor.username, actor.role);
  const machine = await requireLiveMachine(db, machineId);
  if (machine.organization_id && !machine.organization_id.equals(org.orgId)) {
    throw ApiError.notFound('Machine not found.');
  }

  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const events: MachineTimelineEvent[] = [];

  // --- Maintenance events ---------------------------------------------------
  if (query.kind !== 'incident') {
    const filter: Record<string, unknown> = {
      organization_id: org.orgId,
      machine_id: machineId,
    };
    const window = inWindow(query);
    if (Object.keys(window).length > 0) filter.performed_at = window;

    const rows = await collections
      .maintenanceRecords(db)
      .find(liveFilter(filter))
      .sort({ performed_at: -1 })
      .limit(limit)
      .toArray();

    for (const row of rows) {
      events.push({
        id: row._id.toHexString(),
        kind: 'maintenance',
        at: row.performed_at.toISOString(),
        title: row.title,
        actorId: row.performed_by ? row.performed_by.toHexString() : null,
        actorUsername: null,
        maintenanceType: row.maintenance_type,
        partsReplaced: (row.parts_replaced ?? []).map((part) => ({
          partNumber: part.part_number,
          name: part.name ?? null,
        })),
      });
    }
  }

  // --- Incident events -------------------------------------------------------
  if (query.kind !== 'maintenance') {
    const incidentFilter: Record<string, unknown> = {
      organization_id: org.orgId,
      machine_id: machineId,
    };
    const createdWindow = inWindow(query);
    if (Object.keys(createdWindow).length > 0) incidentFilter.created_at = createdWindow;

    const incidents = await collections
      .incidents(db)
      .find(liveFilter(incidentFilter), { projection: { timeline: 1, incident_number: 1 } })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    for (const incident of incidents) {
      for (const event of (incident.timeline ?? []).slice(-limit)) {
        if (query.from && event.at < query.from) continue;
        if (query.to && event.at > query.to) continue;
        events.push({
          id: event._id.toHexString(),
          kind: 'incident',
          at: event.at.toISOString(),
          title: event.type.replace(/_/g, ' '),
          actorId: event.actor_id ? event.actor_id.toHexString() : null,
          actorUsername: event.actor_username ?? null,
          incidentId: incident._id.toHexString(),
          incidentNumber: incident.incident_number,
          eventType: event.type,
          previous: event.previous,
          next: event.next,
          note: event.note ?? null,
        });
      }
    }
  }

  // Merged, newest first. Titles of incident events carry the incident
  // number so the timeline is readable without a join.
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const timeline = events.slice(0, limit).map((event) =>
    event.kind === 'incident' && event.incidentNumber
      ? { ...event, title: `${event.title} — ${event.incidentNumber}` }
      : event,
  );

  const model = await collections
    .machineModels(db)
    .findOne({ _id: machine.machine_model_id }, { projection: { manufacturer: 1, model_name: 1 } });

  return {
    machine: {
      id: machine._id.toHexString(),
      assetTag: machine.asset_tag,
      displayName: machine.display_name ?? null,
      modelLabel: model ? `${model.manufacturer} ${model.model_name}` : null,
      openIncidentCount: machine.open_incident_count ?? 0,
    },
    timeline,
  };
}

export function toTimelineId(raw: string): ObjectId {
  return toObjectId(raw);
}

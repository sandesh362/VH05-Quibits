/**
 * Incident timeline builder.
 *
 * The timeline is append-only: events are pushed, never modified. This module
 * owns the event shape and the append primitive used by every workflow step,
 * so historical events can never be silently overwritten.
 */
import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { collections, type IncidentDoc, type IncidentTimelineEvent } from '../../database/collections.js';

export interface TimelineActor {
  id: ObjectId;
  username: string;
}

/** Build a single timeline event. `at` defaults to now (tests can override). */
export function timelineEvent(
  type: string,
  actor: TimelineActor | null,
  options: {
    at?: Date;
    previous?: unknown;
    next?: unknown;
    note?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): IncidentTimelineEvent {
  return {
    _id: new ObjectId(),
    sequence: 0, // assigned by appendTimelineEvent
    type,
    at: options.at ?? new Date(),
    actor_id: actor?.id ?? null,
    actor_username: actor?.username ?? null,
    previous: options.previous,
    next: options.next,
    note: options.note ?? null,
    metadata: options.metadata ?? null,
  };
}

/**
 * Append one event to an incident's timeline. Events are pushed in order and
 * receive a strictly increasing sequence number; existing events are never
 * touched.
 */
export async function appendTimelineEvent(
  db: Db,
  incidentId: ObjectId,
  event: IncidentTimelineEvent,
): Promise<void> {
  const incidents = collections.incidents(db);
  const before = await incidents.findOne(
    { _id: incidentId },
    { projection: { timeline: { $slice: -1 } } },
  );
  const lastSequence = before?.timeline?.[0]?.sequence ?? 0;
  event.sequence = lastSequence + 1;

  const result = await incidents.updateOne(
    { _id: incidentId },
    { $push: { timeline: event } },
  );
  if (result.matchedCount === 0) {
    throw new Error(`Incident ${incidentId.toHexString()} disappeared while recording a timeline event.`);
  }
}

/** Fetch the incident timeline in chronological order. */
export async function getTimeline(
  db: Db,
  incident: IncidentDoc,
): Promise<IncidentTimelineEvent[]> {
  const fresh = await collections
    .incidents(db)
    .findOne({ _id: incident._id }, { projection: { timeline: 1 } });
  const events = fresh?.timeline ?? [];
  return [...events].sort((a, b) => a.sequence - b.sequence);
}

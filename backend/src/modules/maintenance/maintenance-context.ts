/**
 * Maintenance context for RAG answers (Phase 7).
 *
 * The maintenance lane is the THIRD evidence class: structured records of
 * work performed, passed to the AI service as `maintenance_context[]` and
 * rendered strictly separately from manual evidence. The AI service computes
 * `days_before_incident`, `correlation_strength`, and the deterministic
 * `noted_by_manual` part-number correlation; Express only supplies the
 * bounded, org-scoped facts.
 *
 * No vectors are built for maintenance (by design) - this is structured
 * data, fetched by machine + time window.
 */
import type { Db, ObjectId } from 'mongodb';
import { getConfig } from '../../config/env.js';
import { collections } from '../../database/collections.js';
import { liveFilter } from '../../common/repository.js';

export interface MaintenanceContextItem {
  id: string;
  maintenance_type: string;
  title: string;
  performed_at: string;
  parts_replaced: { part_number: string; name: string | null }[];
  related_incident_id: string | null;
}

/**
 * Collect the recent maintenance history for a machine, scoped to the
 * caller's organization and bounded by config. Sorted newest first.
 */
export async function collectMaintenanceContext(
  db: Db,
  orgId: ObjectId,
  machineId: ObjectId,
  now: Date = new Date(),
): Promise<MaintenanceContextItem[]> {
  const config = getConfig();
  const windowStart = new Date(now.getTime() - config.maintenanceHistory.days * 24 * 60 * 60 * 1000);

  const rows = await collections
    .maintenanceRecords(db)
    .find(
      liveFilter({
        organization_id: orgId,
        machine_id: machineId,
        performed_at: { $gte: windowStart, $lte: now },
      }),
      {
        projection: {
          maintenance_type: 1,
          title: 1,
          performed_at: 1,
          parts_replaced: 1,
          related_incident_id: 1,
        },
      },
    )
    .sort({ performed_at: -1 })
    .limit(config.maintenanceHistory.maxContextItems)
    .toArray();

  return rows.map((row) => ({
    id: row._id.toHexString(),
    maintenance_type: row.maintenance_type,
    title: row.title,
    performed_at: row.performed_at.toISOString(),
    parts_replaced: (row.parts_replaced ?? []).map((part) => ({
      part_number: part.part_number,
      name: part.name ?? null,
    })),
    related_incident_id: row.related_incident_id ? row.related_incident_id.toHexString() : null,
  }));
}

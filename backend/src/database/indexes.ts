/**
 * Index definitions, created idempotently at startup.
 *
 * Every index below exists to serve a query the application actually makes, or
 * to enforce a uniqueness rule. There are no speculative indexes: each one
 * costs write throughput and RAM, so an index without a caller is a liability.
 *
 * `createIndexes` is idempotent - re-running is a no-op unless a definition
 * changed. If a definition DOES change, MongoDB raises IndexOptionsConflict
 * rather than silently keeping the old one; we surface that clearly.
 */
import type { Db } from 'mongodb';
import { collections } from './collections.js';
import { getLogger } from '../core/logger.js';

/**
 * Case-insensitive comparison. Used for identifiers humans type, where
 * `Toshiba` and `toshiba` must collide rather than create a duplicate.
 */
const CI_COLLATION = { locale: 'en', strength: 2 } as const;

/** Only index live documents, so soft-deleted rows never block a re-create. */
const NOT_DELETED = { is_deleted: false } as const;

export interface IndexReport {
  collection: string;
  created: string[];
}

export async function ensureIndexes(db: Db): Promise<IndexReport[]> {
  const log = getLogger();
  const report: IndexReport[] = [];

  // -------------------------------------------------------------------------
  // users
  // -------------------------------------------------------------------------
  const userIndexes = await collections.users(db).createIndexes([
    // Login lookup + uniqueness. Case-insensitive so Bob@x.com and bob@x.com
    // are the same account rather than two.
    {
      key: { email: 1 },
      name: 'uniq_email_ci',
      unique: true,
      collation: CI_COLLATION,
    },
    {
      key: { username: 1 },
      name: 'uniq_username_ci',
      unique: true,
      collation: CI_COLLATION,
    },
    // Admin user list, filtered by role/active state.
    { key: { role: 1, is_active: 1 }, name: 'role_active' },
    // Refresh-token rotation looks up by hash on every refresh.
    { key: { 'refresh_tokens.token_hash': 1 }, name: 'refresh_token_hash', sparse: true },
  ]);
  report.push({ collection: 'users', created: userIndexes });

  // -------------------------------------------------------------------------
  // machine_models
  // -------------------------------------------------------------------------
  const modelIndexes = await collections.machineModels(db).createIndexes([
    // THE data-quality guard. Near-duplicate models fragment the manual corpus,
    // which Phase 0 flagged as the top retrieval risk. Case-insensitive and
    // scoped to live rows so a deleted model can be recreated.
    {
      key: { manufacturer: 1, model_name: 1 },
      name: 'uniq_manufacturer_model_ci',
      unique: true,
      collation: CI_COLLATION,
      partialFilterExpression: NOT_DELETED,
    },
    { key: { machine_type: 1 }, name: 'machine_type' },
    // Alias lookup powers "which model is this?" text detection later.
    { key: { aliases: 1 }, name: 'aliases', sparse: true },
    // List default ordering.
    { key: { is_deleted: 1, created_at: -1 }, name: 'live_recent' },
  ]);
  report.push({ collection: 'machine_models', created: modelIndexes });

  // -------------------------------------------------------------------------
  // machines
  // -------------------------------------------------------------------------
  const machineIndexes = await collections.machines(db).createIndexes([
    // Asset tag is the shop-floor identifier; must be unique among live rows.
    {
      key: { asset_tag: 1 },
      name: 'uniq_asset_tag',
      unique: true,
      collation: CI_COLLATION,
      partialFilterExpression: NOT_DELETED,
    },
    // "All machines of this model" - the most common filter, and the
    // dependency check that blocks model deletion.
    { key: { machine_model_id: 1, is_deleted: 1 }, name: 'by_model' },
    { key: { status: 1, is_deleted: 1 }, name: 'by_status' },
    { key: { 'location.line': 1 }, name: 'by_line', sparse: true },
    /**
     * Serial numbers are optional but unique when present.
     *
     * `partialFilterExpression` alone, NOT `sparse` - MongoDB rejects an index
     * that specifies both. The `$type: 'string'` clause is what makes it
     * sparse in effect: documents with a null or absent serial are simply not
     * in the index, so any number of machines may omit one.
     */
    {
      key: { serial_number: 1 },
      name: 'uniq_serial',
      unique: true,
      partialFilterExpression: { serial_number: { $type: 'string' }, is_deleted: false },
    },
    { key: { is_deleted: 1, created_at: -1 }, name: 'live_recent' },
  ]);
  report.push({ collection: 'machines', created: machineIndexes });

  // -------------------------------------------------------------------------
  // manuals
  // -------------------------------------------------------------------------
  const manualIndexes = await collections.manuals(db).createIndexes([
    // The retrieval-time filter (Phase 4+) and the admin list filter.
    {
      key: { machine_model_id: 1, is_deleted: 1, processing_status: 1 },
      name: 'model_live_status',
    },
    { key: { machine_id: 1, is_deleted: 1 }, name: 'by_machine', sparse: true },
    // Duplicate detection: the same file under the same model is a conflict.
    // Scoped to the model because the same generic doc may legitimately apply
    // to two different models.
    {
      key: { sha256: 1, machine_model_id: 1 },
      name: 'uniq_content_per_model',
      unique: true,
      partialFilterExpression: NOT_DELETED,
    },
    { key: { processing_status: 1, created_at: -1 }, name: 'status_recent' },
    { key: { is_deleted: 1, created_at: -1 }, name: 'live_recent' },
  ]);
  report.push({ collection: 'manuals', created: manualIndexes });

  // -------------------------------------------------------------------------
  // manual_processing_jobs
  // -------------------------------------------------------------------------
  const jobIndexes = await collections.manualProcessingJobs(db).createIndexes([
    { key: { manual_id: 1, created_at: -1 }, name: 'manual_recent' },
    { key: { status: 1, created_at: -1 }, name: 'status_recent' },
    {
      key: { machine_model_id: 1, status: 1, created_at: -1 },
      name: 'model_status_recent',
      sparse: true,
    },
    { key: { triggered_by: 1, created_at: -1 }, name: 'triggered_recent', sparse: true },
    // Prevents two concurrent ACTIVE (queued/running) jobs for one manual of
    // any job_type. This is what makes reprocessing requests serialisable: the
    // database refuses a second live job rather than racing two pipelines.
    // Partial on the ACTIVE statuses only, so completed/failed history is
    // unconstrained.
    {
      key: { manual_id: 1 },
      name: 'uniq_active_job_per_manual',
      unique: true,
      partialFilterExpression: { status: { $in: ['queued', 'running'] } },
    },
  ]);
  report.push({ collection: 'manual_processing_jobs', created: jobIndexes });

  // -------------------------------------------------------------------------
  // manual_pages  (page-level extracted text)
  // -------------------------------------------------------------------------
  const pageIndexes = await collections.manualPages(db).createIndexes([
    // One page per manual, exact page order.
    { key: { manual_id: 1, page_number: 1 }, name: 'uniq_manual_page', unique: true },
    { key: { manual_id: 1 }, name: 'by_manual' },
  ]);
  report.push({ collection: 'manual_pages', created: pageIndexes });

  // -------------------------------------------------------------------------
  // manual_chunks  (retrieval unit; Mongo authoritative over Qdrant)
  // -------------------------------------------------------------------------
  const chunkIndexes = await collections.manualChunks(db).createIndexes([
    // One chunk index per manual; a retry overwrites rather than duplicates.
    { key: { manual_id: 1, chunk_index: 1 }, name: 'uniq_manual_chunk', unique: true },
    { key: { manual_id: 1 }, name: 'by_manual' },
    { key: { machine_model_id: 1, indexing_status: 1 }, name: 'model_index_status' },
    { key: { content_hash: 1 }, name: 'content_hash' },
    { key: { qdrant_point_id: 1 }, name: 'qdrant_point', sparse: true },
    { key: { indexing_status: 1 }, name: 'index_status' },
  ]);
  report.push({ collection: 'manual_chunks', created: chunkIndexes });

  // -------------------------------------------------------------------------
  // conversations / messages
  // -------------------------------------------------------------------------
  const conversationIndexes = await collections.conversations(db).createIndexes([
    // The user's own list, most recent first.
    { key: { user_id: 1, last_message_at: -1 }, name: 'user_recent' },
    { key: { machine_id: 1, created_at: -1 }, name: 'machine_recent', sparse: true },
    { key: { status: 1, is_deleted: 1 }, name: 'status_live' },
  ]);
  report.push({ collection: 'conversations', created: conversationIndexes });

  const messageIndexes = await collections.messages(db).createIndexes([
    // Ordered transcript read + the guarantee that sequence numbers are unique
    // within a conversation.
    { key: { conversation_id: 1, sequence: 1 }, name: 'uniq_conv_sequence', unique: true },
    { key: { conversation_id: 1, created_at: 1 }, name: 'conv_chronological' },
  ]);
  report.push({ collection: 'messages', created: messageIndexes });

  // -------------------------------------------------------------------------
  // incidents
  // -------------------------------------------------------------------------
  const incidentIndexes = await collections.incidents(db).createIndexes([
    // Machine timeline - the primary read.
    { key: { machine_id: 1, observed_at: -1 }, name: 'machine_timeline' },
    // "Has this machine thrown this code before?" - the exact-code history
    // lookup that Phase 7 depends on.
    { key: { machine_id: 1, error_code: 1, observed_at: -1 }, name: 'machine_code_history' },
    // Model-tier history, filtered by how it ended.
    {
      key: { machine_model_id: 1, resolution_status: 1, observed_at: -1 },
      name: 'model_resolution_history',
    },
    { key: { incident_number: 1 }, name: 'uniq_incident_number', unique: true },
    { key: { status: 1, is_deleted: 1 }, name: 'status_live' },
    // Drives the Phase 4 indexing sweep: confirmed but not yet vectorised.
    { key: { resolution_confirmed: 1, vector_indexed: 1 }, name: 'confirmed_unindexed' },
    { key: { needs_linking: 1 }, name: 'needs_linking', sparse: true },
    { key: { is_deleted: 1, created_at: -1 }, name: 'live_recent' },
  ]);
  report.push({ collection: 'incidents', created: incidentIndexes });

  // -------------------------------------------------------------------------
  // incident_actions
  // -------------------------------------------------------------------------
  const actionIndexes = await collections.incidentActions(db).createIndexes([
    // Ordered action list + uniqueness of the sequence within an incident.
    { key: { incident_id: 1, sequence: 1 }, name: 'uniq_incident_sequence', unique: true },
    { key: { machine_id: 1, performed_at: -1 }, name: 'machine_actions', sparse: true },
    { key: { performed_by: 1, performed_at: -1 }, name: 'performer_actions' },
    // "What did we do the last time we replaced this part?"
    { key: { 'parts_replaced.part_number': 1 }, name: 'by_part', sparse: true },
    { key: { outcome: 1 }, name: 'by_outcome' },
  ]);
  report.push({ collection: 'incident_actions', created: actionIndexes });

  // -------------------------------------------------------------------------
  // maintenance_records
  // -------------------------------------------------------------------------
  const maintenanceIndexes = await collections.maintenanceRecords(db).createIndexes([
    // The primary structured query: machine + time window.
    { key: { machine_id: 1, performed_at: -1 }, name: 'machine_history' },
    {
      key: { machine_id: 1, maintenance_type: 1, performed_at: -1 },
      name: 'machine_type_history',
    },
    // Part-intersection analysis (Phase 8).
    { key: { 'parts_replaced.part_number': 1, performed_at: -1 }, name: 'part_history' },
    { key: { machine_model_id: 1, performed_at: -1 }, name: 'model_history' },
    { key: { next_due_at: 1 }, name: 'next_due', sparse: true },
    { key: { is_deleted: 1, created_at: -1 }, name: 'live_recent' },
  ]);
  report.push({ collection: 'maintenance_records', created: maintenanceIndexes });

  // -------------------------------------------------------------------------
  // audit_logs
  // -------------------------------------------------------------------------
  const auditIndexes = await collections.auditLogs(db).createIndexes([
    { key: { at: -1 }, name: 'recent' },
    // "Everything that happened to this entity" - the compliance question.
    { key: { entity_type: 1, entity_id: 1, at: -1 }, name: 'entity_history' },
    { key: { actor_id: 1, at: -1 }, name: 'actor_history' },
    { key: { action: 1, at: -1 }, name: 'action_history' },
    { key: { severity: 1, at: -1 }, name: 'severity_recent' },
  ]);
  report.push({ collection: 'audit_logs', created: auditIndexes });

  const total = report.reduce((sum, entry) => sum + entry.created.length, 0);
  log.info({ collections: report.length, indexes: total }, 'Database indexes ensured');

  return report;
}

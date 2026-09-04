/**
 * Add a small, coherent CNC showcase and remove failed document jobs from the
 * local dashboard. Existing non-failed operational history is preserved.
 *
 * Run from the repository root:
 *   npm run seed:showcase --workspace @itp/backend
 */
import { config } from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const databaseUrl = process.env.MONGODB_URI;
const databaseName = process.env.MONGO_DB_NAME ?? 'itp';

if (!databaseUrl) throw new Error('MONGODB_URI must be configured.');

const client = new MongoClient(databaseUrl);
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

async function main(): Promise<void> {
  await client.connect();
  const db = client.db(databaseName);
  const admin = await db.collection('users').findOne({ is_deleted: false, is_active: true });
  const organization = await db.collection('organizations').findOne({ slug: 'default', is_active: true });

  if (!admin || !organization) {
    throw new Error('An active administrator and the default organization are required before seeding.');
  }

  // The dashboard's red alert is driven only by these failed records. Keep
  // all successful history intact; a full data reset needs explicit approval.
  await db.collection('manual_processing_jobs').deleteMany({ status: 'failed' });

  const haasModelId = new ObjectId();
  const fanucModelId = new ObjectId();
  const haasMachineId = new ObjectId();
  const fanucMachineId = new ObjectId();
  const haasManualId = new ObjectId();
  const fanucManualId = new ObjectId();

  const stamps = (createdAt = now) => ({
    created_at: createdAt,
    updated_at: now,
    schema_version: 1,
    is_deleted: false,
    created_by: admin._id,
    updated_by: admin._id,
  });

  await db.collection('machine_models').insertMany([
    {
      _id: haasModelId,
      organization_id: organization._id,
      manufacturer: 'Haas',
      model_name: 'VF-0 / VF-1 / VF-2 / VF-3 VMC',
      machine_type: 'cnc_mill',
      aliases: ['Haas VF Series', 'VF VMC'],
      model_year: 1993,
      specifications: { controller: 'Haas CNC', manual: '96-7000', manual_date: 'July 1993' },
      default_language: 'en',
      notes: 'Vertical machining centre family covered by the Haas VF Maintenance Manual.',
      manual_count: 1,
      machine_count: 1,
      indexed_chunk_count: 418,
      ...stamps(daysAgo(45)),
    },
    {
      _id: fanucModelId,
      organization_id: organization._id,
      manufacturer: 'FANUC',
      model_name: '16i/18i/21i-B CNC',
      machine_type: 'cnc_lathe',
      aliases: ['FANUC 16i-B', 'FANUC 18i-B', 'FANUC 21i-B'],
      model_year: 2002,
      specifications: { controller: 'FANUC 16i/18i/21i-B', manual: 'B-63525EN/02', pages: 1042 },
      default_language: 'en',
      notes: 'CNC control series installed on machining centres and lathes.',
      manual_count: 1,
      machine_count: 1,
      indexed_chunk_count: 1042,
      ...stamps(daysAgo(40)),
    },
  ]);

  await db.collection('machines').insertMany([
    {
      _id: haasMachineId,
      organization_id: organization._id,
      asset_tag: 'CNC-VMC-01',
      machine_model_id: haasModelId,
      model_snapshot: { manufacturer: 'Haas', model_name: 'VF-0 / VF-1 / VF-2 / VF-3 VMC', machine_type: 'cnc_mill' },
      display_name: 'Machine A — Haas VF Series VMC',
      serial_number: 'VF-DEMO-001',
      location: { site: 'Main Plant', building: 'Machining', line: 'Cell A', cell: 'VMC-01' },
      status: 'operational',
      installed_at: new Date('2018-06-15T00:00:00Z'),
      commissioned_at: new Date('2018-06-29T00:00:00Z'),
      criticality: 'high',
      notes: 'Primary vertical machining centre for precision production work.',
      last_maintenance_at: daysAgo(6),
      open_incident_count: 1,
      ...stamps(daysAgo(45)),
    },
    {
      _id: fanucMachineId,
      organization_id: organization._id,
      asset_tag: 'CNC-LATHE-02',
      machine_model_id: fanucModelId,
      model_snapshot: { manufacturer: 'FANUC', model_name: '16i/18i/21i-B CNC', machine_type: 'cnc_lathe' },
      display_name: 'Machine B — FANUC 18i-B CNC',
      serial_number: 'F18I-DEMO-002',
      location: { site: 'Main Plant', building: 'Turning', line: 'Cell B', cell: 'LATHE-02' },
      status: 'maintenance',
      installed_at: new Date('2016-09-12T00:00:00Z'),
      commissioned_at: new Date('2016-09-23T00:00:00Z'),
      criticality: 'high',
      notes: 'FANUC-controlled lathe awaiting a planned encoder inspection.',
      last_maintenance_at: daysAgo(2),
      open_incident_count: 1,
      ...stamps(daysAgo(40)),
    },
  ]);

  await db.collection('manuals').insertMany([
    {
      _id: haasManualId,
      organization_id: organization._id,
      title: 'Haas VF Maintenance Manual',
      description: 'Official Haas archive reference. Full alarm table in §2.5 (pages 102–419+). Source: https://www.haascnc.com/content/dam/haascnc/en/service/manual/operator/english---mill-maintenance---operator\'s-manual---1993.pdf',
      manufacturer: 'Haas', scope: 'model', machine_model_id: haasModelId, machine_id: null,
      document_type: 'maintenance', document_number: '96-7000', document_version: 'July 1993', revision: null,
      supersedes_manual_id: null, is_current_version: true, is_active: true, language: 'en',
      original_filename: 'haas-vf-maintenance-manual-96-7000.pdf', storage_path: 'showcase/haas-vf-maintenance-manual-96-7000.pdf',
      file_size_bytes: 0, sha256: 'showcase-haas-96-7000', mime_type: 'application/pdf', page_count: 419,
      processing_status: 'completed', processing_version: 'showcase-reference', extraction_method: 'native', ocr_used: false,
      indexed_chunk_count: 418, indexed_at: daysAgo(18), processed_at: daysAgo(18), failed_at: null, failure_reason: null,
      uploaded_by: admin._id, ...stamps(daysAgo(18)),
    },
    {
      _id: fanucManualId,
      organization_id: organization._id,
      title: 'FANUC 16i/18i/21i-B Maintenance Manual',
      description: 'Maintenance manual B-63525EN/02 (April 2002), 1,042 PDF pages with native text. Source: https://cnchospital.com.tr/wp-content/uploads/2021/12/63525EN.pdf',
      manufacturer: 'FANUC', scope: 'model', machine_model_id: fanucModelId, machine_id: null,
      document_type: 'maintenance', document_number: 'B-63525EN/02', document_version: 'April 2002', revision: null,
      supersedes_manual_id: null, is_current_version: true, is_active: true, language: 'en',
      original_filename: 'fanuc-b-63525en-02.pdf', storage_path: 'showcase/fanuc-b-63525en-02.pdf',
      file_size_bytes: 0, sha256: 'showcase-fanuc-b-63525en-02', mime_type: 'application/pdf', page_count: 1042,
      processing_status: 'completed', processing_version: 'showcase-reference', extraction_method: 'native', ocr_used: false,
      indexed_chunk_count: 1042, indexed_at: daysAgo(15), processed_at: daysAgo(15), failed_at: null, failure_reason: null,
      uploaded_by: admin._id, ...stamps(daysAgo(15)),
    },
  ]);

  const incident = (id: ObjectId, number: string, machineId: ObjectId, modelId: ObjectId, manualId: ObjectId, title: string, severity: string, status: string, issueStatus: string, description: string, observed: Date) => ({
    _id: id, incident_number: number, organization_id: organization._id, title, description,
    source: 'manual', machine_id: machineId, machine_model_id: modelId, conversation_id: null,
    manual_id: manualId, manual_version: null, reported_by: admin._id, assigned_to: admin._id,
    severity, priority: severity === 'high' ? 'high' : 'medium', status, issue_status: issueStatus,
    symptoms: [title], error_codes: [], operating_conditions: ['Production shift'], first_observed_at: observed,
    last_observed_at: observed, root_cause: { text: null, status: 'unknown', history: [] }, temporary_fix: null,
    permanent_fix: null, resolution_summary: status === 'resolved' ? 'Resolved after preventive service verification.' : null,
    resolved_by: status === 'resolved' ? admin._id : null, resolved_at: status === 'resolved' ? daysAgo(12) : null,
    closed_by: null, closed_at: null, reopened_by: null, reopened_at: null, tags: ['showcase', 'cnc'], attachments: [],
    search_text: `${title} ${description}`, embedding_status: 'not_indexed', qdrant_point_id: null,
    embedding_error: null, embedding_updated_at: null, timeline: [], ...stamps(observed),
  });

  await db.collection('incidents').insertMany([
    incident(new ObjectId(), 'INC-2026-000001', haasMachineId, haasModelId, haasManualId, 'Intermittent spindle load alarm', 'high', 'investigating', 'investigating', 'Spindle load rises intermittently during finishing passes; inspection is in progress.', daysAgo(1)),
    incident(new ObjectId(), 'INC-2026-000002', fanucMachineId, fanucModelId, fanucManualId, 'Axis reference return requires repeat', 'medium', 'open', 'recurring', 'Reference return occasionally completes only after a second attempt; encoder connection inspection is scheduled.', daysAgo(2)),
    incident(new ObjectId(), 'INC-2026-000003', haasMachineId, haasModelId, haasManualId, 'Way lubrication flow check', 'low', 'resolved', 'resolved', 'Low flow indication was cleared after reservoir cleaning and line inspection.', daysAgo(12)),
  ]);

  const maintenance = (machineId: ObjectId, modelId: ObjectId, type: string, title: string, performedAt: Date, nextDueAt: Date, workOrder: string, notes: string) => ({
    _id: new ObjectId(), organization_id: organization._id, machine_id: machineId, machine_model_id: modelId,
    maintenance_type: type, title, description: notes, performed_at: performedAt, performed_by: admin._id,
    performed_by_external: null, work_order_ref: workOrder, parts_replaced: [], components_serviced: [], measurements: [],
    duration_minutes: 60, downtime_minutes: 30, next_due_at: nextDueAt, related_incident_id: null, notes,
    ...stamps(performedAt),
  });

  await db.collection('maintenance_records').insertMany([
    maintenance(haasMachineId, haasModelId, 'lubrication', 'Way lubrication and reservoir inspection', daysAgo(6), new Date('2026-10-05T00:00:00Z'), 'WO-HAAS-1042', 'Reservoir cleaned; delivery lines visually inspected.'),
    maintenance(haasMachineId, haasModelId, 'inspection', 'Spindle taper and drawbar inspection', daysAgo(20), new Date('2026-11-01T00:00:00Z'), 'WO-HAAS-1027', 'Taper cleaned and drawbar retention check recorded.'),
    maintenance(fanucMachineId, fanucModelId, 'inspection', 'Reference return and encoder connection inspection', daysAgo(2), new Date('2026-10-01T00:00:00Z'), 'WO-FANUC-2081', 'Connector seating checked; follow-up observation scheduled.'),
    maintenance(fanucMachineId, fanucModelId, 'preventive', 'CNC cabinet filter and fan cleaning', daysAgo(28), new Date('2026-10-20T00:00:00Z'), 'WO-FANUC-2054', 'Cabinet filters cleaned and cooling fan operation verified.'),
  ]);

  await db.collection<{ _id: string; value: number }>('counters').updateOne(
    { _id: `incident:${organization._id.toHexString()}:2026` },
    { $set: { value: 3 } },
    { upsert: true },
  );

  console.log('Showcase data seeded: 2 machines, 2 manuals, 3 incidents, 4 maintenance records, 0 failed jobs.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => client.close());

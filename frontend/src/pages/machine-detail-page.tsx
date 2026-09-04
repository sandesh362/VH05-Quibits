/**
 * Machine detail.
 *
 * Aggregates everything known about one asset using existing endpoints:
 *  - GET /machines/:id                metadata
 *  - GET /machines/:id/timeline       merged maintenance + incident activity
 *  - GET /incidents?machineId=…       incidents (open + history)
 *  - GET /maintenance?machineId=…     maintenance history
 *  - GET /manuals?machineModelId=…    manuals for the machine's model
 *  - GET /conversations (filtered)    troubleshooting conversations
 *
 * No relationship the API does not support is invented.
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  apiClient,
  type ConversationSummary,
  type IncidentRecord,
  type MachineRecord,
  type MachineTimelineEvent,
  type MaintenanceRecord,
  type ManualRecord,
} from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useAuth } from '../lib/auth';
import { formatDate, formatLocation, titleCase } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  TabPanel,
  Tabs,
} from '../components/ui';
import { ErrorState, LoadingState } from '../components/states';
import {
  IncidentStatusBadge,
  SeverityBadge,
} from '../components/incident-badges';
import { machineStatus, maintenanceType, processingStatus, severity } from '../lib/labels';
import { formatBytes } from '../lib/format';
import './page.css';

interface MachineDetailData {
  machine: MachineRecord;
  timeline: MachineTimelineEvent[];
  incidents: IncidentRecord[];
  maintenance: MaintenanceRecord[];
  manuals: ManualRecord[];
  conversations: ConversationSummary[];
}

export function MachineDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState('overview');

  const { data, error, isInitialLoading, refetch } = useApi<MachineDetailData>(
    async () => {
      const machineResult = await apiClient.getMachine(id);
      const machine = machineResult.machine;
      const [timelineResult, incidentsResult, maintenanceResult, manualsResult, conversationsResult] =
        await Promise.all([
          apiClient.getMachineTimeline(id),
          apiClient.listIncidents({ machineId: id, limit: 100, sortBy: 'created_at', sortOrder: 'desc' }),
          apiClient.listMaintenance({ machineId: id, limit: 100 }),
          apiClient.listManuals({ machineModelId: machine.machineModelId, limit: 100 }),
          apiClient.listConversations({ limit: 100 }),
        ]);
      return {
        machine,
        timeline: timelineResult.timeline,
        incidents: incidentsResult.data,
        maintenance: maintenanceResult.data,
        manuals: manualsResult.data,
        conversations: conversationsResult.data.filter((c) => c.machineId === id),
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  const openIncidents = useMemo(
    () => data?.incidents.filter((i) => !['closed', 'cancelled'].includes(i.status)) ?? [],
    [data],
  );

  if (isInitialLoading) {
    return (
      <div className="page">
        <Card>
          <LoadingState message="Loading machine…" />
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="page">
        <Card>
          <ErrorState
            error={error ?? new Error('Not found')}
            onRetry={refetch}
            title="Could not load this machine"
          />
        </Card>
      </div>
    );
  }

  const { machine, timeline, incidents, maintenance, manuals, conversations } = data;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'incidents', label: 'Incidents', count: incidents.length },
    { id: 'maintenance', label: 'Maintenance', count: maintenance.length },
    { id: 'manuals', label: 'Manuals', count: manuals.length },
    { id: 'conversations', label: 'Conversations', count: conversations.length },
    { id: 'timeline', label: 'Activity timeline', count: timeline.length },
  ];

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[{ label: 'Machines', to: '/machines' }, { label: machine.assetTag }]}
        title={machine.displayName ?? machine.assetTag}
        description={
          machine.modelSnapshot
            ? `${machine.modelSnapshot.manufacturer} ${machine.modelSnapshot.modelName} · ${machine.modelSnapshot.machineType}`
            : 'Machine model reference missing'
        }
        actions={
          can('machine.update') ? (
            <Link to={`/machines/${machine.id}/edit`} className="btn btn--secondary btn--sm">
              Edit machine
            </Link>
          ) : null
        }
      />

      <Card>
        <div className="entity-header">
          <div>
            <h2 style={{ marginBottom: 4 }}>{machine.assetTag}</h2>
            <p className="entity-header__meta">
              Serial {machine.serialNumber ?? '—'} · Registered {formatDate(machine.createdAt, false)}
            </p>
          </div>
          <div className="entity-header__badges">
            <Badge presentation={machineStatus(machine.status)} />
            {machine.criticality && <Badge presentation={severity(machine.criticality)} />}
          </div>
        </div>

        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        <TabPanel id="overview" active={tab}>
          <DescriptionList
            items={[
              { label: 'Asset tag', value: <span className="mono">{machine.assetTag}</span> },
              { label: 'Display name', value: machine.displayName ?? '—' },
              { label: 'Model', value: machine.modelSnapshot ? `${machine.modelSnapshot.manufacturer} ${machine.modelSnapshot.modelName}` : '—' },
              { label: 'Machine type', value: machine.modelSnapshot ? titleCase(machine.modelSnapshot.machineType) : '—' },
              { label: 'Serial number', value: machine.serialNumber ?? '—' },
              { label: 'Location', value: formatLocation(machine.location) },
              { label: 'Open incidents', value: openIncidents.length },
              { label: 'Last maintenance', value: formatDate(machine.lastMaintenanceAt) },
              { label: 'Installed', value: formatDate(machine.installedAt, false) },
              { label: 'Commissioned', value: formatDate(machine.commissionedAt, false) },
            ]}
          />
          {machine.notes && (
            <>
              <h3 className="subsection">Notes</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{machine.notes}</p>
            </>
          )}
        </TabPanel>

        <TabPanel id="incidents" active={tab}>
          {incidents.length === 0 ? (
            <EmptyState title="No incidents" message="No incidents have been reported for this machine." icon="✓" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Title</th>
                    <th>Severity</th>
                    <th>Status</th>
                    <th>Reported</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.map((incident) => (
                    <tr key={incident.id}>
                      <td>
                        <Link to={`/incidents/${incident.id}`} className="mono">
                          {incident.incidentNumber}
                        </Link>
                      </td>
                      <td>{incident.title}</td>
                      <td><SeverityBadge status={incident.severity} size="sm" /></td>
                      <td><IncidentStatusBadge status={incident.status} size="sm" /></td>
                      <td>{formatDate(incident.createdAt, false)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>

        <TabPanel id="maintenance" active={tab}>
          {maintenance.length === 0 ? (
            <EmptyState
              title="No maintenance records"
              message="Completed maintenance for this machine will appear here."
              action={
                can('maintenance.create') ? (
                  <Link to={`/maintenance/new?machineId=${machine.id}`} className="btn btn--primary btn--sm">
                    Record maintenance
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Technician</th>
                  </tr>
                </thead>
                <tbody>
                  {maintenance.map((record) => (
                    <tr key={record.id}>
                      <td>{formatDate(record.performedAt, false)}</td>
                      <td>
                        <Link to={`/maintenance/${record.id}`}>{record.title}</Link>
                      </td>
                      <td>
                        <Badge presentation={maintenanceType(record.maintenanceType)} size="sm" />
                      </td>
                      <td>{record.performedByName ?? record.performedByExternal ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>

        <TabPanel id="manuals" active={tab}>
          {manuals.length === 0 ? (
            <EmptyState
              title="No manuals for this model"
              message="Upload a manual for this machine's model to power grounded troubleshooting answers."
              action={
                can('manual.create') ? (
                  <Link to={`/manuals/upload?modelId=${machine.machineModelId}`} className="btn btn--primary btn--sm">
                    Upload manual
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Version</th>
                    <th>Processing</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {manuals.map((manual) => (
                    <tr key={manual.id}>
                      <td>
                        <Link to={`/manuals/${manual.id}`}>{manual.title}</Link>
                      </td>
                      <td>{manual.documentVersion ?? '—'}</td>
                      <td>
                        <Badge presentation={processingStatus(manual.processingStatus)} size="sm" />
                      </td>
                      <td>{formatBytes(manual.fileSizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>

        <TabPanel id="conversations" active={tab}>
          {conversations.length === 0 ? (
            <EmptyState
              title="No troubleshooting conversations"
              message="Start a conversation scoped to this machine."
              icon="💬"
              action={
                can('conversation.create') ? (
                  <Link to={`/conversations/new?machineId=${machine.id}`} className="btn btn--primary btn--sm">
                    Start conversation
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Issue status</th>
                    <th>Messages</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {conversations.map((conversation) => (
                    <tr key={conversation.id}>
                      <td>
                        <Link to={`/conversations/${conversation.id}`}>
                          {conversation.title ?? 'Untitled conversation'}
                        </Link>
                      </td>
                      <td>{titleCase(conversation.issueStatus.replace(/_/g, ' '))}</td>
                      <td className="num">{conversation.messageCount}</td>
                      <td>{formatDate(conversation.lastMessageAt ?? conversation.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabPanel>

        <TabPanel id="timeline" active={tab}>
          {timeline.length === 0 ? (
            <EmptyState title="No activity yet" message="Maintenance and incident events will appear in the timeline." />
          ) : (
            <ol className="timeline" aria-label="Machine activity timeline">
              {timeline.map((event) => (
                <li key={event.id} className="timeline__item">
                  <span className={`timeline__dot timeline__dot--${event.kind}`} aria-hidden="true" />
                  <div className="timeline__body">
                    <p className="timeline__title">
                      {event.kind === 'incident' && event.incidentId ? (
                        <Link to={`/incidents/${event.incidentId}`}>{event.title}</Link>
                      ) : (
                        event.title
                      )}
                    </p>
                    <p className="timeline__meta">
                      {formatDate(event.at)} · {event.actorUsername ?? 'system'}
                      {event.maintenanceType ? ` · ${titleCase(event.maintenanceType.replace(/_/g, ' '))}` : ''}
                      {event.incidentNumber ? ` · ${event.incidentNumber}` : ''}
                    </p>
                    {event.note && <p className="timeline__note">{event.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </TabPanel>
      </Card>

      <div className="form-actions">
        <Link to="/machines" className="btn btn--ghost">
          ← Back to machines
        </Link>
        {can('incident.create') && (
          <Link to={`/incidents/new?machineId=${machine.id}`} className="btn btn--secondary">
            Report incident
          </Link>
        )}
        <Button variant="ghost" onClick={() => refetch()}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

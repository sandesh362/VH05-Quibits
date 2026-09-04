/**
 * Operational dashboard.
 *
 * Every metric here is DERIVED from existing list endpoints — there is no
 * metrics/analytics backend in this phase. We fetch the primary collections
 * (machines, incidents, maintenance, manuals, jobs, conversations) in parallel
 * and compute counts client-side. Metrics the backend cannot support are
 * simply absent rather than fabricated.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  apiClient,
  type ConversationSummary,
  type IncidentRecord,
  type MachineRecord,
  type MaintenanceRecord,
  type ManualRecord,
  type ProcessingJob,
} from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useAuth } from '../lib/auth';
import {
  Alert,
  Badge,
  Card,
  PageHeader,
  Skeleton,
  StatTile,
} from '../components/ui';
import { EmptyState, ErrorState } from '../components/states';
import { incidentStatus, jobStatus, processingStatus, severity } from '../lib/labels';
import { formatBytes, formatDate } from '../lib/format';
import './page.css';

interface DashboardData {
  machines: MachineRecord[];
  incidents: IncidentRecord[];
  maintenance: MaintenanceRecord[];
  manuals: ManualRecord[];
  jobs: ProcessingJob[];
  conversations: ConversationSummary[];
}

function sortByDateDesc<T>(items: T[], key: keyof T): T[] {
  return [...items].sort(
    (a, b) => new Date(String(b[key])).getTime() - new Date(String(a[key])).getTime(),
  );
}

export function DashboardPage(): JSX.Element {
  const { user } = useAuth();
  const { data, error, isInitialLoading, isLoading, refetch } = useApi<DashboardData>(
    async () => {
      const [machines, incidents, maintenance, manuals, jobs, conversations] =
        await Promise.all([
          apiClient.listMachines({ limit: 100 }).then((r) => r.data),
          apiClient.listIncidents({ limit: 100, sortBy: 'created_at', sortOrder: 'desc' }).then((r) => r.data),
          apiClient.listMaintenance({ limit: 100, sortBy: 'performed_at', sortOrder: 'desc' }).then((r) => r.data),
          apiClient.listManuals({ limit: 100, sortBy: 'createdAt', sortOrder: 'desc' }).then((r) => r.data),
          apiClient.listProcessingJobs({ limit: 50 }).then((r) => r.data),
          apiClient.listConversations({ limit: 100 }).then((r) => r.data),
        ]);
      return { machines, incidents, maintenance, manuals, jobs, conversations };
    },
    [],
  );

  const metrics = useMemo(() => {
    if (!data) return null;
    const openIncidents = data.incidents.filter(
      (i) => !['closed', 'cancelled'].includes(i.status),
    );
    const critical = openIncidents.filter((i) => i.severity === 'critical');
    const investigating = openIncidents.filter((i) => i.status === 'investigating');
    const recentlyResolved = data.incidents
      .filter((i) => i.status === 'resolved' || i.status === 'closed')
      .slice(0, 5);
    const activeJobs = data.jobs.filter((j) => ['queued', 'running', 'retrying'].includes(j.status));
    const failedJobs = data.jobs.filter((j) => j.status === 'failed');
    const processingManuals = data.manuals.filter((m) => m.processingStatus !== 'completed');
    // Machines with recurring incidents: more than one open incident OR any
    // incident whose issue status is recurring.
    const recurringMachineIds = new Set(
      data.incidents
        .filter((i) => i.issueStatus === 'recurring')
        .map((i) => i.machineId),
    );
    const openCountByMachine = new Map<string, number>();
    for (const incident of openIncidents) {
      openCountByMachine.set(incident.machineId, (openCountByMachine.get(incident.machineId) ?? 0) + 1);
    }
    const recurringMachines = data.machines.filter(
      (m) => recurringMachineIds.has(m.id) || (openCountByMachine.get(m.id) ?? 0) > 1,
    );
    return {
      openIncidents,
      critical,
      investigating,
      recentlyResolved,
      activeJobs,
      failedJobs,
      processingManuals,
      recurringMachines,
      recentMaintenance: data.maintenance.slice(0, 5),
      recentManuals: sortByDateDesc(data.manuals, 'createdAt').slice(0, 5),
      recentConversations: sortByDateDesc(
        data.conversations.filter((c) => c.status === 'active'),
        'updatedAt',
      ).slice(0, 5),
    };
  }, [data]);

  return (
    <div className="page">
      <PageHeader
        title={`Welcome${user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}`}
        description="Operational overview from your machines, incidents, maintenance and documents. No metric here is invented — everything comes from the current API."
        actions={
          <Link to="/incidents/new" className="btn btn--primary">
            Report incident
          </Link>
        }
        breadcrumbs={[{ label: 'Home', to: '/dashboard' }, { label: 'Dashboard' }]}
      />

      {isInitialLoading && (
        <Card>
          <Skeleton lines={6} />
        </Card>
      )}

      {error && !isInitialLoading && (
        <ErrorState error={error} onRetry={refetch} title="Could not load the dashboard" />
      )}

      {metrics && (
        <>
          {metrics.failedJobs.length > 0 && (
            <Alert tone="error">
              <strong>{metrics.failedJobs.length} document job(s) failed.</strong>{' '}
              <Link to="/jobs">Review processing jobs</Link> to retry or inspect errors.
            </Alert>
          )}

          <div className="stat-grid" aria-label="Key metrics" aria-live="polite">
            <StatTile label="Total machines" value={data?.machines.length ?? 0} icon="⚙" tone="info" to="/machines" />
            <StatTile
              label="Open incidents"
              value={metrics.openIncidents.length}
              icon="⚠"
              tone={metrics.openIncidents.length ? 'warn' : undefined}
              to="/incidents?status=open"
            />
            <StatTile
              label="Critical incidents"
              value={metrics.critical.length}
              icon="▇"
              tone={metrics.critical.length ? 'error' : undefined}
              to="/incidents?severity=critical"
            />
            <StatTile
              label="Investigating"
              value={metrics.investigating.length}
              icon="▶"
              tone="info"
              to="/incidents?status=investigating"
            />
            <StatTile
              label="Recurring-issue machines"
              value={metrics.recurringMachines.length}
              icon="↻"
              tone={metrics.recurringMachines.length ? 'warn' : undefined}
            />
            <StatTile
              label="Manuals processing"
              value={metrics.processingManuals.length}
              icon="◷"
              tone={metrics.activeJobs.length ? 'info' : undefined}
              to="/jobs"
            />
            <StatTile label="Maintenance records" value={data?.maintenance.length ?? 0} icon="🔧" to="/maintenance" />
            <StatTile label="Manuals indexed" value={data?.manuals.filter((m) => m.isSearchable).length ?? 0} icon="📄" to="/manuals" />
          </div>

          <div className="dashboard-grid">
            <Card className="dashboard-card" labelledBy="dash-incidents">
              <div className="section-head">
                <h2 id="dash-incidents">Critical &amp; open incidents</h2>
                <Link to="/incidents" className="btn btn--ghost btn--sm">
                  View all
                </Link>
              </div>
              {metrics.openIncidents.length === 0 ? (
                <EmptyState title="No open incidents" message="The fleet has no open incidents right now." icon="✓" />
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Number</th>
                        <th>Title</th>
                        <th>Severity</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...metrics.openIncidents]
                        .sort((a, b) => {
                          const order = { critical: 0, high: 1, medium: 2, low: 3 };
                          return (
                            (order[a.severity as keyof typeof order] ?? 9) -
                            (order[b.severity as keyof typeof order] ?? 9)
                          );
                        })
                        .slice(0, 6)
                        .map((incident) => (
                          <tr key={incident.id}>
                            <td>
                              <Link to={`/incidents/${incident.id}`} className="mono">
                                {incident.incidentNumber}
                              </Link>
                            </td>
                            <td>{incident.title}</td>
                            <td>
                              <Badge presentation={severity(incident.severity)} size="sm" />
                            </td>
                            <td>
                              <Badge presentation={incidentStatus(incident.status)} size="sm" />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="dashboard-card" labelledBy="dash-jobs">
              <div className="section-head">
                <h2 id="dash-jobs">Document processing</h2>
                <Link to="/jobs" className="btn btn--ghost btn--sm">
                  All jobs
                </Link>
              </div>
              {metrics.activeJobs.length === 0 && metrics.processingManuals.length === 0 ? (
                <EmptyState
                  title="No documents processing"
                  message="Uploaded manuals finish processing here. Upload a manual to get started."
                  icon="📄"
                  action={
                    <Link to="/manuals/upload" className="btn btn--primary btn--sm">
                      Upload manual
                    </Link>
                  }
                />
              ) : (
                <ul className="dash-list">
                  {metrics.activeJobs.slice(0, 5).map((job) => (
                    <li key={job.id} className="dash-list__item">
                      <Badge presentation={jobStatus(job.status)} size="sm" />
                      <span className="dash-list__text">
                        {job.currentStage ?? job.jobType} · {job.progressPercent}%
                      </span>
                    </li>
                  ))}
                  {metrics.failedJobs.slice(0, 3).map((job) => (
                    <li key={`f-${job.id}`} className="dash-list__item">
                      <Badge presentation={jobStatus(job.status)} size="sm" />
                      <span className="dash-list__text">
                        {job.errorMessage ?? 'Processing failed'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="dashboard-card" labelledBy="dash-maintenance">
              <div className="section-head">
                <h2 id="dash-maintenance">Recent maintenance</h2>
                <Link to="/maintenance" className="btn btn--ghost btn--sm">
                  View all
                </Link>
              </div>
              {metrics.recentMaintenance.length === 0 ? (
                <EmptyState title="No maintenance records" message="Completed maintenance work appears here." />
              ) : (
                <ul className="dash-list">
                  {metrics.recentMaintenance.map((record) => (
                    <li key={record.id} className="dash-list__item">
                      <span className="dash-list__date">{formatDate(record.performedAt, false)}</span>
                      <span className="dash-list__text">
                        <Link to={`/maintenance/${record.id}`}>{record.title}</Link>
                        <span className="muted"> · {record.machineLabel ?? record.machineId}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="dashboard-card" labelledBy="dash-manuals">
              <div className="section-head">
                <h2 id="dash-manuals">Recently uploaded manuals</h2>
                <Link to="/manuals" className="btn btn--ghost btn--sm">
                  All manuals
                </Link>
              </div>
              {metrics.recentManuals.length === 0 ? (
                <EmptyState title="No manuals yet" message="Upload an OEM manual to power troubleshooting answers." />
              ) : (
                <ul className="dash-list">
                  {metrics.recentManuals.map((manual) => (
                    <li key={manual.id} className="dash-list__item">
                      <Badge presentation={processingStatus(manual.processingStatus)} size="sm" />
                      <span className="dash-list__text">
                        <Link to={`/manuals/${manual.id}`}>{manual.title}</Link>
                        <span className="muted"> · {formatBytes(manual.fileSizeBytes)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="dashboard-card dashboard-card--wide" labelledBy="dash-conversations">
              <div className="section-head">
                <h2 id="dash-conversations">Recent troubleshooting activity</h2>
                <Link to="/conversations" className="btn btn--ghost btn--sm">
                  All conversations
                </Link>
              </div>
              {metrics.recentConversations.length === 0 ? (
                <EmptyState
                  title="No active conversations"
                  message="Start a troubleshooting conversation scoped to a machine."
                  icon="💬"
                  action={
                    <Link to="/conversations/new" className="btn btn--primary btn--sm">
                      New conversation
                    </Link>
                  }
                />
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Topic</th>
                        <th>Machine</th>
                        <th>Messages</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.recentConversations.map((conversation) => (
                        <tr key={conversation.id}>
                          <td>
                            <Link to={`/conversations/${conversation.id}`}>
                              {conversation.title ?? 'Untitled conversation'}
                            </Link>
                          </td>
                          <td>{conversation.machineLabel ?? '—'}</td>
                          <td className="num">{conversation.messageCount}</td>
                          <td>{formatDate(conversation.lastMessageAt ?? conversation.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          {isLoading && !isInitialLoading && (
            <p className="page__note" role="status">
              Refreshing…
            </p>
          )}
        </>
      )}
    </div>
  );
}

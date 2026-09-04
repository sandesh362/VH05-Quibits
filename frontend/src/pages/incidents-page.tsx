/**
 * Incident list: search, filters, pagination, status/severity badges.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/use-api';
import { apiClient, type IncidentRecord } from '../lib/api-client';
import {
  IncidentStatusBadge,
  IssueStatusBadge,
  RootCauseStatusBadge,
  SeverityBadge,
} from '../components/incident-badges';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import './page.css';

const PAGE_SIZE = 10;

const STATUS_OPTIONS = [
  'open', 'investigating', 'waiting_for_information', 'waiting_for_parts',
  'resolved', 'closed', 'reopened', 'cancelled',
];
const ISSUE_OPTIONS = ['unknown', 'investigating', 'temporary_fix', 'resolved', 'unresolved', 'recurring', 'escalated'];
const SEVERITY_OPTIONS = ['low', 'medium', 'high', 'critical'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'];
const ROOT_CAUSE_OPTIONS = ['unknown', 'suspected', 'confirmed', 'rejected'];
const SOURCE_OPTIONS = ['conversation', 'manual', 'import', 'other'];

interface Filters {
  search: string;
  status: string;
  issueStatus: string;
  severity: string;
  priority: string;
  rootCauseStatus: string;
  source: string;
  sortBy: string;
  sortOrder: 'desc' | 'asc';
}

const DEFAULT_FILTERS: Filters = {
  search: '',
  status: '',
  issueStatus: '',
  severity: '',
  priority: '',
  rootCauseStatus: '',
  source: '',
  sortBy: 'createdAt',
  sortOrder: 'desc',
};

function sortKey(filter: string): string {
  switch (filter) {
    case 'createdAt': return 'created_at';
    case 'updatedAt': return 'updated_at';
    case 'observedAt': return 'first_observed_at';
    case 'severity': return 'severity';
    case 'priority': return 'priority';
    case 'status': return 'status';
    default: return 'created_at';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function IncidentsPage(): JSX.Element {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [applied, setApplied] = useState<Filters>(DEFAULT_FILTERS);
  const [pagination, setPagination] = useState<{ page: number; totalPages: number; total: number }>({
    page: 1, totalPages: 0, total: 0,
  });

  const query = useMemo(() => ({
    search: applied.search || undefined,
    status: applied.status || undefined,
    issueStatus: applied.issueStatus || undefined,
    severity: applied.severity || undefined,
    priority: applied.priority || undefined,
    rootCauseStatus: applied.rootCauseStatus || undefined,
    source: applied.source || undefined,
    sortBy: sortKey(applied.sortBy),
    sortOrder: applied.sortOrder,
    page,
    limit: PAGE_SIZE,
  }), [applied, page]);

  const fetcher = useCallback(
    () =>
      apiClient.listIncidents(query).then((result) => {
        setPagination(result.meta?.pagination ?? { page: 1, totalPages: 0, total: 0 });
        return result.data;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(query)],
  );

  const { data, error, isLoading, refetch } = useApi<IncidentRecord[]>(fetcher);

  function updateFilter(key: keyof Filters, value: string): void {
    setFilters((previous) => ({ ...previous, [key]: value }));
  }

  function applyFilters(): void {
    setPage(1);
    setApplied(filters);
  }

  function toggleSort(field: keyof Filters): void {
    setFilters((previous) => ({
      ...previous,
      sortBy: field,
      sortOrder: previous.sortBy === field && previous.sortOrder === 'desc' ? 'asc' : 'desc',
    }));
    setApplied((previous) => ({
      ...previous,
      sortBy: field,
      sortOrder: previous.sortBy === field && previous.sortOrder === 'desc' ? 'asc' : 'desc',
    }));
  }

  const activeFilters = (['status', 'issueStatus', 'severity', 'priority', 'rootCauseStatus', 'source'] as const).filter(
    (key) => applied[key] !== '',
  ).length;

  return (
    <div className="page">
      <header className="page__header">
        <div className="page__header--row">
          <div>
            <h1>Incidents</h1>
            <p className="page__lead">
              Reported machine problems, their investigation, and their confirmed outcomes.
            </p>
          </div>
          <Link className="button" to="/incidents/new">
            + Report incident
          </Link>
        </div>
      </header>

      <section className="card" aria-label="Incident filters">
        <form
          className="incident-filters"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
        >
          <label className="field incident-filters__search">
            <span className="field__label">Search</span>
            <input
              type="search"
              value={filters.search}
              onChange={(event) => updateFilter('search', event.target.value)}
              placeholder="Title, description, error code, tag…"
            />
          </label>
          <label className="field">
            <span className="field__label">Status</span>
            <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
              <option value="">Any</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>{option.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Issue status</span>
            <select value={filters.issueStatus} onChange={(event) => updateFilter('issueStatus', event.target.value)}>
              <option value="">Any</option>
              {ISSUE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Severity</span>
            <select value={filters.severity} onChange={(event) => updateFilter('severity', event.target.value)}>
              <option value="">Any</option>
              {SEVERITY_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Priority</span>
            <select value={filters.priority} onChange={(event) => updateFilter('priority', event.target.value)}>
              <option value="">Any</option>
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Root cause</span>
            <select value={filters.rootCauseStatus} onChange={(event) => updateFilter('rootCauseStatus', event.target.value)}>
              <option value="">Any</option>
              {ROOT_CAUSE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Source</span>
            <select value={filters.source} onChange={(event) => updateFilter('source', event.target.value)}>
              <option value="">Any</option>
              {SOURCE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="button">Apply filters</button>
          {activeFilters > 0 && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
                setApplied(DEFAULT_FILTERS);
                setPage(1);
              }}
            >
              Clear
            </button>
          )}
        </form>
      </section>

      <section className="card" aria-label="Incident results">
        {isLoading && <LoadingState message="Loading incidents…" />}
        {!isLoading && error && <ErrorState error={error} onRetry={refetch} title="Could not load incidents" />}
        {!isLoading && !error && data && data.length === 0 && (
          <EmptyState
            title="No incidents match"
            message={
              activeFilters > 0 || applied.search
                ? 'Try different filters, or clear them to see everything.'
                : 'No incidents have been reported yet. Report one to start building historical memory.'
            }
            action={
              <Link className="button" to="/incidents/new">+ Report incident</Link>
            }
          />
        )}
        {!isLoading && !error && data && data.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="incident-table">
                <thead>
                  <tr>
                    <th>Incident</th>
                    <th>
                      <button type="button" className="link-button" onClick={() => toggleSort('status')}>
                        Status{applied.sortBy === 'status' ? (applied.sortOrder === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="link-button" onClick={() => toggleSort('severity')}>
                        Severity{applied.sortBy === 'severity' ? (applied.sortOrder === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                    <th>Root cause</th>
                    <th>Machine</th>
                    <th>Reported</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((incident) => (
                    <tr key={incident.id} data-testid={`incident-row-${incident.incidentNumber}`}>
                      <td>
                        <div className="incident-table__title">
                          <Link to={`/incidents/${incident.id}`}>{incident.title}</Link>
                        </div>
                        <div className="incident-table__meta">
                          {incident.incidentNumber}
                          {incident.errorCodes.length > 0 && (
                            <> · {incident.errorCodes.join(', ')}</>
                          )}
                        </div>
                      </td>
                      <td>
                        <IncidentStatusBadge status={incident.status} size="sm" />
                        <div style={{ marginTop: 4 }}>
                          <IssueStatusBadge status={incident.issueStatus} size="sm" />
                        </div>
                      </td>
                      <td><SeverityBadge status={incident.severity} size="sm" /></td>
                      <td><RootCauseStatusBadge status={incident.rootCause.status} size="sm" /></td>
                      <td>
                        {incident.machineLabel ?? incident.machineId.slice(-6)}
                        {incident.machineModelLabel && (
                          <div className="incident-table__meta">{incident.machineModelLabel}</div>
                        )}
                      </td>
                      <td>{formatDate(incident.firstObservedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination" role="navigation" aria-label="Pagination">
              <span className="pagination__info">
                Page {pagination.page} of {pagination.totalPages} · {pagination.total} incidents
              </span>
              <div className="pagination__controls">
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

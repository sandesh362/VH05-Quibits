/**
 * Maintenance history: structured records of work performed on machines.
 *
 * Phase 7 treats maintenance as the third evidence class: separate from
 * manuals and incidents, and never evidence of causation. This page lists
 * and filters the records; the machine timeline merges them with incidents.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/use-api';
import { apiClient, type MaintenanceRecord, type MachineRecord } from '../lib/api-client';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import './page.css';

const PAGE_SIZE = 10;

const MAINTENANCE_TYPES = [
  'preventive',
  'corrective',
  'inspection',
  'part_replacement',
  'calibration',
  'other',
];

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function MaintenancePage(): JSX.Element {
  const [page, setPage] = useState(1);
  const [machineId, setMachineId] = useState('');
  const [maintenanceType, setMaintenanceType] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState({ machineId: '', maintenanceType: '', search: '' });
  const [pagination, setPagination] = useState({ page: 1, totalPages: 0, total: 0 });

  const machines = useApi<MachineRecord[]>(() => apiClient.listMachines().then((r) => r.data));

  const query = useMemo(
    () => ({
      machineId: applied.machineId || undefined,
      maintenanceType: applied.maintenanceType || undefined,
      search: applied.search || undefined,
      sortBy: 'performed_at',
      sortOrder: 'desc' as const,
      page,
      limit: PAGE_SIZE,
    }),
    [applied, page],
  );

  const fetcher = useCallback(
    () =>
      apiClient.listMaintenance(query).then((result) => {
        setPagination(result.meta?.pagination ?? { page: 1, totalPages: 0, total: 0 });
        return result.data;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(query)],
  );

  const { data, error, isLoading, refetch } = useApi<MaintenanceRecord[]>(fetcher);

  return (
    <div className="page">
      <header className="page__header">
        <div className="page__header--row">
          <div>
            <h1>Maintenance history</h1>
            <p className="page__lead">
              Structured records of work performed on machines. Maintenance is noted context —
              it never proves what caused a fault.
            </p>
          </div>
          <Link className="button" to="/maintenance/new">
            + Record maintenance
          </Link>
        </div>
      </header>

      <section className="card" aria-label="Maintenance filters">
        <form
          className="incident-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setApplied({ machineId, maintenanceType, search });
          }}
        >
          <label className="field incident-filters__search">
            <span className="field__label">Search</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Title or work order reference…"
            />
          </label>
          <label className="field">
            <span className="field__label">Machine</span>
            <select value={machineId} onChange={(event) => setMachineId(event.target.value)}>
              <option value="">Any machine</option>
              {(machines.data ?? []).map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.displayName || machine.assetTag}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Type</span>
            <select value={maintenanceType} onChange={(event) => setMaintenanceType(event.target.value)}>
              <option value="">Any type</option>
              {MAINTENANCE_TYPES.map((type) => (
                <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="button">Apply filters</button>
          {(applied.machineId || applied.maintenanceType || applied.search) && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setMachineId('');
                setMaintenanceType('');
                setSearch('');
                setApplied({ machineId: '', maintenanceType: '', search: '' });
                setPage(1);
              }}
            >
              Clear
            </button>
          )}
        </form>
      </section>

      <section className="card" aria-label="Maintenance records">
        {isLoading && <LoadingState message="Loading maintenance records…" />}
        {!isLoading && error && (
          <ErrorState error={error} onRetry={refetch} title="Could not load maintenance records" />
        )}
        {!isLoading && !error && data && data.length === 0 && (
          <EmptyState
            title="No maintenance records match"
            message="Record the first one to start the machine's maintenance history."
            action={<Link className="button" to="/maintenance/new">+ Record maintenance</Link>}
          />
        )}
        {!isLoading && !error && data && data.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="incident-table">
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Type</th>
                    <th>Machine</th>
                    <th>Performed</th>
                    <th>Parts</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((record) => (
                    <tr key={record.id} data-testid={`maintenance-row-${record.id}`}>
                      <td>
                        <div className="incident-table__title">{record.title}</div>
                        <div className="incident-table__meta">
                          {record.workOrderRef ? `WO ${record.workOrderRef}` : 'No work order'}
                          {record.relatedIncidentId && (
                            <> · <Link to={`/incidents/${record.relatedIncidentId}`}>linked incident</Link></>
                          )}
                        </div>
                      </td>
                      <td>{record.maintenanceType.replace(/_/g, ' ')}</td>
                      <td>
                        <Link to={`/machines/${record.machineId}`}>machine</Link>
                      </td>
                      <td>{formatDate(record.performedAt)}</td>
                      <td>
                        {record.partsReplaced.length > 0
                          ? record.partsReplaced.map((part) => part.partNumber).join(', ')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination" role="navigation" aria-label="Pagination">
              <span className="pagination__info">
                Page {pagination.page} of {pagination.totalPages} · {pagination.total} records
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

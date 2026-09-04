/**
 * Maintenance history list.
 *
 * Structured records of work performed. Maintenance is supplementary context
 * only — it never proves what caused a fault (the safety footer reminds of
 * this). Search + machine/type filters + pagination, all from existing
 * endpoints.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MAINTENANCE_TYPES } from '@itp/shared';
import { useApi } from '../lib/use-api';
import { apiClient, type MachineRecord, type MaintenanceRecord, type UserRecord } from '../lib/api-client';
import { useAuth } from '../lib/auth';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { formatDate, titleCase } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  SelectInput,
  SkeletonTable,
  TextInput,
} from '../components/ui';
import { ErrorState } from '../components/states';
import { maintenanceType } from '../lib/labels';
import './page.css';

const PAGE_SIZE = 15;

export function MaintenancePage(): JSX.Element {
  const { can } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [machineId, setMachineId] = useState(
    () => new URLSearchParams(window.location.search).get('machineId') ?? '',
  );
  const [maintenanceTypeFilter, setMaintenanceTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 0, total: 0 });

  const machines = useApi<MachineRecord[]>(
    () => apiClient.listMachines({ limit: 100 }).then((r) => r.data),
    [],
  );
  const users = useApi<UserRecord[]>(
    () => (can('user.read_all') ? apiClient.listUsers().then((r) => r.users) : Promise.resolve([])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const query = useMemo(
    () => ({
      machineId: machineId || undefined,
      maintenanceType: maintenanceTypeFilter || undefined,
      search: search || undefined,
      sortBy: 'performed_at',
      sortOrder: 'desc' as const,
      page,
      limit: PAGE_SIZE,
    }),
    [machineId, maintenanceTypeFilter, search, page],
  );

  const { data, error, isLoading, refetch } = useApi<MaintenanceRecord[]>(
    () =>
      apiClient.listMaintenance(query).then((result) => {
        setPagination(result.meta?.pagination ?? { page: 1, totalPages: 0, total: result.data.length });
        return result.data;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(query)],
  );

  const machineLabel = (id: string): string => {
    const machine = machines.data?.find((m) => m.id === id);
    return machine ? machine.displayName ?? machine.assetTag : `…${id.slice(-6)}`;
  };
  const technicianLabel = (record: MaintenanceRecord): string =>
    record.performedByName ??
    record.performedByExternal ??
    users.data?.find((u) => u.id === record.performedBy)?.fullName ??
    '—';

  return (
    <div className="page">
      <PageHeader
        title="Maintenance history"
        description="Structured records of work performed on machines. Maintenance is supplementary context — it never proves what caused a fault."
        breadcrumbs={[{ label: 'Maintenance' }]}
        actions={
          can('maintenance.create') ? (
            <Link to="/maintenance/new" className="btn btn--primary">
              Record maintenance
            </Link>
          ) : null
        }
      />

      <Card>
        <form className="filter-bar" role="search" onSubmit={(e) => e.preventDefault()}>
          <div className="field field--search">
            <label className="field__label" htmlFor="maintenance-search">Search</label>
            <TextInput
              id="maintenance-search"
              type="search"
              placeholder="Title, work order, part number…"
              value={searchInput}
              onChange={(e) => { setPage(1); setSearchInput(e.target.value); }}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="maintenance-machine">Machine</label>
            <SelectInput
              id="maintenance-machine"
              value={machineId}
              onChange={(e) => { setPage(1); setMachineId(e.target.value); }}
            >
              <option value="">Any machine</option>
              {(machines.data ?? []).map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.displayName ?? machine.assetTag}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="maintenance-type">Type</label>
            <SelectInput
              id="maintenance-type"
              value={maintenanceTypeFilter}
              onChange={(e) => { setPage(1); setMaintenanceTypeFilter(e.target.value); }}
            >
              <option value="">Any type</option>
              {MAINTENANCE_TYPES.map((type) => (
                <option key={type} value={type}>{titleCase(type.replace(/_/g, ' '))}</option>
              ))}
            </SelectInput>
          </div>
          <div className="filter-actions">
            <Button
              variant="ghost"
              onClick={() => { setSearchInput(''); setMachineId(''); setMaintenanceTypeFilter(''); setPage(1); }}
            >
              Clear
            </Button>
          </div>
        </form>

        {isLoading && <SkeletonTable rows={8} cols={6} />}
        {!isLoading && error && <ErrorState error={error} onRetry={refetch} title="Could not load maintenance records" />}
        {!isLoading && !error && data && data.length === 0 && (
          <EmptyState
            title="No maintenance records found"
            message="Record the first piece of completed work to start building maintenance history."
            icon="🔧"
            action={
              can('maintenance.create') ? (
                <Link to="/maintenance/new" className="btn btn--primary btn--sm">Record maintenance</Link>
              ) : undefined
            }
          />
        )}

        {!isLoading && !error && data && data.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Type</th>
                    <th>Machine</th>
                    <th>Technician</th>
                    <th>Performed</th>
                    <th>Parts</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((record) => (
                    <tr key={record.id} data-testid={`maintenance-row-${record.id}`}>
                      <td>
                        <Link to={`/maintenance/${record.id}`}>{record.title}</Link>
                        <div className="muted" style={{ fontSize: '0.78rem' }}>
                          {record.workOrderRef ? `WO ${record.workOrderRef}` : 'No work order'}
                          {record.relatedIncidentId && (
                            <> · <Link to={`/incidents/${record.relatedIncidentId}`}>linked incident</Link></>
                          )}
                        </div>
                      </td>
                      <td><Badge presentation={maintenanceType(record.maintenanceType)} size="sm" /></td>
                      <td>
                        <Link to={`/machines/${record.machineId}`}>{machineLabel(record.machineId)}</Link>
                      </td>
                      <td>{technicianLabel(record)}</td>
                      <td>{formatDate(record.performedAt)}</td>
                      <td>
                        {record.partsReplaced.length > 0 ? (
                          <span className="tag-list">
                            {record.partsReplaced.slice(0, 2).map((part) => (
                              <span key={part.partNumber} className="tag">{part.partNumber}</span>
                            ))}
                            {record.partsReplaced.length > 2 && (
                              <span className="tag">+{record.partsReplaced.length - 2}</span>
                            )}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={pagination.page}
              totalPages={pagination.totalPages}
              total={pagination.total}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </div>
  );
}

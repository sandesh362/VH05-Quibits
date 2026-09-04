/**
 * Machines list: search, status/model filters, pagination, create action.
 *
 * Backend supports `search`, `status`, `machineModelId`, `criticality` and
 * pagination meta; we keep filters in URL-independent local state and apply
 * them on submit (debounced search), the same pattern as the incident list.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MACHINE_STATUSES } from '@itp/shared';
import { apiClient, type MachineModelRecord, type MachineRecord } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useAuth } from '../lib/auth';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { titleCase, formatLocation } from '../lib/format';
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
import { machineStatus, severity } from '../lib/labels';
import './page.css';

const PAGE_SIZE = 15;

export function MachinesPage(): JSX.Element {
  const { can } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [statusFilter, setStatusFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 0, total: 0 });

  const { data: models } = useApi<MachineModelRecord[]>(
    () => apiClient.listModels({ limit: 100 }).then((r) => r.data),
    [],
  );

  const query = useMemo(
    () => ({
      search: search || undefined,
      status: statusFilter || undefined,
      machineModelId: modelFilter || undefined,
      page,
      limit: PAGE_SIZE,
    }),
    [search, statusFilter, modelFilter, page],
  );

  const { data, error, isLoading, refetch } = useApi<MachineRecord[]>(
    () =>
      apiClient
        .listMachines(query)
        .then((r) => {
          setPagination(
            r.meta?.pagination ?? { page: 1, totalPages: 0, total: r.data.length },
          );
          return r.data;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(query)],
  );

  return (
    <div className="page">
      <PageHeader
        title="Machines"
        description="Physical assets across the organization. Open a machine for its incidents, maintenance and activity timeline."
        breadcrumbs={[{ label: 'Machines' }]}
        actions={
          can('machine.create') ? (
            <Link to="/machines/new" className="btn btn--primary">
              Register machine
            </Link>
          ) : null
        }
      />

      <Card>
        <form
          className="filter-bar"
          role="search"
          onSubmit={(e) => e.preventDefault()}
        >
          <div className="field field--search">
            <label className="field__label" htmlFor="machine-search">
              Search
            </label>
            <TextInput
              id="machine-search"
              type="search"
              placeholder="Asset tag, serial or name…"
              value={searchInput}
              onChange={(e) => {
                setPage(1);
                setSearchInput(e.target.value);
              }}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="machine-status-filter">
              Status
            </label>
            <SelectInput
              id="machine-status-filter"
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value);
              }}
            >
              <option value="">All statuses</option>
              {MACHINE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {titleCase(status)}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="machine-model-filter">
              Model
            </label>
            <SelectInput
              id="machine-model-filter"
              value={modelFilter}
              onChange={(e) => {
                setPage(1);
                setModelFilter(e.target.value);
              }}
            >
              <option value="">All models</option>
              {(models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.manufacturer} {model.modelName}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="filter-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setSearchInput('');
                setStatusFilter('');
                setModelFilter('');
                setPage(1);
              }}
            >
              Clear
            </Button>
          </div>
        </form>

        {isLoading && <SkeletonTable rows={8} cols={5} />}
        {!isLoading && error && (
          <ErrorState error={error} onRetry={refetch} title="Could not load machines" />
        )}
        {!isLoading && !error && data && data.length === 0 && (
          <EmptyState
            title="No machines found"
            message={
              search || statusFilter || modelFilter
                ? 'No machines match your filters. Adjust the search or clear filters.'
                : 'Register a machine model first, then register a machine against it.'
            }
            action={
              can('machine.create') ? (
                <Link to="/machines/new" className="btn btn--primary btn--sm">
                  Register machine
                </Link>
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
                    <th>Asset tag</th>
                    <th>Name</th>
                    <th>Model</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Criticality</th>
                    <th className="num">Open incidents</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((machine) => (
                    <tr key={machine.id} data-testid={`machine-row-${machine.assetTag}`}>
                      <td>
                        <Link to={`/machines/${machine.id}`} className="mono">
                          {machine.assetTag}
                        </Link>
                      </td>
                      <td>{machine.displayName ?? '—'}</td>
                      <td>
                        {machine.modelSnapshot
                          ? `${machine.modelSnapshot.manufacturer} ${machine.modelSnapshot.modelName}`
                          : '—'}
                      </td>
                      <td>{formatLocation(machine.location)}</td>
                      <td>
                        <Badge presentation={machineStatus(machine.status)} size="sm" />
                      </td>
                      <td>{machine.criticality ? <Badge presentation={severity(machine.criticality)} size="sm" /> : '—'}</td>
                      <td className="num">
                        {machine.openIncidentCount > 0 ? (
                          <strong style={{ color: 'var(--color-warn)' }}>{machine.openIncidentCount}</strong>
                        ) : (
                          0
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

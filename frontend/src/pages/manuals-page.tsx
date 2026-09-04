/**
 * Manuals list.
 *
 * Search + filters (model, processing status, document type), pagination,
 * and explicit searchable state: a manual is only presented as ready for
 * troubleshooting when `isSearchable` is true (backend-confirmed completed
 * processing with indexed chunks).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DOCUMENT_TYPES, PROCESSING_STATUSES } from '@itp/shared';
import { apiClient, type MachineModelRecord, type ManualRecord } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useAuth } from '../lib/auth';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { formatBytes, formatDate, titleCase } from '../lib/format';
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
import { processingStatus } from '../lib/labels';
import './page.css';

const PAGE_SIZE = 15;

export function ManualsPage(): JSX.Element {
  const { can } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [modelFilter, setModelFilter] = useState(() => {
    return new URLSearchParams(window.location.search).get('modelId') ?? '';
  });
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 0, total: 0 });

  const { data: models } = useApi<MachineModelRecord[]>(
    () => apiClient.listModels({ limit: 100 }).then((r) => r.data),
    [],
  );

  const query = useMemo(
    () => ({
      search: search || undefined,
      machineModelId: modelFilter || undefined,
      processingStatus: statusFilter || undefined,
      documentType: typeFilter || undefined,
      page,
      limit: PAGE_SIZE,
      sortBy: 'created_at',
      sortOrder: 'desc',
    }),
    [search, modelFilter, statusFilter, typeFilter, page],
  );

  const { data, error, isLoading, refetch } = useApi<ManualRecord[]>(
    () =>
      apiClient.listManuals(query).then((r) => {
        setPagination(r.meta?.pagination ?? { page: 1, totalPages: 0, total: r.data.length });
        return r.data;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(query)],
  );

  return (
    <div className="page">
      <PageHeader
        title="Manuals & documents"
        description="OEM manuals and supporting documents. A document only powers troubleshooting answers after processing and indexing complete successfully."
        breadcrumbs={[{ label: 'Manuals' }]}
        actions={
          can('manual.create') ? (
            <Link to="/manuals/upload" className="btn btn--primary">
              Upload manual
            </Link>
          ) : null
        }
      />

      <Card>
        <form className="filter-bar" role="search" onSubmit={(e) => e.preventDefault()}>
          <div className="field field--search">
            <label className="field__label" htmlFor="manual-search">Search</label>
            <TextInput
              id="manual-search"
              type="search"
              placeholder="Title, document number…"
              value={searchInput}
              onChange={(e) => { setPage(1); setSearchInput(e.target.value); }}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="manual-model">Model</label>
            <SelectInput
              id="manual-model"
              value={modelFilter}
              onChange={(e) => { setPage(1); setModelFilter(e.target.value); }}
            >
              <option value="">All models</option>
              {(models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.manufacturer} {model.modelName}
                </option>
              ))}
            </SelectInput>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="manual-status">Processing</label>
            <SelectInput
              id="manual-status"
              value={statusFilter}
              onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }}
            >
              <option value="">Any status</option>
              {PROCESSING_STATUSES.map((status) => (
                <option key={status} value={status}>{titleCase(status.replace(/_/g, ' '))}</option>
              ))}
            </SelectInput>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="manual-type">Type</label>
            <SelectInput
              id="manual-type"
              value={typeFilter}
              onChange={(e) => { setPage(1); setTypeFilter(e.target.value); }}
            >
              <option value="">All types</option>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>{titleCase(type.replace(/_/g, ' '))}</option>
              ))}
            </SelectInput>
          </div>
          <div className="filter-actions">
            <Button
              variant="ghost"
              onClick={() => { setSearchInput(''); setModelFilter(''); setStatusFilter(''); setTypeFilter(''); setPage(1); }}
            >
              Clear
            </Button>
          </div>
        </form>

        {isLoading && <SkeletonTable rows={8} cols={6} />}
        {!isLoading && error && <ErrorState error={error} onRetry={refetch} title="Could not load manuals" />}
        {!isLoading && !error && data && data.length === 0 && (
          <EmptyState
            title="No manuals found"
            message={search || modelFilter || statusFilter ? 'No documents match your filters.' : 'Upload a PDF manual to start grounding troubleshooting answers.'}
            icon="📄"
            action={
              can('manual.create') ? (
                <Link to="/manuals/upload" className="btn btn--primary btn--sm">Upload manual</Link>
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
                    <th>Title</th>
                    <th>Model</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th className="num">Pages</th>
                    <th className="num">Size</th>
                    <th>Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((manual) => (
                    <tr key={manual.id}>
                      <td>
                        <Link to={`/manuals/${manual.id}`}>{manual.title}</Link>
                        {!manual.isCurrentVersion && (
                          <span className="muted" style={{ marginLeft: 6, fontSize: '0.75rem' }}>
                            (superseded)
                          </span>
                        )}
                      </td>
                      <td>
                        {manual.machineModelLabel
                          ?? (models ?? []).find((m) => m.id === manual.machineModelId)
                            ? `${(models ?? []).find((m) => m.id === manual.machineModelId)?.manufacturer} ${(models ?? []).find((m) => m.id === manual.machineModelId)?.modelName}`
                            : '—'}
                      </td>
                      <td className="mono">{manual.documentVersion ?? manual.revision ?? '—'}</td>
                      <td>
                        <Badge presentation={processingStatus(manual.processingStatus)} size="sm" />
                        {manual.isSearchable && (
                          <span className="muted" style={{ marginLeft: 6, fontSize: '0.72rem' }}>
                            {manual.indexedChunkCount} chunks
                          </span>
                        )}
                      </td>
                      <td className="num">{manual.pageCount ?? '—'}</td>
                      <td className="num">{formatBytes(manual.fileSizeBytes)}</td>
                      <td>{formatDate(manual.createdAt, false)}</td>
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

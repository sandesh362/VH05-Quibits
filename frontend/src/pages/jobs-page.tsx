/**
 * Manual processing jobs (Phase 8): the admin jobs page.
 *
 * Read-only for everyone with manual.read; the retry action requires
 * manual.reprocess (admin/manager) and the backend enforces it - the button
 * is hidden otherwise, and a 403 still renders honestly if it races.
 */
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/use-api';
import { apiClient, type ProcessingJob } from '../lib/api-client';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { StatusBadge } from '../components/status-badge';
import './page.css';

function jobTone(status: string): 'ok' | 'degraded' | 'down' | 'disabled' | 'unknown' {
  if (status === 'completed') return 'ok';
  if (status === 'processing' || status === 'queued') return 'degraded';
  if (status === 'failed') return 'down';
  if (status === 'cancelled') return 'disabled';
  return 'unknown';
}

export function JobsPage(): JSX.Element {
  const { user } = useAuth();
  const canReprocess = user?.role === 'admin' || user?.role === 'manager';

  const jobs = useApi<ProcessingJob[]>(() => apiClient.listProcessingJobs().then((r) => r.data), [], 10_000);

  async function retry(job: ProcessingJob): Promise<void> {
    try {
      await apiClient.retryProcessingJob(job.id);
      jobs.refetch();
    } catch {
      jobs.refetch();
    }
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1>Manual processing jobs</h1>
        <p className="page__lead">
          Indexing and processing work for uploaded manuals. Read-only for technicians; retry
          requires a manager.
        </p>
      </header>

      <section className="card" aria-label="Processing jobs">
        {jobs.isInitialLoading && <LoadingState message="Loading jobs…" />}
        {jobs.error && !jobs.isInitialLoading && (
          <ErrorState error={jobs.error} onRetry={jobs.refetch} title="Could not load processing jobs" />
        )}
        {jobs.data && jobs.data.length === 0 && (
          <EmptyState
            title="No processing jobs yet"
            message="Upload a manual to kick off indexing and processing work."
          />
        )}
        {jobs.data && jobs.data.length > 0 && (
          <div className="table-wrap">
            <table className="incident-table">
              <thead>
                <tr>
                  <th>Manual</th>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Pages / chunks</th>
                  {canReprocess && <th>Retry</th>}
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((job) => (
                  <tr key={job.id} data-testid={`job-${job.id}`}>
                    <td>
                      <div className="incident-table__title">
                        {job.manualId.slice(-6)}
                        {job.embeddingModel ? ` · ${job.embeddingModel}` : ''}
                      </div>
                      <div className="incident-table__meta">
                        {job.jobType.replace(/_/g, ' ')}
                        {job.extractionMethod ? ` · ${job.extractionMethod}` : ''}
                        {job.ocrUsed ? ' · OCR used' : ''}
                      </div>
                    </td>
                    <td>
                      {job.currentStage ?? '—'}
                      {job.attempt > 1 && <span className="incident-table__meta"> · attempt {job.attempt}</span>}
                    </td>
                    <td>
                      <StatusBadge status={jobTone(job.status)} label={job.status} size="sm" />
                      {job.errorCode && (
                        <div className="incident-table__meta" title={job.errorMessage ?? ''}>
                          {job.errorCode}
                        </div>
                      )}
                    </td>
                    <td>{job.progressPercent}%</td>
                    <td>
                      {job.processedPages}
                      {job.totalPages ? ` / ${job.totalPages}` : ''} pages
                      {job.processedChunks > 0 && <> · {job.processedChunks} chunks</>}
                    </td>

                    {canReprocess && (
                      <td>
                        <button
                          type="button"
                          className="button button--secondary button--sm"
                          disabled={job.status === 'processing' || job.status === 'queued'}
                          onClick={() => void retry(job)}
                        >
                          Retry
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {jobs.data && jobs.data.length > 0 && (
          <p className="page__note">
            Jobs reflect the real processing queue. A failed job can be retried from here; the
            backend enforces who may retry.
          </p>
        )}
      </section>
    </div>
  );
}

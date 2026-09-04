/**
 * Manual processing jobs.
 *
 * Read for anyone with manual_processing_job.read; retry requires
 * manual.reprocess (manager/admin) — the button is hidden without it and the
 * API enforces the rule regardless. Polls every 10s while jobs are active.
 */
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/use-api';
import { apiClient, type ManualRecord, type ProcessingJob } from '../lib/api-client';
import { useToast } from '../lib/toast';
import { Badge, Button, Card, EmptyState, PageHeader, ProgressBar } from '../components/ui';
import { ErrorState } from '../components/states';
import { jobStatus } from '../lib/labels';
import { useState } from 'react';
import './page.css';

export function JobsPage(): JSX.Element {
  const { can } = useAuth();
  const toast = useToast();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const canReprocess = can('manual.reprocess');

  const manuals = useApi<ManualRecord[]>(
    () => apiClient.listManuals({ limit: 100 }).then((r) => r.data),
    [],
  );
  const jobs = useApi<ProcessingJob[]>(
    () => apiClient.listProcessingJobs({ limit: 50, sortBy: 'created_at', sortOrder: 'desc' }).then((r) => r.data),
    [],
    10_000,
  );

  const manualTitle = (manualId: string): string => {
    const manual = manuals.data?.find((m) => m.id === manualId);
    return manual ? manual.title : `Manual …${manualId.slice(-6)}`;
  };

  async function retry(job: ProcessingJob): Promise<void> {
    setRetryingId(job.id);
    try {
      await apiClient.retryProcessingJob(job.id);
      toast.success('Retry queued.');
      jobs.refetch();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Could not retry the job.');
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Document processing"
        description="Extraction, OCR, chunking and embedding jobs for uploaded manuals. Jobs refresh automatically every 10 seconds."
        breadcrumbs={[{ label: 'Document Processing' }]}
        actions={
          <Link to="/manuals/upload" className="btn btn--primary btn--sm">
            Upload manual
          </Link>
        }
      />

      <Card>
        {jobs.isInitialLoading && <ProgressBar percent={0} label="Loading jobs…" />}
        {jobs.error && !jobs.isInitialLoading && (
          <ErrorState error={jobs.error} onRetry={jobs.refetch} title="Could not load processing jobs" />
        )}
        {jobs.data && jobs.data.length === 0 && (
          <EmptyState
            title="No processing jobs yet"
            message="Upload a manual to start extraction, OCR and embedding work."
            icon="◷"
            action={<Link to="/manuals/upload" className="btn btn--primary btn--sm">Upload manual</Link>}
          />
        )}
        {jobs.data && jobs.data.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Manual</th>
                  <th>Current stage</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Pages / chunks</th>
                  <th>Last error</th>
                  {canReprocess && <th>Action</th>}
                </tr>
              </thead>
              <tbody>
                {jobs.data.map((job) => (
                  <tr key={job.id} data-testid={`job-${job.id}`}>
                    <td>
                      <Link to={`/manuals/${job.manualId}`}>{manualTitle(job.manualId)}</Link>
                      <div className="muted" style={{ fontSize: '0.78rem' }}>
                        {job.jobType.replace(/_/g, ' ')}
                        {job.attempt > 1 ? ` · attempt ${job.attempt}` : ''}
                        {job.ocrUsed ? ' · OCR used' : ''}
                      </div>
                    </td>
                    <td>{job.currentStage ?? '—'}</td>
                    <td><Badge presentation={jobStatus(job.status)} size="sm" /></td>
                    <td style={{ minWidth: 140 }}>
                      <ProgressBar percent={job.progressPercent} />
                    </td>
                    <td>
                      {job.processedPages}{job.totalPages ? ` / ${job.totalPages}` : ''} pages
                      {job.processedChunks > 0 && <> · {job.processedChunks} chunks</>}
                    </td>
                    <td>
                      {job.errorMessage ? (
                        <span className="muted" style={{ fontSize: '0.8rem' }} title={job.errorMessage}>
                          {job.errorCode ?? 'error'}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    {canReprocess && (
                      <td>
                        <Button
                          variant="secondary"
                          className="btn--sm"
                          loading={retryingId === job.id}
                          disabled={['running', 'queued', 'retrying'].includes(job.status)}
                          onClick={() => void retry(job)}
                        >
                          Retry
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

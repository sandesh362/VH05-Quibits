/**
 * Manual detail.
 *
 * Shows metadata, per-stage processing state (extraction / OCR / chunking /
 * embeddings via the latest job), searchable flag, page/chunk counts, errors,
 * and retry/reprocess actions for authorized roles. A manual is only offered
 * for troubleshooting when the backend reports isSearchable.
 */
import { useParams, Link } from 'react-router-dom';
import {
  apiClient,
  type MachineModelRecord,
  type ManualProcessingStatus,
  type ManualRecord,
} from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { formatBytes, formatDate, titleCase } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DescriptionList,
  PageHeader,
  ProgressBar,
} from '../components/ui';
import { ErrorState, LoadingState } from '../components/states';
import { jobStatus, processingStatus } from '../lib/labels';
import { useState } from 'react';
import './page.css';

export function ManualDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, error, isInitialLoading, refetch } = useApi<{
    manual: ManualRecord;
    status: ManualProcessingStatus;
    model?: MachineModelRecord;
  }>(
    async () => {
      const { manual } = await apiClient.getManual(id);
      let status: ManualProcessingStatus;
      try {
        status = await apiClient.getManualProcessingStatus(id);
      } catch {
        status = {
          processingStatus: manual.processingStatus,
          isSearchable: manual.isSearchable,
          pageCount: manual.pageCount,
          indexedChunkCount: manual.indexedChunkCount,
          extractionMethod: manual.extractionMethod,
          ocrUsed: manual.ocrUsed,
          failureReason: manual.failureReason,
          latestJob: null,
        };
      }
      let model: MachineModelRecord | undefined;
      if (manual.machineModelId) {
        try {
          const result = await apiClient.listModels({ limit: 100 });
          model = result.data.find((m) => m.id === manual.machineModelId);
        } catch {
          // model label is optional
        }
      }
      return { manual, status, model };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
    10_000,
  );

  async function reprocess(): Promise<void> {
    setBusy(true);
    try {
      await apiClient.reprocessManual(id);
      toast.success('Reprocessing started.');
      refetch();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Could not reprocess.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(reason: string): Promise<void> {
    setBusy(true);
    try {
      await apiClient.deleteManual(id, reason);
      toast.success('Manual deleted.');
      setConfirmDelete(false);
      window.location.assign('/manuals');
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Could not delete.');
      setBusy(false);
    }
  }

  if (isInitialLoading) {
    return <div className="page"><Card><LoadingState message="Loading manual…" /></Card></div>;
  }
  if (error || !data) {
    return (
      <div className="page">
        <Card><ErrorState error={error ?? new Error('Not found')} onRetry={refetch} title="Could not load this manual" /></Card>
      </div>
    );
  }

  const { manual, status, model } = data;
  const job = status.latestJob;
  const failed = manual.processingStatus !== 'completed' && (manual.failedAt !== null || manual.processingStatus.includes('failed'));

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[{ label: 'Manuals', to: '/manuals' }, { label: manual.title }]}
        title={manual.title}
        description={manual.description ?? undefined}
        actions={
          <>
            {failed && can('manual.reprocess') && (
              <Button variant="primary" loading={busy} onClick={() => void reprocess()}>
                Retry processing
              </Button>
            )}
            {can('manual.delete') && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </>
        }
      />

      <Card>
        <div className="entity-header">
          <div>
            <h2 style={{ marginBottom: 4 }}>{manual.originalFilename}</h2>
            <p className="entity-header__meta">
              {formatBytes(manual.fileSizeBytes)} · uploaded {formatDate(manual.createdAt)}
            </p>
          </div>
          <div className="entity-header__badges">
            <Badge presentation={processingStatus(manual.processingStatus)} />
            {manual.isSearchable ? (
              <Badge presentation={{ tone: 'ok', icon: '✓', label: 'Ready for troubleshooting' }} />
            ) : (
              <Badge presentation={{ tone: 'neutral', icon: '◌', label: 'Not searchable yet' }} />
            )}
          </div>
        </div>

        {manual.isSearchable ? (
          <Alert tone="ok">
            This manual is fully processed and its chunks are searchable in troubleshooting answers.
          </Alert>
        ) : failed ? (
          <Alert tone="error">
            Processing did not complete successfully. See the error below — managers can retry
            processing.
          </Alert>
        ) : (
          <Alert tone="info">
            This document is queued or processing. It will not appear in troubleshooting answers
            until every pipeline stage succeeds.
          </Alert>
        )}

        <div className="section-head"><h2>Metadata</h2></div>
        <DescriptionList
          items={[
            { label: 'Machine model', value: model ? `${model.manufacturer} ${model.modelName}` : '—' },
            { label: 'Document type', value: titleCase(manual.documentType.replace(/_/g, ' ')) },
            { label: 'Version', value: manual.documentVersion ?? manual.revision ?? '—' },
            { label: 'Document number', value: manual.documentNumber ?? '—' },
            { label: 'Language', value: manual.language || '—' },
            { label: 'Manufacturer', value: manual.manufacturer ?? '—' },
            { label: 'Current version', value: manual.isCurrentVersion ? 'Yes' : 'No (superseded)' },
            { label: 'Pages', value: manual.pageCount ?? '—' },
            { label: 'Indexed chunks', value: manual.indexedChunkCount || '—' },
            { label: 'Extraction', value: manual.extractionMethod ? titleCase(manual.extractionMethod.replace(/_/g, ' ')) : '—' },
            { label: 'OCR used', value: manual.ocrUsed ? 'Yes' : 'No' },
            { label: 'Processed at', value: formatDate(manual.processedAt) },
          ]}
        />
      </Card>

      <Card>
        <div className="section-head">
          <h2>Processing pipeline</h2>
          {job && <Badge presentation={jobStatus(job.status)} size="sm" />}
        </div>

        {job ? (
          <>
            <ProgressBar percent={job.progressPercent} label={`${job.currentStage ?? job.jobType} · ${job.progressPercent}%`} />
            <div className="table-wrap" style={{ marginTop: 'var(--space-md)' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Status</th>
                    <th className="num">Attempt</th>
                    <th>Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {job.stages.map((stage) => (
                    <tr key={stage.name}>
                      <td>{titleCase(stage.name.replace(/_/g, ' '))}</td>
                      <td>
                        <Badge presentation={jobStatus(stage.status)} size="sm" />
                      </td>
                      <td className="num">{job.attempt}</td>
                      <td>{stage.warnings.length ? stage.warnings.join('; ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {job.totalPages !== null && (
              <p className="page__note">
                {job.processedPages}/{job.totalPages} pages
                {job.totalChunks ? ` · ${job.processedChunks}/${job.totalChunks} chunks` : ''}
                {job.ocrUsed ? ' · OCR fallback used' : ''}
              </p>
            )}
          </>
        ) : (
          <p className="muted">No processing job recorded yet.</p>
        )}

        {(manual.failureReason || job?.errorMessage) && (
          <Alert tone="error">
            <div>
              <strong>Last error:</strong>{' '}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
                {manual.failureReason ?? job?.errorMessage}
              </span>
            </div>
          </Alert>
        )}
      </Card>

      <div className="form-actions">
        <Link to="/manuals" className="btn btn--ghost">← Back to manuals</Link>
        <Button variant="ghost" onClick={() => refetch()}>Refresh</Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title="Delete this manual?"
        confirmLabel="Delete manual"
        requireNote
        noteLabel="Reason for deletion"
        loading={busy}
        irreversible
      >
        <p>
          This removes the document record, its file, chunks and vectors. Troubleshooting answers
          will no longer cite this manual.
        </p>
      </ConfirmDialog>
    </div>
  );
}

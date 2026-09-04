/**
 * Citation preview (Phase 8): clicking a source lands on the real manual
 * content, not on a label.
 *
 * - Manual sources fetch the actual stored chunk (section path, pages, text)
 *   from `GET /manuals/:id/chunks/:chunkId`.
 * - Historical-incident and maintenance sources render their own evidence
 *   metadata - they have no pages by design.
 *
 * Honesty rules: this shows exactly what the answer was grounded on. Where
 * the deployment has no scanned page images, the chunk text is the preview -
 * the modal says so instead of pretending to show an image.
 */
import { useApi } from '../lib/use-api';
import { apiClient, type ManualChunk, type MessageRecord } from '../lib/api-client';
import { ErrorState, LoadingState } from './states';

type Source = MessageRecord['sources'][number];

interface Props {
  source: Source;
  onClose: () => void;
}

export function CitationPreview({ source, onClose }: Props): JSX.Element {
  const isManual = source.sourceType !== 'incident' && source.sourceType !== 'maintenance';
  const chunkQuery = useApi<ManualChunk | null>(
    () =>
      isManual && source.manualId && source.chunkId
        ? apiClient.getManualChunk(source.manualId, source.chunkId).then((r) => r.chunk)
        : Promise.resolve(null),
    [source.sourceId],
  );

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="source-title">
      <div className="modal__card modal__card--wide">
        <header className="modal__head">
          <h2 id="source-title" className="modal__title">
            {source.sourceType === 'incident'
              ? `Historical incident ${source.incidentNumber ?? ''}`
              : source.sourceType === 'maintenance'
                ? 'Maintenance record'
                : source.manualTitle}
          </h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close preview">
            ×
          </button>
        </header>

        {source.sourceType === 'incident' && (
          <div className="source-caption source-caption--incident">
            Historical context only — a similar past incident. It does not prove the current
            diagnosis, and its fix is not a prescription. Manual instructions take precedence.
          </div>
        )}
        {source.sourceType === 'maintenance' && (
          <div className="source-caption source-caption--maintenance">
            Maintenance record — noted context, never causally linked to this fault.
            {source.notedByManual
              ? ' A serviced part is also mentioned in the manual (correlation, not causation).'
              : ''}
          </div>
        )}

        <dl className="kv">
          {source.sourceType !== 'incident' && source.sourceType !== 'maintenance' && (
            <div className="kv__row">
              <dt>Version</dt>
              <dd>{source.manualVersion || '—'}</dd>
            </div>
          )}
          {source.sourceType !== 'maintenance' && (
            <div className="kv__row">
              <dt>Pages</dt>
              <dd>
                {source.pageStart
                  ? source.pageEnd && source.pageEnd !== source.pageStart
                    ? `${source.pageStart}–${source.pageEnd}`
                    : String(source.pageStart)
                  : '—'}
              </dd>
            </div>
          )}
          {source.sectionTitle && (
            <div className="kv__row">
              <dt>Section</dt>
              <dd>{source.sectionTitle}</dd>
            </div>
          )}
          {source.sourceType === 'maintenance' && (
            <>
              <div className="kv__row">
                <dt>Days before this question</dt>
                <dd>{source.daysBeforeIncident ?? '—'}</dd>
              </div>
              <div className="kv__row">
                <dt>Correlation strength</dt>
                <dd>{source.correlationStrength ?? '—'}</dd>
              </div>
              <div className="kv__row">
                <dt>Causal claim</dt>
                <dd>false (always)</dd>
              </div>
            </>
          )}
          <div className="kv__row">
            <dt>Source id</dt>
            <dd>
              <code>{source.sourceId}</code>
            </dd>
          </div>
        </dl>

        {isManual && (
          <div className="chunk-preview">
            {chunkQuery.isLoading && <LoadingState message="Loading the exact source chunk…" />}
            {chunkQuery.error && !chunkQuery.isLoading && (
              <ErrorState
                error={chunkQuery.error}
                onRetry={chunkQuery.refetch}
                title="Could not load the source chunk"
              />
            )}
            {chunkQuery.data && (
              <>
                {chunkQuery.data.sectionPath && chunkQuery.data.sectionPath.length > 0 && (
                  <p className="chunk-preview__path">
                    {chunkQuery.data.sectionPath.join(' › ')}
                  </p>
                )}
                <blockquote className="chunk-preview__text" data-testid="chunk-preview-text">
                  {chunkQuery.data.text}
                </blockquote>
                <p className="chunk-preview__note">
                  This is the exact chunk the answer was grounded on (pages{' '}
                  {chunkQuery.data.pageStart}
                  {chunkQuery.data.pageEnd !== chunkQuery.data.pageStart
                    ? `–${chunkQuery.data.pageEnd}`
                    : ''}
                  ). This deployment stores extracted text; scanned page-image previews are not
                  part of this phase.
                </p>
              </>
            )}
          </div>
        )}

        {!isManual && source.excerpt && <p className="excerpt">{source.excerpt}</p>}

        <footer className="modal__foot">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Service status page.
 *
 * Renders the REAL readiness report from the backend. Every row reflects an
 * actual probe: nothing on this page is hardcoded to "healthy".
 */
import { apiClient } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { ErrorState, InlineSpinner, LoadingState } from '../components/states';
import { StatusBadge } from '../components/status-badge';
import './page.css';

/** Human-facing description of each dependency's role. */
const DEPENDENCY_INFO: Record<string, { title: string; role: string }> = {
  mongodb: {
    title: 'MongoDB',
    role: 'Primary database — users, machines, manuals, incidents, maintenance.',
  },
  qdrant: {
    title: 'Qdrant',
    role: 'Vector database for manual chunks and incident history. Used from Phase 4.',
  },
  'rag-service': {
    title: 'RAG service (FastAPI)',
    role: 'Document processing and AI pipeline. Used from Phase 3.',
  },
  ollama: {
    title: 'Ollama',
    role: 'Local AI runtime for embeddings and answer generation. Used from Phase 4.',
  },
};

const POLL_INTERVAL_MS = 15_000;

export function StatusPage(): JSX.Element {
  const { data, error, isInitialLoading, isLoading, refetch, lastUpdated } = useApi(
    (signal) => apiClient.getReadiness({ signal }),
    [],
    POLL_INTERVAL_MS,
  );

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>Service status</h1>
          <p className="page__lead">
            Live dependency probes performed by the Express API. Refreshes every{' '}
            {POLL_INTERVAL_MS / 1000} seconds.
          </p>
        </div>
        <button type="button" onClick={refetch} disabled={isLoading}>
          {isLoading ? <InlineSpinner label="Refreshing" /> : 'Refresh'}
        </button>
      </header>

      {isInitialLoading && <LoadingState message="Probing dependencies…" />}

      {error && !isInitialLoading && (
        <ErrorState error={error} onRetry={refetch} title="Cannot reach the backend" />
      )}

      {data && (
        <>
          <section
            className={`summary summary--${data.status}`}
            aria-labelledby="summary-heading"
          >
            <div className="summary__main">
              <h2 id="summary-heading" className="summary__title">
                Overall
              </h2>
              <StatusBadge
                status={data.status}
                label={
                  data.status === 'ok'
                    ? 'All systems operational'
                    : data.status === 'degraded'
                      ? 'Running with reduced capability'
                      : 'Not ready'
                }
              />
            </div>

            <p className="summary__detail">
              {data.ready
                ? 'All required dependencies are available.'
                : 'A required dependency is unavailable. The API cannot serve data.'}
            </p>

            {data.degradedCapabilities.length > 0 && (
              <p className="summary__degraded">
                <strong>Unavailable capabilities:</strong>{' '}
                {data.degradedCapabilities.map((c) => (
                  <code key={c}>{c}</code>
                ))}
              </p>
            )}
          </section>

          <section aria-labelledby="deps-heading">
            <h2 id="deps-heading" className="section-heading">
              Dependencies
            </h2>

            <ul className="dep-list">
              {data.checks.map((check) => {
                const info = DEPENDENCY_INFO[check.name];
                return (
                  <li key={check.name} className="dep">
                    <div className="dep__head">
                      <div className="dep__identity">
                        <h3 className="dep__name">{info?.title ?? check.name}</h3>
                        {check.required ? (
                          <span className="dep__tag dep__tag--required">Required</span>
                        ) : (
                          <span className="dep__tag">Optional in Phase 1</span>
                        )}
                      </div>
                      <StatusBadge status={check.status} />
                    </div>

                    {info && <p className="dep__role">{info.role}</p>}
                    {check.detail && <p className="dep__detail">{check.detail}</p>}

                    {check.error && (
                      <p className="dep__error">
                        <span aria-hidden="true">⚠ </span>
                        {check.error}
                      </p>
                    )}

                    {check.impact && check.status !== 'ok' && (
                      <p className="dep__impact">
                        <strong>Impact:</strong> {check.impact}
                      </p>
                    )}

                    {check.latencyMs !== null && (
                      <p className="dep__latency">Responded in {check.latencyMs} ms</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <p className="page__footnote">
            Probed in {data.durationMs} ms
            {lastUpdated && <> · last updated {lastUpdated.toLocaleTimeString()}</>}
          </p>
        </>
      )}
    </div>
  );
}

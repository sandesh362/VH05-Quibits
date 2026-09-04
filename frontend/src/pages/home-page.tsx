/**
 * Home page.
 *
 * Proves the frontend can reach the backend, and states honestly what does and
 * does not exist yet. No fabricated demo data.
 */
import { Link } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { ErrorState, LoadingState } from '../components/states';
import { StatusBadge } from '../components/status-badge';
import './page.css';

/** Mirrors SystemInfoResponse.features; labels for display. */
const FEATURE_LABELS: Record<string, string> = {
  authentication: 'Authentication & roles',
  manualUpload: 'Manual upload',
  documentProcessing: 'PDF text extraction',
  ocr: 'OCR for scanned manuals',
  embeddings: 'Local embeddings (Ollama)',
  vectorSearch: 'Vector search (Qdrant)',
  ragAnswers: 'Grounded RAG answers',
  incidentManagement: 'Incident management & workflows',
  incidentMemory: 'Incident memory retrieval',
  maintenanceHistory: 'Maintenance history lane',
};

const PHASE_BY_FEATURE: Record<string, string> = {
  authentication: 'Phase 2',
  manualUpload: 'Phase 3',
  documentProcessing: 'Phase 3',
  ocr: 'Phase 3',
  embeddings: 'Phase 3',
  vectorSearch: 'Phase 4',
  ragAnswers: 'Phase 4–5',
  incidentManagement: 'Phase 6',
  incidentMemory: 'Phase 6',
  maintenanceHistory: 'Phase 7',
};

export function HomePage(): JSX.Element {
  const { data, error, isInitialLoading, refetch } = useApi((signal) =>
    apiClient.getSystemInfo({ signal }),
  );

  return (
    <div className="page">
      <header className="page__header">
        <h1>Industrial Troubleshooting Platform</h1>
        <p className="page__lead">
          A locally running troubleshooting assistant for industrial maintenance technicians.
          Sign in to start a conversation scoped to a machine or model. Answers come from
          indexed manuals with citations — never from the cloud.
        </p>
      </header>

      <section className="card" aria-labelledby="connection-heading">
        <h2 id="connection-heading">Backend connection</h2>

        {isInitialLoading && <LoadingState message="Contacting the API…" />}

        {error && !isInitialLoading && (
          <ErrorState error={error} onRetry={refetch} title="Cannot reach the backend" />
        )}

        {data && (
          <>
            <div className="connection-ok">
              <StatusBadge status="ok" label="Connected" />
              <span className="connection-ok__text">
                The web interface successfully called the Express API.
              </span>
            </div>

            <dl className="kv">
              <div className="kv__row">
                <dt>Service</dt>
                <dd>
                  <code>{data.service}</code>
                </dd>
              </div>
              <div className="kv__row">
                <dt>Version</dt>
                <dd>
                  <code>{data.version}</code>
                </dd>
              </div>
              <div className="kv__row">
                <dt>Environment</dt>
                <dd>
                  <code>{data.environment}</code>
                </dd>
              </div>
              <div className="kv__row">
                <dt>API prefix</dt>
                <dd>
                  <code>{data.apiPrefix}</code>
                </dd>
              </div>
              <div className="kv__row">
                <dt>Runtime</dt>
                <dd>
                  <code>
                    Node {data.nodeVersion} · {data.platform}
                  </code>
                </dd>
              </div>
              <div className="kv__row">
                <dt>Phase</dt>
                <dd>{data.phase}</dd>
              </div>
            </dl>

            <p className="page__note">
              For live dependency status, see the{' '}
              <Link to="/status">service status page</Link>.
            </p>
          </>
        )}
      </section>

      {data && (
        <section className="card" aria-labelledby="features-heading">
          <h2 id="features-heading">Implementation status</h2>
          <p className="page__note page__note--top">
            Reported by the backend, not hardcoded here — every flag reflects what the API
            actually built, including the maintenance history lane (Phase 7).
          </p>

          <ul className="feature-list">
            {Object.entries(data.features).map(([key, enabled]) => (
              <li key={key} className="feature-list__item">
                <span className="feature-list__label">{FEATURE_LABELS[key] ?? key}</span>
                <span className="feature-list__right">
                  <span className="feature-list__phase">{PHASE_BY_FEATURE[key] ?? '—'}</span>
                  <StatusBadge
                    status={enabled ? 'ok' : 'disabled'}
                    label={enabled ? 'Available' : 'Not built'}
                    size="sm"
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

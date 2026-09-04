/**
 * Retrieval trace drawer (Phase 8): shows why an answer looks the way it
 * does - counts, lanes, warnings, and the exact sources.
 *
 * Built from what Express actually stores per assistant message
 * (`retrievalMetadata`, the same record the audit trail keeps). Nothing is
 * invented here: a field that was not stored is rendered as "not recorded".
 */
import type { MessageRecord } from '../lib/api-client';

interface Props {
  message: MessageRecord;
  onClose: () => void;
}

function metaNumber(metadata: Record<string, unknown> | undefined, keys: string[]): string {
  if (!metadata) return 'not recorded';
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number') return String(value);
  }
  return 'not recorded';
}

function metaList(metadata: Record<string, unknown> | undefined, key: string): string[] {
  if (!metadata) return [];
  const value = metadata[key];
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

export function RetrievalTrace({ message, onClose }: Props): JSX.Element {
  const metadata = message.retrievalMetadata as Record<string, unknown> | undefined;
  const warnings = metaList(metadata, 'warnings');

  const lanes: Array<{ label: string; className: string; count: string }> = [
    {
      label: 'Manual evidence',
      className: 'source-caption--manual',
      count: metaNumber(metadata, ['finalContextChunks', 'final_context_chunks', 'selectedChunkCount']),
    },
    {
      label: 'Exact matches',
      className: 'source-caption--manual',
      count: metaNumber(metadata, ['exactMatches', 'exact_matches']),
    },
    {
      label: 'Semantic matches',
      className: 'source-caption--manual',
      count: metaNumber(metadata, ['semanticMatches', 'semantic_matches']),
    },
    {
      label: 'Historical incidents',
      className: 'source-caption--incident',
      count: metaNumber(metadata, ['historicalMatches', 'historical_matches']),
    },
    {
      label: 'Maintenance records',
      className: 'source-caption--maintenance',
      count: metaNumber(metadata, ['maintenanceItems', 'maintenance_items']),
    },
  ];

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="trace-title">
      <div className="modal__card modal__card--wide">
        <header className="modal__head">
          <h2 id="trace-title" className="modal__title">
            Retrieval trace
          </h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close trace">
            ×
          </button>
        </header>

        <p className="page__note page__note--top">
          Why this answer looks the way it does. Counts come from the stored retrieval metadata
          (the same record the audit trail keeps); the full debug payload is not persisted.
        </p>

        <ul className="trace-lanes" data-testid="trace-lanes">
          {lanes.map((lane) => (
            <li key={lane.label} className={`trace-lane ${lane.className}`}>
              <span className="trace-lane__label">{lane.label}</span>
              <span className="trace-lane__count">{lane.count}</span>
            </li>
          ))}
        </ul>

        {warnings.length > 0 && (
          <div className="trace-warnings" role="note">
            <h3>Warnings</h3>
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {message.sources.length > 0 && (
          <div className="trace-sources">
            <h3>Sources used</h3>
            <ul>
              {message.sources.map((source) => (
                <li key={source.sourceId}>
                  <code>{source.sourceId}</code>{' '}
                  {source.sourceType === 'incident'
                    ? `Historical incident ${source.incidentNumber ?? ''}`
                    : source.sourceType === 'maintenance'
                      ? `Maintenance record · ${source.manualTitle}`
                      : `${source.manualTitle}${source.manualVersion ? `, v${source.manualVersion}` : ''}`}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="source-caption">
          This drawer shows retrieval facts. The answer itself remains manual-grounded: verify
          against the source before acting.
        </p>

        <footer className="modal__foot">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

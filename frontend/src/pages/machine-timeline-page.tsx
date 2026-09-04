/**
 * Machine timeline: maintenance records and incident events merged into one
 * chronological view. This is the Phase 7 "machine history" surface - it
 * merges records, never invents them.
 */
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../lib/use-api';
import { apiClient, type MachineTimelineEvent } from '../lib/api-client';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import './page.css';

type Kind = 'all' | 'maintenance' | 'incident';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function MachineTimelinePage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const machineId = id ?? '';
  const [kind, setKind] = useState<Kind>('all');

  const fetcher = useCallback(
    () => apiClient.getMachineTimeline(machineId, kind),
    [machineId, kind],
  );
  const { data, error, isLoading, refetch } = useApi(fetcher);

  const machine = data?.machine ?? null;
  const timeline = data?.timeline ?? [];

  return (
    <div className="page">
      <header className="page__header">
        <p className="page__note page__note--top">
          <Link to="/machines">← Machines</Link>
          {machine && <> · {machine.assetTag}</>}
        </p>
        <h1>{machine ? (machine.displayName ?? machine.assetTag) : 'Machine timeline'}</h1>
        <p className="page__lead">
          {machine?.modelLabel ?? 'Machine'} · {machine?.openIncidentCount ?? 0} open incident(s).
          Merged history: maintenance records and incident events.
        </p>
        <div className="badge-row">
          {(['all', 'maintenance', 'incident'] as Kind[]).map((option) => (
            <button
              key={option}
              type="button"
              className={kind === option ? 'button' : 'button button--secondary'}
              onClick={() => setKind(option)}
              aria-pressed={kind === option}
            >
              {option === 'all' ? 'All events' : option === 'maintenance' ? 'Maintenance only' : 'Incidents only'}
            </button>
          ))}
        </div>
      </header>

      <section className="card" aria-label="Machine timeline">
        {isLoading && <LoadingState message="Loading timeline…" />}
        {!isLoading && error && (
          <ErrorState error={error} onRetry={refetch} title="Could not load the timeline" />
        )}
        {!isLoading && !error && timeline.length === 0 && (
          <EmptyState
            title="Nothing recorded yet"
            message="Maintenance records and incident events will appear here."
          />
        )}
        {!isLoading && !error && timeline.length > 0 && (
          <ul className="timeline">
            {timeline.map((event) => (
              <TimelineRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TimelineRow({ event }: { event: MachineTimelineEvent }): JSX.Element {
  return (
    <li className="timeline__event" data-testid={`timeline-${event.kind}-${event.id}`}>
      <span className="timeline__when">{formatDate(event.at)}</span>
      <div className="timeline__body">
        <span className="timeline__type">
          {event.kind === 'maintenance' ? 'MAINTENANCE' : 'INCIDENT'}
        </span>{' '}
        <strong>{event.title}</strong>
        {event.kind === 'maintenance' && event.maintenanceType && (
          <span className="action-card__meta"> · {event.maintenanceType.replace(/_/g, ' ')}</span>
        )}
        {event.kind === 'maintenance' && event.partsReplaced && event.partsReplaced.length > 0 && (
          <div className="similar-card__codes">
            Parts: {event.partsReplaced.map((part) => part.partNumber).join(', ')}
          </div>
        )}
        {event.kind === 'incident' && event.incidentId && (
          <div className="action-card__meta">
            <Link to={`/incidents/${event.incidentId}`}>{event.incidentNumber}</Link>
            {typeof event.previous === 'string' && typeof event.next === 'string' && (
              <> · {event.previous.replace(/_/g, ' ')} → {event.next.replace(/_/g, ' ')}</>
            )}
          </div>
        )}
        {event.actorUsername && <span className="timeline__actor">by {event.actorUsername}</span>}
        {event.note && <div className="timeline__note">{event.note}</div>}
        {event.kind === 'maintenance' && (
          <div className="maintenance-caption">
            Maintenance record — noted context, never causally linked to a fault.
          </div>
        )}
      </div>
    </li>
  );
}

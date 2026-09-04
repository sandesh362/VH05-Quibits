/**
 * Machines list. Entry point for the per-machine timeline, which merges
 * maintenance records and incident events into one chronological view.
 */
import { Link } from 'react-router-dom';
import { useApi } from '../lib/use-api';
import { apiClient, type MachineRecord } from '../lib/api-client';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import './page.css';

export function MachinesPage(): JSX.Element {
  const { data, error, isLoading, refetch } = useApi<MachineRecord[]>(() =>
    apiClient.listMachines().then((r) => r.data),
  );

  return (
    <div className="page">
      <header className="page__header">
        <h1>Machines</h1>
        <p className="page__lead">
          Physical assets. Open a machine to see its merged timeline: maintenance records and
          incident events.
        </p>
      </header>

      <section className="card" aria-label="Machines">
        {isLoading && <LoadingState message="Loading machines…" />}
        {!isLoading && error && (
          <ErrorState error={error} onRetry={refetch} title="Could not load machines" />
        )}
        {!isLoading && !error && data && data.length === 0 && (
          <EmptyState title="No machines registered" message="Register a machine model first, then a machine." />
        )}
        {!isLoading && !error && data && data.length > 0 && (
          <div className="table-wrap">
            <table className="incident-table">
              <thead>
                <tr>
                  <th>Asset tag</th>
                  <th>Display name</th>
                  <th>Model</th>
                  <th>Timeline</th>
                </tr>
              </thead>
              <tbody>
                {data.map((machine) => (
                  <tr key={machine.id} data-testid={`machine-row-${machine.assetTag}`}>
                    <td>{machine.assetTag}</td>
                    <td>{machine.displayName ?? '—'}</td>
                    <td>
                      {machine.modelSnapshot
                        ? `${machine.modelSnapshot.manufacturer} ${machine.modelSnapshot.modelName}`
                        : '—'}
                    </td>
                    <td>
                      <Link to={`/machines/${machine.id}`}>Open timeline</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

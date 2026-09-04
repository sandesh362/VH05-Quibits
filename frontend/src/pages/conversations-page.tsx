import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, type ConversationSummary } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { StatusBadge } from '../components/status-badge';
import './page.css';
import './chat.css';

function issueTone(status: string): 'ok' | 'degraded' | 'down' | 'disabled' | 'unknown' {
  if (status === 'resolved') return 'ok';
  if (status === 'escalated' || status === 'unresolved') return 'down';
  if (status === 'temporary_fix' || status === 'recurring' || status === 'investigating') return 'degraded';
  return 'unknown';
}

export function ConversationsPage(): JSX.Element {
  const [status, setStatus] = useState('');
  const [issueStatus, setIssueStatus] = useState('');
  const [search, setSearch] = useState('');
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (issueStatus) params.set('issueStatus', issueStatus);
    if (search.trim()) params.set('search', search.trim());
    params.set('limit', '50');
    return params.toString();
  }, [status, issueStatus, search]);

  const { data, error, isInitialLoading, refetch } = useApi(
    async () => {
      const result = await apiClient.listConversations(query);
      return result.data;
    },
    [query],
  );

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>Troubleshooting conversations</h1>
          <p className="page__lead">Evidence-grounded chat scoped to a machine or model. AI suggestions are not repairs.</p>
        </div>
        <Link to="/conversations/new" className="button-link">
          New conversation
        </Link>
      </header>

      <div className="filters">
        <input
          placeholder="Search title or issue"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search conversations"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="closed">Closed</option>
          <option value="archived">Archived</option>
        </select>
        <select value={issueStatus} onChange={(e) => setIssueStatus(e.target.value)} aria-label="Filter by issue status">
          <option value="">Any issue status</option>
          <option value="unknown">Unknown</option>
          <option value="investigating">Investigating</option>
          <option value="temporary_fix">Temporary fix</option>
          <option value="resolved">Resolved</option>
          <option value="unresolved">Unresolved</option>
          <option value="recurring">Recurring</option>
          <option value="escalated">Escalated</option>
        </select>
      </div>

      {isInitialLoading && <LoadingState message="Loading conversations…" />}
      {error && !isInitialLoading && <ErrorState error={error} onRetry={refetch} title="Cannot load conversations" />}
      {data && data.length === 0 && (
        <EmptyState
          title="No conversations yet"
          message="Start one from a machine or model. Answers come only from indexed manuals."
          action={<Link to="/conversations/new">Create conversation</Link>}
        />
      )}
      {data && data.length > 0 && (
        <ul className="conv-list">
          {data.map((item: ConversationSummary) => (
            <li key={item.id}>
              <Link to={`/conversations/${item.id}`} className="conv-list__item">
                <div>
                  <strong>{item.title || 'Untitled conversation'}</strong>
                  <p>{item.issueSummary || 'No issue summary'}</p>
                  <p className="conv-list__meta">
                    {item.machineLabel || item.machineModelLabel || 'No machine selected'}
                    {item.lastMessageAt ? ` · ${new Date(item.lastMessageAt).toLocaleString()}` : ''}
                    {` · ${item.messageCount} messages`}
                  </p>
                </div>
                <div className="conv-list__badges">
                  <StatusBadge status={item.status === 'active' ? 'ok' : 'disabled'} label={item.status} size="sm" />
                  <StatusBadge status={issueTone(item.issueStatus)} label={item.issueStatus.replace('_', ' ')} size="sm" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

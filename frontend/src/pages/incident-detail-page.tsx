/**
 * Incident detail page.
 *
 * Sections: metadata, machine, status/issue status, symptoms/error codes/
 * conditions, root-cause workflow (confirm/reject with mandatory notes),
 * temporary + permanent fix workflows, resolution/close/reopen, technician
 * actions (separate from AI suggestions), similar historical incidents
 * (labeled, with disclaimer), and the chronological timeline.
 */
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../lib/use-api';
import {
  apiClient,
  ApiClientError,
  type IncidentActionRecord,
  type IncidentRecord,
  type IncidentTimelineEventRecord,
  type SimilarIncidentRecord,
} from '../lib/api-client';
import { useAuth } from '../lib/auth';
import {
  ConfirmedBadge,
  IncidentStatusBadge,
  IssueStatusBadge,
  PriorityBadge,
  RootCauseStatusBadge,
  SeverityBadge,
} from '../components/incident-badges';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import './page.css';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function timelineLabel(type: string): string {
  return type.replace(/_/g, ' ');
}

function ChipList({ items }: { items: string[] }): JSX.Element | null {
  if (!items || items.length === 0) return null;
  return (
    <ul className="chip-list">
      {items.map((item) => (
        <li key={item} className="chip">{item}</li>
      ))}
    </ul>
  );
}

export function IncidentDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const incidentId = id ?? '';

  const canManage = user?.role === 'admin' || user?.role === 'manager';

  const incident = useApi<IncidentRecord>(
    () => apiClient.getIncident(incidentId).then((r) => r.incident),
    [incidentId],
  );
  const timeline = useApi<IncidentTimelineEventRecord[]>(
    () => apiClient.getIncidentTimeline(incidentId).then((r) => r.timeline),
    [incidentId],
  );
  const actions = useApi<IncidentActionRecord[]>(
    () => apiClient.listIncidentActions(incidentId).then((r) => r.data),
    [incidentId],
  );
  const similar = useApi<SimilarIncidentRecord[]>(
    () => apiClient.getSimilarIncidents(incidentId).then((r) => r.similar),
    [incidentId],
  );

  const refreshAll = useCallback(() => {
    incident.refetch();
    timeline.refetch();
    actions.refetch();
    similar.refetch();
  }, [incident, timeline, actions, similar]);

  if (incident.isInitialLoading) return <LoadingState message="Loading incident…" />;
  if (incident.error) {
    return (
      <ErrorState error={incident.error} onRetry={incident.refetch} title="Could not load the incident" />
    );
  }
  if (!incident.data) return <LoadingState message="Loading incident…" />;
  const record = incident.data;

  return (
    <div className="page">
      <header className="page__header">
        <div className="page__header--row">
          <div>
            <p className="page__note page__note--top">
              <Link to="/incidents">← Incidents</Link> · {record.incidentNumber}
              {record.machineLabel && <> · {record.machineLabel}</>}
            </p>
            <h1>{record.title}</h1>
            <div className="badge-row">
              <IncidentStatusBadge status={record.status} />
              <IssueStatusBadge status={record.issueStatus} />
              <SeverityBadge status={record.severity} />
              <PriorityBadge status={record.priority} />
            </div>
          </div>
          <div className="page__header-actions">
            {canManage && record.status !== 'cancelled' && (
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  const reason = window.prompt('Reason for cancelling this incident:');
                  if (!reason) return;
                  void apiClient
                    .deleteIncident(record.id, reason)
                    .then(() => navigate('/incidents'))
                    .catch((error: unknown) => {
                      if (error instanceof ApiClientError) window.alert(error.message);
                    });
                }}
              >
                Cancel incident
              </button>
            )}
          </div>
        </div>
      </header>

      <section className="card">
        <dl className="kv">
          <div className="kv__row">
            <dt>Description</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{record.description}</dd>
          </div>
          <div className="kv__row">
            <dt>Machine</dt>
            <dd>
              {record.machineLabel ?? record.machineId}
              {record.machineModelLabel && <div className="page__note">{record.machineModelLabel}</div>}
            </dd>
          </div>
          <div className="kv__row">
            <dt>Reported by</dt>
            <dd>
              {record.reportedByName ?? record.reportedBy.slice(-6)} · {formatDate(record.firstObservedAt)}
            </dd>
          </div>
          <div className="kv__row">
            <dt>Assigned to</dt>
            <dd>{record.assignedToName ?? record.assignedTo ? (record.assignedToName ?? record.assignedTo?.slice(-6)) : 'Unassigned'}</dd>
          </div>
          <div className="kv__row">
            <dt>Source</dt>
            <dd>{record.source}</dd>
          </div>
          {record.conversationId && (
            <div className="kv__row">
              <dt>Conversation</dt>
              <dd><Link to={`/conversations/${record.conversationId}`}>Open conversation</Link></dd>
            </div>
          )}
          {record.manualId && (
            <div className="kv__row">
              <dt>Manual</dt>
              <dd>
                {record.manualTitle ?? record.manualId.slice(-6)}
                {record.manualVersion && <> · version {record.manualVersion}</>}
              </dd>
            </div>
          )}
          <div className="kv__row">
            <dt>Embedding</dt>
            <dd>
              {record.embeddingStatus === 'indexed' && 'Indexed in historical memory'}
              {record.embeddingStatus === 'pending' && 'Indexing…'}
              {record.embeddingStatus === 'failed' && (
                <>Indexing failed{record.embeddingError ? `: ${record.embeddingError}` : ''}</>
              )}
              {record.embeddingStatus === 'not_indexed' && 'Not indexed'}
              {(canManage || user?.role === 'manager') && record.embeddingStatus === 'failed' && (
                <button
                  type="button"
                  className="button button--secondary"
                  style={{ marginLeft: 8 }}
                  onClick={() => void apiClient.reindexIncident(record.id).then(refreshAll)}
                >
                  Retry indexing
                </button>
              )}
            </dd>
          </div>
        </dl>
        {record.symptoms.length > 0 && (
          <>
            <h3 className="subsection">Symptoms</h3>
            <ChipList items={record.symptoms} />
          </>
        )}
        {record.errorCodes.length > 0 && (
          <>
            <h3 className="subsection">Error codes</h3>
            <ChipList items={record.errorCodes} />
          </>
        )}
        {record.operatingConditions.length > 0 && (
          <>
            <h3 className="subsection">Operating conditions</h3>
            <ChipList items={record.operatingConditions} />
          </>
        )}
        {record.tags.length > 0 && (
          <>
            <h3 className="subsection">Tags</h3>
            <ChipList items={record.tags} />
          </>
        )}
      </section>

      <section className="card incident-section" aria-label="Workflow status">
        <h2>Workflow</h2>
        <StatusControls record={record} onChanged={refreshAll} />
        <ResolutionBlock record={record} onChanged={refreshAll} canManage={canManage} />
      </section>

      <RootCauseSection record={record} onChanged={refreshAll} canManage={canManage} />

      <FixSection
        record={record}
        kind="temporary"
        title="Temporary fix"
        onChanged={refreshAll}
        canManage={canManage}
      />
      <FixSection
        record={record}
        kind="permanent"
        title="Permanent fix"
        onChanged={refreshAll}
        canManage={canManage}
      />

      <ActionsSection
        incidentId={incidentId}
        record={record}
        actions={actions}
        onChanged={refreshAll}
      />

      <SimilarSection similar={similar} />

      <TimelineSection timeline={timeline} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status controls
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<string, string[]> = {
  open: ['investigating', 'cancelled'],
  investigating: ['waiting_for_information', 'waiting_for_parts', 'cancelled'],
  waiting_for_information: ['investigating', 'cancelled'],
  waiting_for_parts: ['investigating', 'cancelled'],
  resolved: [],
  closed: [],
  reopened: ['investigating', 'cancelled'],
  cancelled: [],
};

function StatusControls({
  record,
  onChanged,
}: {
  record: IncidentRecord;
  onChanged: () => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const allowed = TRANSITIONS[record.status] ?? [];

  async function transition(status: string): Promise<void> {
    setMessage(null);
    try {
      await apiClient.changeIncidentStatus(record.id, status, reason || undefined);
      setReason('');
      onChanged();
    } catch (caught) {
      setMessage(caught instanceof ApiClientError ? caught.message : 'Transition failed.');
    }
  }

  return (
    <div className="inline-form">
      <p className="page__note page__note--top">
        Status changes are validated: only the allowed transitions are shown. Resolved and
        cancelled states come from the fix-confirmation and cancellation workflows.
      </p>
      {allowed.length > 0 ? (
        <>
          <label className="field">
            <span className="field__label">Reason / note</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="field-row">
            {allowed.map((status) => (
              <button
                key={status}
                type="button"
                className="button"
                onClick={() => void transition(status)}
              >
                → {status.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="page__note">
          {record.status === 'resolved' && 'Close the incident when the paperwork is done, or reopen it if the issue returned.'}
          {record.status === 'closed' && 'This incident is closed. Reopen it if the issue returned.'}
          {record.status === 'cancelled' && 'This incident is cancelled.'}
        </p>
      )}
      {message && <p className="form-errors" role="alert">{message}</p>}
      <IssueStatusControls record={record} onChanged={onChanged} />
    </div>
  );
}

const ISSUE_TRANSITIONS: Record<string, string[]> = {
  unknown: ['investigating'],
  investigating: ['temporary_fix', 'resolved', 'unresolved', 'escalated'],
  temporary_fix: ['investigating', 'resolved', 'unresolved', 'recurring'],
  resolved: ['recurring', 'unresolved'],
  unresolved: ['investigating', 'escalated', 'temporary_fix'],
  recurring: ['investigating', 'temporary_fix', 'resolved'],
  escalated: ['investigating', 'resolved', 'unresolved'],
};

function IssueStatusControls({
  record,
  onChanged,
}: {
  record: IncidentRecord;
  onChanged: () => void;
}): JSX.Element {
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const allowed = ISSUE_TRANSITIONS[record.issueStatus] ?? [];

  async function transition(issueStatus: string): Promise<void> {
    setMessage(null);
    try {
      await apiClient.changeIssueStatus(record.id, issueStatus, note || undefined);
      setNote('');
      onChanged();
    } catch (caught) {
      setMessage(caught instanceof ApiClientError ? caught.message : 'Transition failed.');
    }
  }

  return (
    <div>
      <h3 className="subsection">Issue status: {record.issueStatus.replace(/_/g, ' ')}</h3>
      {allowed.length > 0 && (
        <>
          <label className="field">
            <span className="field__label">Note</span>
            <input value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div className="field-row">
            {allowed.map((issueStatus) => (
              <button
                key={issueStatus}
                type="button"
                className="button button--secondary"
                onClick={() => void transition(issueStatus)}
              >
                → {issueStatus.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </>
      )}
      {message && <p className="form-errors" role="alert">{message}</p>}
    </div>
  );
}

function ResolutionBlock({
  record,
  onChanged,
  canManage,
}: {
  record: IncidentRecord;
  onChanged: () => void;
  canManage: boolean;
}): JSX.Element {
  const [summary, setSummary] = useState(record.resolutionSummary ?? '');
  const [reopenReason, setReopenReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function close(): Promise<void> {
    setMessage(null);
    try {
      await apiClient.closeIncident(record.id, summary.trim());
      onChanged();
    } catch (caught) {
      setMessage(caught instanceof ApiClientError ? caught.message : 'Close failed.');
    }
  }

  async function reopen(): Promise<void> {
    setMessage(null);
    try {
      await apiClient.reopenIncident(record.id, reopenReason.trim() || 'Issue returned.');
      setReopenReason('');
      onChanged();
    } catch (caught) {
      setMessage(caught instanceof ApiClientError ? caught.message : 'Reopen failed.');
    }
  }

  if (record.status === 'resolved') {
    return (
      <div className="inline-form">
        <h3 className="subsection">Resolution summary</h3>
        <label className="field">
          <span className="field__label">Summary (required to close)</span>
          <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} />
        </label>
        <div className="field-row">
          {canManage && (
            <button type="button" className="button" onClick={() => void close()}>
              Close incident
            </button>
          )}
          <button type="button" className="button button--secondary" onClick={() => void reopen()}>
            Reopen incident
          </button>
          <label className="field">
            <span className="field__label">Reopening reason</span>
            <input value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} />
          </label>
        </div>
        {message && <p className="form-errors" role="alert">{message}</p>}
      </div>
    );
  }
  if (record.status === 'closed') {
    return (
      <div className="inline-form">
        <p className="page__note page__note--top">
          Closed {record.closedAt ? formatDate(record.closedAt) : ''} · Resolution summary:{' '}
          {record.resolutionSummary ?? '—'}
        </p>
        <label className="field">
          <span className="field__label">Reopening reason</span>
          <input value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} />
        </label>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void reopen()}
        >
          Reopen incident
        </button>
        {message && <p className="form-errors" role="alert">{message}</p>}
      </div>
    );
  }
  return <></>;
}

// ---------------------------------------------------------------------------
// Root cause
// ---------------------------------------------------------------------------

function RootCauseSection({
  record,
  onChanged,
  canManage,
}: {
  record: IncidentRecord;
  onChanged: () => void;
  canManage: boolean;
}): JSX.Element {
  const [text, setText] = useState(record.rootCause.text ?? '');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const history = useApi(
    () =>
      showHistory
        ? apiClient.getRootCauseHistory(record.id).then((r) => r.history)
        : Promise.resolve([] as Array<{ at: string; by: string; byUsername: string | null; from: string; to: string; note: string | null }>),
    [showHistory, record.id],
  );

  async function run(action: () => Promise<unknown>): Promise<void> {
    setMessage(null);
    try {
      await action();
      onChanged();
      setNote('');
    } catch (caught) {
      setMessage(caught instanceof ApiClientError ? caught.message : 'Request failed.');
    }
  }

  const locked = record.status === 'closed' || record.status === 'cancelled';
  const confirmed = record.rootCause.status === 'confirmed';

  return (
    <section className="card incident-section" aria-label="Root cause">
      <h2>
        Root cause <RootCauseStatusBadge status={record.rootCause.status} size="sm" />
      </h2>
      {record.rootCause.text ? (
        <p className="root-cause-text">{record.rootCause.text}</p>
      ) : (
        <p className="page__note">No root cause recorded yet.</p>
      )}
      {record.rootCause.confirmationNote && (
        <p className="confirmation-note">Confirmation note: {record.rootCause.confirmationNote}</p>
      )}
      {record.rootCause.rejectionReason && (
        <p className="confirmation-note">Rejection reason: {record.rootCause.rejectionReason}</p>
      )}
      {!locked && (
        <>
          {!confirmed && (
            <>
              <label className="field">
                <span className="field__label">Suspected root cause</span>
                <textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={2}
                  data-testid="root-cause-text"
                />
              </label>
              <div className="field-row">
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() =>
                    void run(() =>
                      apiClient.updateRootCause(record.id, {
                        text: text.trim(),
                        status: 'suspected',
                      }),
                    )
                  }
                >
                  Record as suspected
                </button>
                {record.rootCause.status === 'suspected' && (
                  <>
                    <button
                      type="button"
                      className="button button--danger-outline"
                      onClick={() => {
                        const reason = window.prompt('Rejection reason (required):');
                        if (!reason) return;
                        void run(() => apiClient.rejectRootCause(record.id, reason));
                      }}
                    >
                      Reject root cause
                    </button>
                  </>
                )}
              </div>
            </>
          )}
          {canManage && record.rootCause.status === 'suspected' && (
            <div className="inline-form">
              <h3 className="subsection">Confirm root cause</h3>
              <p className="page__note">
                Confirmation is a human decision. A note is mandatory and the event is audited.
              </p>
              <label className="field">
                <span className="field__label">Confirmation note *</span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                  data-testid="root-cause-confirm-note"
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={note.trim().length < 3}
                onClick={() => void run(() => apiClient.confirmRootCause(record.id, note.trim()))}
              >
                Confirm root cause
              </button>
            </div>
          )}
        </>
      )}
      {record.rootCause.confirmedAt && (
        <p className="page__note">
          Confirmed {formatDate(record.rootCause.confirmedAt)}
          {record.rootCause.confirmedBy ? ` by ${record.rootCause.confirmedBy.slice(-6)}` : ''}.
        </p>
      )}
      <button
        type="button"
        className="link-button"
        onClick={() => setShowHistory((previous) => !previous)}
      >
        {showHistory ? 'Hide' : 'Show'} confirmation history
      </button>
      {showHistory && (
        <ul className="history-list">
          {(history.data ?? []).map((entry) => (
            <li key={`${entry.at}-${entry.to}`}>
              <span className="history-list__meta">
                {formatDate(entry.at)} · {entry.byUsername ?? entry.by.slice(-6)}
              </span>
              <span>
                {entry.from} → {entry.to}
              </span>
              {entry.note && <span className="confirmation-note"> · {entry.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="form-errors" role="alert">{message}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------

function FixSection({
  record,
  kind,
  title,
  onChanged,
  canManage,
}: {
  record: IncidentRecord;
  kind: 'temporary' | 'permanent';
  title: string;
  onChanged: () => void;
  canManage: boolean;
}): JSX.Element {
  const fix = kind === 'temporary' ? record.temporaryFix : record.permanentFix;
  const [description, setDescription] = useState('');
  const [result, setResult] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const locked = record.status === 'closed' || record.status === 'cancelled';
  const confirmed = fix?.status === 'confirmed';

  async function run(action: () => Promise<unknown>): Promise<void> {
    setMessage(null);
    try {
      await action();
      onChanged();
      setDescription('');
      setResult('');
      setNote('');
    } catch (caught) {
      setMessage(caught instanceof ApiClientError ? caught.message : 'Request failed.');
    }
  }

  const recordFix = kind === 'temporary' ? apiClient.recordTemporaryFix : apiClient.recordPermanentFix;
  const confirmFix = kind === 'temporary' ? apiClient.confirmTemporaryFix : apiClient.confirmPermanentFix;

  return (
    <section className="card incident-section" aria-label={title}>
      <h2>
        {title} {fix ? <ConfirmedBadge confirmed={confirmed} /> : null}
      </h2>
      {fix ? (
        <div>
          <p className="root-cause-text">{fix.description}</p>
          {fix.result && <p className="page__note">Observed result: {fix.result}</p>}
          {fix.notes && <p className="confirmation-note">Notes: {fix.notes}</p>}
          <p className="page__note">
            Recorded {formatDate(fix.recordedAt)}
            {confirmed && fix.confirmedAt
              ? ` · Confirmed ${formatDate(fix.confirmedAt)} by ${(fix.confirmedBy ?? '').slice(-6)}`
              : ' · Not yet confirmed'}
          </p>
          {!confirmed && !locked && canManage && (
            <div className="inline-form">
              <h3 className="subsection">Confirm this fix</h3>
              <p className="page__note">
                Confirming a fix records that a human verified the observed result. Nothing is
                confirmed automatically, and an AI recommendation alone can never confirm a fix.
              </p>
              <label className="field">
                <span className="field__label">Observed result</span>
                <input value={result} onChange={(event) => setResult(event.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">Confirmation note *</span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                  data-testid={`${kind}-fix-confirm-note`}
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={note.trim().length < 3}
                onClick={() =>
                  void run(() => confirmFix(record.id, note.trim(), result.trim() || undefined))
                }
              >
                Confirm {kind} fix
              </button>
            </div>
          )}
        </div>
      ) : (
        !locked && (
          <div className="inline-form">
            <label className="field">
              <span className="field__label">Fix description *</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                placeholder={kind === 'temporary' ? 'e.g. Bypassed the clogged filter' : 'e.g. Replaced the hydraulic filter element'}
              />
            </label>
            <label className="field">
              <span className="field__label">Observed result</span>
              <input value={result} onChange={(event) => setResult(event.target.value)} />
            </label>
            <button
              type="button"
              className="button"
              disabled={description.trim().length < 3}
              onClick={() =>
                void run(() =>
                  recordFix(record.id, {
                    description: description.trim(),
                    result: result.trim() || undefined,
                  }),
                )
              }
            >
              Record {kind} fix
            </button>
            {kind === 'permanent' && (
              <p className="page__note">
                Recording a permanent fix does NOT mark it successful - the fix must be
                confirmed separately with an explicit note.
              </p>
            )}
          </div>
        )
      )}
      {message && <p className="form-errors" role="alert">{message}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function ActionsSection({
  incidentId,
  record,
  actions,
  onChanged,
}: {
  incidentId: string;
  record: IncidentRecord;
  actions: { data: IncidentActionRecord[] | null; error: ApiClientError | null; isLoading: boolean; refetch: () => void };
  onChanged: () => void;
}): JSX.Element {
  const [actionType, setActionType] = useState('technician');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState('');
  const [resultStatus, setResultStatus] = useState('not_tested');
  const [performedAt, setPerformedAt] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const locked = record.status === 'closed' || record.status === 'cancelled';

  async function recordAction(): Promise<void> {
    setMessage(null);
    try {
      await apiClient.recordIncidentAction(incidentId, {
        actionType,
        description: description.trim(),
        result: actionType === 'technician' && result.trim() ? result.trim() : undefined,
        resultStatus: actionType === 'technician' ? resultStatus : 'not_tested',
        performedAt: performedAt || undefined,
      });
      setDescription('');
      setResult('');
      setResultStatus('not_tested');
      onChanged();
    } catch (caught) {
      setMessage(caught instanceof ApiClientError ? caught.message : 'Could not record the action.');
    }
  }

  async function confirmAction(action: IncidentActionRecord): Promise<void> {
    const note = window.prompt('Confirmation note (required):');
    if (!note) return;
    setMessage(null);
    try {
      await apiClient.confirmIncidentAction(incidentId, action.id, note);
      onChanged();
    } catch (caught) {
      setMessage(caught instanceof ApiClientError ? caught.message : 'Could not confirm the action.');
    }
  }

  const technicianActions = (actions.data ?? []).filter((action) => action.actionType === 'technician');
  const otherActions = (actions.data ?? []).filter((action) => action.actionType !== 'technician');

  return (
    <section className="card incident-section" aria-label="Actions">
      <h2>Technician actions</h2>
      <p className="page__note page__note--top">
        A technician action is work a human performed and recorded. AI suggestions are listed
        separately and can never become confirmed actions.
      </p>

      {!locked && (
        <div className="inline-form">
          <div className="field-row">
            <label className="field">
              <span className="field__label">Action type</span>
              <select value={actionType} onChange={(event) => setActionType(event.target.value)}>
                <option value="technician">Technician action</option>
                <option value="manual">Manual reference</option>
                <option value="other">Other note</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">Performed at</span>
              <input
                type="datetime-local"
                value={performedAt}
                onChange={(event) => setPerformedAt(event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">Description *</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              data-testid="action-description"
            />
          </label>
          {actionType === 'technician' && (
            <>
              <label className="field">
                <span className="field__label">Observed result</span>
                <input value={result} onChange={(event) => setResult(event.target.value)} />
              </label>
              <label className="field">
                <span className="field__label">Result status</span>
                <select value={resultStatus} onChange={(event) => setResultStatus(event.target.value)}>
                  {['not_tested', 'successful', 'unsuccessful', 'partially_successful', 'inconclusive', 'temporary_improvement', 'worsened_condition'].map(
                    (option) => (
                      <option key={option} value={option}>{option.replace(/_/g, ' ')}</option>
                    ),
                  )}
                </select>
              </label>
              <p className="page__note">
                Recording a result does NOT confirm it. Confirmation is a separate explicit act.
              </p>
            </>
          )}
          <button
            type="button"
            className="button"
            disabled={description.trim().length < 3}
            onClick={() => void recordAction()}
          >
            Record action
          </button>
        </div>
      )}

      {actions.isLoading && <LoadingState message="Loading actions…" />}
      {actions.error && <ErrorState error={actions.error} onRetry={actions.refetch} title="Could not load actions" />}
      {!actions.isLoading && !actions.error && technicianActions.length === 0 && otherActions.length === 0 && (
        <p className="page__note">No actions recorded on this incident yet.</p>
      )}

      <ul className="action-list">
        {technicianActions.map((action) => (
          <li key={action.id} className="action-card">
            <div className="action-card__header">
              <strong>{action.description}</strong>{' '}
              <ConfirmedBadge confirmed={action.confirmed} />
            </div>
            <span className="action-card__meta">
              {formatDate(action.performedAt)} · result: {action.resultStatus.replace(/_/g, ' ')}
              {action.result ? ` — ${action.result}` : ''}
            </span>
            {action.confirmed && action.confirmedAt && (
              <span className="confirmation-note">
                Confirmed {formatDate(action.confirmedAt)} by {(action.confirmedBy ?? '').slice(-6)}
              </span>
            )}
            {!action.confirmed && !locked && (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void confirmAction(action)}
              >
                Confirm action result
              </button>
            )}
          </li>
        ))}
      </ul>

      {otherActions.length > 0 && (
        <>
          <h3 className="subsection">Suggestions and references (never technician actions)</h3>
          <ul className="action-list">
            {otherActions.map((action) => (
              <li
                key={action.id}
                className={`action-card ${action.actionType === 'assistant_suggestion' ? 'action-card--suggestion' : 'action-card--manual'}`}
              >
                <strong>{action.description}</strong>
                <span className="action-card__meta">
                  {action.actionType === 'assistant_suggestion'
                    ? 'AI suggestion - not confirmed work'
                    : `Manual reference${action.sourceManualVersion ? ` v${action.sourceManualVersion}` : ''}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {message && <p className="form-errors" role="alert">{message}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Similar incidents
// ---------------------------------------------------------------------------

function SimilarSection({
  similar,
}: {
  similar: { data: SimilarIncidentRecord[] | null; error: ApiClientError | null; isLoading: boolean; refetch: () => void };
}): JSX.Element {
  return (
    <section className="card incident-section" aria-label="Similar incidents">
      <h2>Similar historical incidents</h2>
      <div className="historical-disclaimer">
        <span className="historical-disclaimer__icon" aria-hidden="true">⚠</span>
        <span>
          Historical evidence is supplementary context, not proof. A similar past incident does
          NOT confirm the current root cause, and a previous fix will not necessarily solve this
          problem. Manual instructions always take precedence.
        </span>
      </div>

      {similar.isLoading && <LoadingState message="Searching historical incidents…" />}
      {similar.error && (
        <ErrorState error={similar.error} onRetry={similar.refetch} title="Could not search similar incidents" />
      )}
      {!similar.isLoading && !similar.error && (similar.data ?? []).length === 0 && (
        <EmptyState
          title="No similar incidents found"
          message="Historical memory grows as incidents are resolved with confirmed root causes and fixes."
        />
      )}
      {(similar.data ?? []).map((item) => (
        <div
          key={item.incidentId}
          className={`similar-card ${item.confirmed ? 'similar-card--confirmed' : 'similar-card--speculative'}`}
          data-testid={`similar-${item.incidentNumber}`}
        >
          <div className="similar-card__header">
            <strong>
              <Link to={`/incidents/${item.incidentId}`}>
                {item.incidentNumber}: {item.title}
              </Link>
            </strong>{' '}
            {item.confirmed ? (
              <span className="ibadge ibadge--ok ibadge--sm" data-status="confirmed">
                <span className="ibadge__icon" aria-hidden="true">✓</span> Confirmed outcome
              </span>
            ) : (
              <span className="ibadge ibadge--warn ibadge--sm" data-status="speculative">
                <span className="ibadge__icon" aria-hidden="true">◐</span> Speculative
              </span>
            )}
          </div>
          <div className="similar-card__reasons">
            {item.similarityReasons.map((reason) => (
              <span key={reason} className="chip">{reason}</span>
            ))}
            <span className="similar-card__score">score {(item.similarityScore * 100).toFixed(0)}%</span>
          </div>
          <div className="similar-card__meta">
            <IncidentStatusBadge status={item.status} size="sm" />{' '}
            <IssueStatusBadge status={item.issueStatus} size="sm" />{' '}
            <RootCauseStatusBadge status={item.rootCauseStatus} size="sm" /> ·{' '}
            {formatDate(item.resolvedAt ?? item.createdAt)}
          </div>
          {item.errorCodes.length > 0 && (
            <div className="similar-card__codes">
              Codes: {item.errorCodes.join(', ')}
            </div>
          )}
          {item.symptoms.length > 0 && (
            <div className="similar-card__symptoms">
              Symptoms: {item.symptoms.slice(0, 3).join('; ')}
            </div>
          )}
          {item.confirmedRootCause && (
            <p className="root-cause-text">
              Confirmed root cause: {item.confirmedRootCause}
            </p>
          )}
          {item.confirmedFix && (
            <p className="root-cause-text">Confirmed fix: {item.confirmedFix}</p>
          )}
          {!item.confirmedRootCause && (
            <p className="confirmation-note">No confirmed root cause for this incident.</p>
          )}
        </div>
      ))}
      <p className="page__footnote">
        Displaying similar history for machine model context · confirmed outcomes rank above
        speculative history
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function TimelineSection({
  timeline,
}: {
  timeline: { data: IncidentTimelineEventRecord[] | null; error: ApiClientError | null; isLoading: boolean; refetch: () => void };
}): JSX.Element {
  return (
    <section className="card incident-section" aria-label="Timeline">
      <h2>Timeline</h2>
      {timeline.isLoading && <LoadingState message="Loading timeline…" />}
      {timeline.error && (
        <ErrorState error={timeline.error} onRetry={timeline.refetch} title="Could not load the timeline" />
      )}
      {!timeline.isLoading && !timeline.error && (timeline.data ?? []).length === 0 && (
        <p className="page__note">No events recorded yet.</p>
      )}
      <ul className="timeline">
        {(timeline.data ?? [])
          .slice()
          .reverse()
          .map((event) => (
            <li key={event.id} className="timeline__event">
              <span className="timeline__when">{formatDate(event.at)}</span>
              <div className="timeline__body">
                <span className="timeline__type">{timelineLabel(event.type)}</span>{' '}
                {event.actorUsername && (
                  <span className="timeline__actor">by {event.actorUsername}</span>
                )}
                {typeof event.previous === 'string' && typeof event.next === 'string' && (
                  <span className="timeline__actor">
                    {' '}({event.previous.replace(/_/g, ' ')} → {event.next.replace(/_/g, ' ')})
                  </span>
                )}
                {event.note && <div className="timeline__note">{event.note}</div>}
              </div>
            </li>
          ))}
      </ul>
    </section>
  );
}

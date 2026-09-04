import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  apiClient,
  ApiClientError,
  type MessageRecord,
  type TechnicianActionRecord,
} from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { ErrorState, LoadingState } from '../components/states';
import { StatusBadge } from '../components/status-badge';
import { CitationPreview } from '../components/citation-preview';
import { RetrievalTrace } from '../components/retrieval-trace';
import { Button, ConfirmDialog, DropdownMenu, Field, Modal, TextInput } from '../components/ui';
import { useToast } from '../lib/toast';
import './page.css';
import './chat.css';

const ISSUE_STATUSES = [
  'unknown',
  'investigating',
  'temporary_fix',
  'resolved',
  'unresolved',
  'recurring',
  'escalated',
] as const;

function ragTone(status: string | null): 'ok' | 'degraded' | 'down' | 'disabled' | 'unknown' {
  if (status === 'answered') return 'ok';
  if (status === 'clarification_required') return 'degraded';
  if (status === 'insufficient_evidence' || status === 'conflicting_evidence') return 'down';
  if (status === 'generation_failed' || status === 'processing_unavailable') return 'down';
  return 'unknown';
}

function ragLabel(status: string | null): string {
  switch (status) {
    case 'answered':
      return 'Answered from manuals';
    case 'clarification_required':
      return 'Clarification required';
    case 'insufficient_evidence':
      return 'Insufficient evidence';
    case 'conflicting_evidence':
      return 'Conflicting evidence';
    case 'generation_failed':
    case 'processing_unavailable':
      return 'Generation failed';
    default:
      return status ?? 'Message';
  }
}

export function ConversationDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const conversationId = id ?? '';
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [actions, setActions] = useState<TechnicianActionRecord[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [retryContent, setRetryContent] = useState<string | null>(null);
  const [source, setSource] = useState<MessageRecord['sources'][number] | null>(null);
  const [traceMessage, setTraceMessage] = useState<MessageRecord | null>(null);
  const [issueStatus, setIssueStatus] = useState('');
  const [confirmationNote, setConfirmationNote] = useState('');
  const [actionText, setActionText] = useState('');
  const [actionResult, setActionResult] = useState('');
  const [actionStatus, setActionStatus] = useState('completed');
  const [closeNote, setCloseNote] = useState('');
  const [creatingIncident, setCreatingIncident] = useState(false);
  const [incidentError, setIncidentError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const conversationQuery = useApi(
    () => apiClient.getConversation(conversationId),
    [conversationId],
  );
  const messagesQuery = useApi(
    () => apiClient.listMessages(conversationId).then((r) => r.data),
    [conversationId],
  );
  const actionsQuery = useApi(
    () => apiClient.listActions(conversationId).then((r) => r.data),
    [conversationId],
  );

  useEffect(() => {
    if (messagesQuery.data) setMessages(messagesQuery.data);
  }, [messagesQuery.data]);
  useEffect(() => {
    if (actionsQuery.data) setActions(actionsQuery.data);
  }, [actionsQuery.data]);
  useEffect(() => {
    if (conversationQuery.data?.conversation.issueStatus) {
      setIssueStatus(conversationQuery.data.conversation.issueStatus);
    }
  }, [conversationQuery.data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, pending]);

  const conversation = conversationQuery.data?.conversation;
  const active = conversation?.status === 'active';

  async function submit(content: string): Promise<void> {
    if (!content.trim() || pending || !active) return;
    setPending(true);
    setSendError(null);
    const clientRequestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const optimistic: MessageRecord = {
      id: `pending-${clientRequestId}`,
      conversationId,
      role: 'user',
      messageType: 'question',
      content,
      status: 'pending',
      sources: [],
      suggestedActions: [],
      clarification: null,
      refusalReason: null,
      ragStatus: null,
      confidence: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    try {
      const result = await apiClient.sendMessage(conversationId, content, clientRequestId);
      setMessages((current) => [
        ...current.filter((item) => item.id !== optimistic.id),
        result.userMessage,
        result.message,
      ]);
      setDraft('');
      setRetryContent(null);
      conversationQuery.refetch();
    } catch (caught) {
      setSendError(caught instanceof ApiClientError ? caught.message : 'Send failed.');
      setRetryContent(content);
      setMessages((current) =>
        current.map((item) => (item.id === optimistic.id ? { ...item, status: 'failed' } : item)),
      );
      messagesQuery.refetch();
    } finally {
      setPending(false);
    }
  }

  async function onSend(event: FormEvent): Promise<void> {
    event.preventDefault();
    await submit(draft);
  }

  async function onRecordAction(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!actionText.trim()) return;
    await apiClient.recordAction(conversationId, {
      action: actionText,
      result: actionResult || undefined,
      status: actionStatus,
    });
    setActionText('');
    setActionResult('');
    actionsQuery.refetch();
    conversationQuery.refetch();
  }

  async function onIssueStatus(event: FormEvent): Promise<void> {
    event.preventDefault();
    await apiClient.updateIssueStatus(conversationId, {
      issueStatus,
      confirmationNote: confirmationNote || undefined,
    });
    setConfirmationNote('');
    conversationQuery.refetch();
  }

  async function onCreateIncident(): Promise<void> {
    setCreatingIncident(true);
    setIncidentError(null);
    try {
      const result = await apiClient.createIncidentFromConversation(conversationId, {});
      navigate(`/incidents/${result.incident.id}`);
    } catch (caught) {
      setIncidentError(caught instanceof ApiClientError ? caught.message : 'Could not create the incident.');
      setCreatingIncident(false);
    }
  }

  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function openRename(): void {
    setRenameValue(conversation?.title ?? '');
    setManageError(null);
    setRenameOpen(true);
  }

  async function saveRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    setRenameSaving(true);
    setManageError(null);
    try {
      await apiClient.updateConversation(conversationId, { title: renameValue.trim() || 'Untitled conversation' });
      toast.success('Conversation renamed.');
      setRenameOpen(false);
      conversationQuery.refetch();
    } catch (caught) {
      setManageError(caught instanceof ApiClientError ? caught.message : 'Could not rename.');
    } finally {
      setRenameSaving(false);
    }
  }

  async function archiveConversation(): Promise<void> {
    try {
      await apiClient.archiveConversation(conversationId);
      toast.success('Conversation archived.');
      navigate('/conversations');
    } catch (caught) {
      toast.error(caught instanceof ApiClientError ? caught.message : 'Could not archive.');
    }
  }

  async function deleteConversation(): Promise<void> {
    setDeleting(true);
    try {
      await apiClient.deleteConversation(conversationId);
      toast.success('Conversation deleted.');
      navigate('/conversations');
    } catch (caught) {
      toast.error(caught instanceof ApiClientError ? caught.message : 'Could not delete.');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (conversationQuery.isInitialLoading) return <LoadingState message="Loading conversation…" />;
  if (conversationQuery.error) {
    return <ErrorState error={conversationQuery.error} onRetry={conversationQuery.refetch} />;
  }
  if (!conversation) return <p>Conversation not found.</p>;

  return (
    <div className="page chat-page">
      <header className="page__header">
        <p className="crumb">
          <Link to="/conversations">Conversations</Link>
        </p>
        <div className="conversation-title-row">
          <h1>{conversation.title || 'Untitled conversation'}</h1>
          <DropdownMenu
            label={<span aria-label="Conversation actions">⋮ Actions</span>}
            items={[
              { node: 'Rename', onSelect: openRename },
              conversation.status !== 'archived'
                ? { node: 'Archive', onSelect: () => void archiveConversation(), disabled: !active }
                : { node: 'Archived', disabled: true },
              { node: 'Delete', danger: true, onSelect: () => setConfirmDelete(true) },
            ]}
          />
        </div>
        <p className="page__lead">{conversation.issueSummary || 'No issue summary recorded.'}</p>
        <div className="chat-meta">
          <StatusBadge status={conversation.status === 'active' ? 'ok' : 'disabled'} label={conversation.status} />
          <StatusBadge status="unknown" label={`Issue: ${conversation.issueStatus.replace('_', ' ')}`} />
          <span>{conversation.machineLabel || conversation.machineModelLabel || 'No machine'}</span>
          {conversation.manualTitle && (
            <span>
              {conversation.manualTitle}
              {conversation.manualVersion ? ` v${conversation.manualVersion}` : ''}
            </span>
          )}
        </div>
        <div className="conversation-incident-actions">
          {conversation.incidentIds.length > 0 ? (
            <p className="page__note">
              Incident report:{' '}
              {conversation.incidentIds.map((incidentId, index) => (
                <span key={incidentId}>
                  {index > 0 && ', '}
                  <Link to={`/incidents/${incidentId}`}>{incidentId.slice(-6)}</Link>
                </span>
              ))}
            </p>
          ) : (
            <div className="field-row">
              <button
                type="button"
                className="button"
                disabled={creatingIncident || !active}
                onClick={() => void onCreateIncident()}
              >
                {creatingIncident ? 'Creating…' : '+ Create incident from this conversation'}
              </button>
              <p className="page__note">
                Copies only explicit facts (confirmed findings, error codes, symptoms, confirmed
                technician actions). AI suggestions are never imported.
              </p>
            </div>
          )}
          {incidentError && <p className="form-errors" role="alert">{incidentError}</p>}
        </div>
      </header>

      <section className="card lane-legend" aria-label="Evidence lanes">
        <h2 className="lane-legend__title">Evidence lanes in this conversation</h2>
        <ul className="lane-legend__list">
          <li className="lane-legend__item">
            <span className="lane-chip lane-chip--manual">Manual</span>
            <span>Authoritative. Cited with page numbers. Always takes precedence.</span>
          </li>
          <li className="lane-legend__item">
            <span className="lane-chip lane-chip--incident">Historical</span>
            <span>Similar past incidents. Supplementary context — not proof of this diagnosis.</span>
          </li>
          <li className="lane-legend__item">
            <span className="lane-chip lane-chip--maintenance">Maintenance</span>
            <span>Work performed on this machine. Non-causal context, never evidence of a cause.</span>
          </li>
        </ul>
      </section>

      <section className="card chat-thread" aria-live="polite">
        {messagesQuery.isInitialLoading && <LoadingState message="Loading messages…" />}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`bubble bubble--${message.role} bubble--${message.messageType} ${message.status === 'failed' ? 'bubble--failed' : ''}`}
          >
            <header>
              <strong>{message.role === 'user' ? 'Technician' : message.role === 'assistant' ? 'Assistant' : 'System'}</strong>
              {message.ragStatus && (
                <StatusBadge status={ragTone(message.ragStatus)} label={ragLabel(message.ragStatus)} size="sm" />
              )}
              {message.status === 'pending' && <StatusBadge status="unknown" label="Pending" size="sm" />}
              {message.role === 'assistant' && message.retrievalMetadata && (
                <button
                  type="button"
                  className="button button--secondary button--sm"
                  onClick={() => setTraceMessage(message)}
                  data-testid={`trace-${message.id}`}
                >
                  Retrieval trace
                </button>
              )}
            </header>
            <pre className="bubble__content">{message.content}</pre>
            {message.clarification && <p className="banner banner--warn">{message.clarification}</p>}
            {message.refusalReason && <p className="banner banner--error">{message.refusalReason}</p>}
            {message.suggestedActions.length > 0 && (
              <div className="suggestions">
                <h3>Suggested checks (not performed)</h3>
                <ul>
                  {message.suggestedActions.map((item) => (
                    <li key={item.id}>
                      {item.description} <em>({item.status})</em>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {message.sources.length > 0 && (
              <ul className="citations">
                {message.sources.map((item) => (
                  <li key={item.sourceId} className={`citation citation--${item.sourceType === 'incident' ? 'incident' : item.sourceType === 'maintenance' ? 'maintenance' : 'manual'}`}>
                    <span className={`lane-chip lane-chip--${item.sourceType === 'incident' ? 'incident' : item.sourceType === 'maintenance' ? 'maintenance' : 'manual'}`}>
                      {item.sourceType === 'incident' ? 'Historical' : item.sourceType === 'maintenance' ? 'Maintenance' : 'Manual'}
                    </span>
                    <button type="button" className="linkish" onClick={() => setSource(item)}>
                      {item.sourceType === 'maintenance'
                        ? `Maintenance record · ${item.manualTitle}`
                        : item.manualTitle}
                      {item.manualVersion ? `, version ${item.manualVersion}` : ''}
                      {item.sourceType !== 'maintenance' && item.pageStart
                        ? item.pageEnd && item.pageEnd !== item.pageStart
                          ? `, pages ${item.pageStart}–${item.pageEnd}`
                          : `, page ${item.pageStart}`
                        : ''}
                      {item.sourceType === 'maintenance' && item.daysBeforeIncident != null && (
                        <>
                          {' '}
                          · {item.daysBeforeIncident} days before
                          {item.correlationStrength
                            ? ` · correlation: ${item.correlationStrength}`
                            : ''}
                        </>
                      )}
                    </button>
                    {item.sourceType === 'maintenance' && (
                      <span className="maintenance-caption" data-testid="maintenance-caption">
                        Maintenance record — noted context, never causally linked to this
                        fault{item.notedByManual ? '; a serviced part is also mentioned in the manual (correlation, not causation)' : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
        {pending && <p className="pending-note">Retrieving evidence…</p>}
        <div ref={bottomRef} />
      </section>

      {sendError && (
        <div className="banner banner--error" role="alert">
          {sendError} Your question was kept. You can retry.
          {retryContent && (
            <button type="button" onClick={() => submit(retryContent)} disabled={pending}>
              Retry
            </button>
          )}
        </div>
      )}

      <form className="card composer" onSubmit={onSend}>
        <label htmlFor="chat-input">Question</label>
        <textarea
          id="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          disabled={!active || pending}
          placeholder={active ? 'Ask a technical question…' : 'Reopen the conversation to continue.'}
        />
        <button type="submit" disabled={!active || pending || !draft.trim()}>
          {pending ? 'Sending…' : 'Send'}
        </button>
      </form>

      <section className="card">
        <h2>Technician actions</h2>
        <p className="page__note page__note--top">
          Record what you actually did. Suggestions above are not actions and do not mark the machine repaired.
        </p>
        <ul className="action-log">
          {actions.map((item) => (
            <li key={item.id}>
              <strong>{item.action}</strong> — {item.status}
              {item.result ? ` · ${item.result}` : ''}
            </li>
          ))}
          {actions.length === 0 && <li>No technician-confirmed actions yet.</li>}
        </ul>
        {active && (
          <form className="form form--inline" onSubmit={onRecordAction}>
            <input value={actionText} onChange={(e) => setActionText(e.target.value)} placeholder="Action performed" required />
            <input value={actionResult} onChange={(e) => setActionResult(e.target.value)} placeholder="Result" />
            <select value={actionStatus} onChange={(e) => setActionStatus(e.target.value)}>
              <option value="planned">planned</option>
              <option value="attempted">attempted</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="not_applicable">not applicable</option>
            </select>
            <button type="submit">Record action</button>
          </form>
        )}
      </section>

      <section className="card">
        <h2>Issue status</h2>
        <form className="form" onSubmit={onIssueStatus}>
          <label>
            Status
            <select value={issueStatus} onChange={(e) => setIssueStatus(e.target.value)} disabled={!active}>
              {ISSUE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label>
            Confirmation note (required for resolved / unresolved / temporary / recurring / escalated)
            <textarea value={confirmationNote} onChange={(e) => setConfirmationNote(e.target.value)} rows={2} />
          </label>
          <button type="submit" disabled={!active}>
            Update issue status
          </button>
        </form>
        <div className="form__actions">
          {conversation.status === 'active' && (
            <button
              type="button"
              onClick={() => apiClient.closeConversation(conversationId, closeNote || undefined).then(() => conversationQuery.refetch())}
            >
              Close conversation
            </button>
          )}
          {conversation.status !== 'active' && (
            <button type="button" onClick={() => apiClient.reopenConversation(conversationId).then(() => conversationQuery.refetch())}>
              Reopen conversation
            </button>
          )}
        </div>
        {conversation.status === 'active' && (
          <label>
            Close note (required if the issue is still investigating)
            <input value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
          </label>
        )}
      </section>

      {source && <CitationPreview source={source} onClose={() => setSource(null)} />}
      {traceMessage && <RetrievalTrace message={traceMessage} onClose={() => setTraceMessage(null)} />}

      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title="Rename conversation"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenameOpen(false)} disabled={renameSaving}>Cancel</Button>
            <Button variant="primary" type="submit" form="rename-form" loading={renameSaving}>Save</Button>
          </>
        }
      >
        <form id="rename-form" className="ui-form" onSubmit={saveRename}>
          {manageError && <p className="form-errors" role="alert">{manageError}</p>}
          <Field label="Title" htmlFor="rename-title">
            <TextInput
              id="rename-title"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
            />
          </Field>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void deleteConversation()}
        title="Delete this conversation?"
        confirmLabel="Delete conversation"
        loading={deleting}
        irreversible
      >
        <p>
          This permanently removes the conversation and its messages. Incident records created
          from it are not deleted. This cannot be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}

import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiClient, ApiClientError } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { ErrorState, LoadingState } from '../components/states';
import './page.css';
import './chat.css';

export function ConversationNewPage(): JSX.Element {
  const navigate = useNavigate();
  const machines = useApi(() => apiClient.listMachines().then((r) => r.data));
  const models = useApi(() => apiClient.listModels().then((r) => r.data));
  const presetMachine = new URLSearchParams(window.location.search).get('machineId') ?? '';
  const [title, setTitle] = useState('');
  const [machineId, setMachineId] = useState(presetMachine);
  const [machineModelId, setMachineModelId] = useState('');
  const [manualId, setManualId] = useState('');
  const [issueSummary, setIssueSummary] = useState('');
  const [symptoms, setSymptoms] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedMachine = machines.data?.find((m) => m.id === machineId);
  const effectiveModelId = selectedMachine?.machineModelId || machineModelId;
  const manuals = useApi(
    () => apiClient.listManuals(effectiveModelId ? { machineModelId: effectiveModelId } : undefined).then((r) => r.data),
    [effectiveModelId],
  );

  const selectedManual = useMemo(
    () => manuals.data?.find((item) => item.id === manualId),
    [manuals.data, manualId],
  );

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: title || undefined,
        issueSummary: issueSummary || undefined,
        errorCodes: errorCode ? [errorCode] : undefined,
        symptoms: symptoms
          ? symptoms
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      };
      if (machineId) body.machineId = machineId;
      else if (machineModelId) body.machineModelId = machineModelId;
      if (manualId) {
        body.manualId = manualId;
        if (selectedManual?.documentVersion) body.manualVersion = selectedManual.documentVersion;
      }
      const created = await apiClient.createConversation(body);
      navigate(`/conversations/${created.conversation.id}`);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Could not create the conversation.');
    } finally {
      setPending(false);
    }
  }

  if (machines.isInitialLoading || models.isInitialLoading) {
    return <LoadingState message="Loading machines…" />;
  }
  if (machines.error) return <ErrorState error={machines.error} onRetry={machines.refetch} />;

  return (
    <div className="page">
      <header className="page__header">
        <h1>New troubleshooting conversation</h1>
        <p className="page__lead">Scope the thread to a machine or model so retrieval stays inside the right manuals.</p>
      </header>
      <form className="card form" onSubmit={onSubmit}>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Hydraulic startup alarm" />
        </label>
        <label>
          Machine
          <select
            value={machineId}
            onChange={(e) => {
              setMachineId(e.target.value);
              if (e.target.value) setMachineModelId('');
            }}
          >
            <option value="">Select a machine (optional if a model is chosen)</option>
            {(machines.data ?? []).map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.displayName || machine.assetTag}
              </option>
            ))}
          </select>
        </label>
        <label>
          Machine model
          <select
            value={selectedMachine?.machineModelId || machineModelId}
            onChange={(e) => setMachineModelId(e.target.value)}
            disabled={Boolean(machineId)}
          >
            <option value="">Select a model</option>
            {(models.data ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.manufacturer} {model.modelName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Manual
          <select value={manualId} onChange={(e) => setManualId(e.target.value)}>
            <option value="">All manuals for the model</option>
            {(manuals.data ?? []).map((manual) => (
              <option key={manual.id} value={manual.id}>
                {manual.title}
                {manual.documentVersion ? ` (v${manual.documentVersion})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Issue summary
          <textarea value={issueSummary} onChange={(e) => setIssueSummary(e.target.value)} maxLength={2000} rows={3} />
        </label>
        <label>
          Error code
          <input value={errorCode} onChange={(e) => setErrorCode(e.target.value)} placeholder="E-104" />
        </label>
        <label>
          Initial symptoms (one per line)
          <textarea value={symptoms} onChange={(e) => setSymptoms(e.target.value)} rows={3} />
        </label>
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="form__actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Start conversation'}
          </button>
          <Link to="/conversations">Cancel</Link>
        </div>
      </form>
    </div>
  );
}

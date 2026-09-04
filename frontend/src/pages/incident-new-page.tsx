/**
 * Incident creation form.
 *
 * The machine is required; the machine model is DERIVED from the selected
 * machine by the backend and shown here for verification (a mismatched model
 * is rejected server-side). Everything else is optional structured context.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../lib/use-api';
import { apiClient, ApiClientError, type MachineRecord, type ManualRecord } from '../lib/api-client';
import { useAuth } from '../lib/auth';
import { ErrorState, LoadingState } from '../components/states';
import './page.css';

interface FormState {
  title: string;
  description: string;
  machineId: string;
  symptoms: string;
  errorCodes: string;
  operatingConditions: string;
  severity: string;
  priority: string;
  assignedTo: string;
  manualId: string;
  manualVersion: string;
  tags: string;
  firstObservedAt: string;
  source: string;
}

const EMPTY: FormState = {
  title: '',
  description: '',
  machineId: '',
  symptoms: '',
  errorCodes: '',
  operatingConditions: '',
  severity: 'medium',
  priority: 'medium',
  assignedTo: '',
  manualId: '',
  manualVersion: '',
  tags: '',
  firstObservedAt: '',
  source: 'other',
};

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function IncidentNewPage(): JSX.Element {
  const navigate = useNavigate();
  const { user } = useAuth();
  const presetMachine = new URLSearchParams(window.location.search).get('machineId') ?? '';
  const [form, setForm] = useState<FormState>({ ...EMPTY, machineId: presetMachine });
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const canAssign = user?.role === 'admin' || user?.role === 'manager';

  const machines = useApi<MachineRecord[]>(() => apiClient.listMachines().then((r) => r.data));
  const users = useApi(
    () =>
      canAssign
        ? apiClient.listUsers().then((r) => r.users)
        : Promise.resolve([] as Array<{ id: string; username: string; fullName: string; role: string }>),
  );
  const manuals = useApi<ManualRecord[]>(() => apiClient.listManuals({ limit: 100 }).then((r) => r.data));

  const selectedMachine = useMemo(
    () => machines.data?.find((machine) => machine.id === form.machineId) ?? null,
    [machines.data, form.machineId],
  );

  useEffect(() => {
    // A machine change clears a stale manual selection unless the manual is
    // scoped to the new machine (or is model-wide for its model).
    if (form.manualId && selectedMachine) {
      const manual = manuals.data?.find((item) => item.id === form.manualId);
      if (manual && manual.machineId && manual.machineId !== form.machineId) {
        setForm((previous) => ({ ...previous, manualId: '' }));
      }
    }
  }, [form.machineId]); // eslint-disable-line react-hooks/exhaustive-deps

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors([]);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setErrors([]);

    const problems: string[] = [];
    if (form.title.trim().length < 3) problems.push('Title must be at least 3 characters.');
    if (form.description.trim().length < 3) problems.push('Description must be at least 3 characters.');
    if (!form.machineId) problems.push('A physical machine is required.');
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }

    setSubmitting(true);
    try {
      const incident = await apiClient.createIncident({
        title: form.title.trim(),
        description: form.description.trim(),
        source: form.source,
        machineId: form.machineId,
        assignedTo: form.assignedTo || null,
        severity: form.severity,
        priority: form.priority,
        symptoms: splitLines(form.symptoms),
        errorCodes: splitLines(form.errorCodes),
        operatingConditions: splitLines(form.operatingConditions),
        tags: splitLines(form.tags),
        manualId: form.manualId || undefined,
        manualVersion: form.manualVersion || undefined,
        firstObservedAt: form.firstObservedAt || undefined,
      });
      navigate(`/incidents/${incident.incident.id}`);
    } catch (caught) {
      setErrors([
        caught instanceof ApiClientError
          ? caught.message
          : 'The incident could not be created. Please try again.',
      ]);
      setSubmitting(false);
    }
  }

  if (machines.isInitialLoading) return <LoadingState message="Loading machines…" />;
  if (machines.error) {
    return (
      <ErrorState
        error={machines.error}
        onRetry={machines.refetch}
        title="Could not load machines"
      />
    );
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1>Report incident</h1>
        <p className="page__lead">
          Record a machine problem and the structured context around it. The machine model is
          derived from the selected machine; a mismatched model is rejected by the API.
        </p>
      </header>

      {errors.length > 0 && (
        <div className="form-errors" role="alert">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}

      <form className="form" onSubmit={(event) => void submit(event)}>
        <section className="card incident-section">
          <h2>What happened</h2>
          <label className="field">
            <span className="field__label">Title *</span>
            <input
              value={form.title}
              onChange={(event) => set('title', event.target.value)}
              maxLength={200}
              placeholder="e.g. Hydraulic press E-104 during startup"
            />
          </label>
          <label className="field">
            <span className="field__label">Description *</span>
            <textarea
              value={form.description}
              onChange={(event) => set('description', event.target.value)}
              rows={4}
              placeholder="What was observed, when, and on which machine."
            />
          </label>
          <label className="field">
            <span className="field__label">Source</span>
            <select value={form.source} onChange={(event) => set('source', event.target.value)}>
              <option value="other">Other (manual entry)</option>
              <option value="manual">Manual</option>
              <option value="import">Import</option>
              <option value="conversation">Conversation</option>
            </select>
            {form.source === 'conversation' && (
              <span className="field__hint">
                To copy facts from a conversation, use the “Create incident” action on that
                conversation instead - AI suggestions are never imported automatically.
              </span>
            )}
          </label>
          <label className="field">
            <span className="field__label">First observed</span>
            <input
              type="datetime-local"
              value={form.firstObservedAt}
              onChange={(event) => set('firstObservedAt', event.target.value)}
            />
          </label>
        </section>

        <section className="card incident-section">
          <h2>Machine</h2>
          <label className="field">
            <span className="field__label">Machine *</span>
            <select
              value={form.machineId}
              onChange={(event) => set('machineId', event.target.value)}
              data-testid="machine-select"
            >
              <option value="">Select a machine…</option>
              {(machines.data ?? []).map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.displayName || machine.assetTag}
                  {machine.modelSnapshot
                    ? ` (${machine.modelSnapshot.manufacturer} ${machine.modelSnapshot.modelName})`
                    : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="page__note">
            Machine model:{' '}
            {selectedMachine?.modelSnapshot
              ? `${selectedMachine.modelSnapshot.manufacturer} ${selectedMachine.modelSnapshot.modelName}`
              : 'derived from the selected machine'}
          </p>
          <label className="field">
            <span className="field__label">Linked manual</span>
            <select value={form.manualId} onChange={(event) => set('manualId', event.target.value)}>
              <option value="">None</option>
              {(manuals.data ?? []).map((manual) => (
                <option key={manual.id} value={manual.id}>
                  {manual.title}
                  {manual.documentVersion ? ` v${manual.documentVersion}` : ''}
                </option>
              ))}
            </select>
          </label>
          {form.manualId && (
            <label className="field">
              <span className="field__label">Manual version</span>
              <input
                value={form.manualVersion}
                onChange={(event) => set('manualVersion', event.target.value)}
                maxLength={100}
                placeholder="Optional - defaults to the manual's current version"
              />
            </label>
          )}
        </section>

        <section className="card incident-section">
          <h2>Context</h2>
          <label className="field">
            <span className="field__label">Symptoms (one per line)</span>
            <textarea
              value={form.symptoms}
              onChange={(event) => set('symptoms', event.target.value)}
              rows={3}
              placeholder={'Pressure drops on startup\nAlarm sounds after 2 minutes'}
            />
          </label>
          <label className="field">
            <span className="field__label">Error codes (one per line)</span>
            <textarea
              value={form.errorCodes}
              onChange={(event) => set('errorCodes', event.target.value)}
              rows={2}
              placeholder="E-104"
            />
          </label>
          <label className="field">
            <span className="field__label">Operating conditions (one per line)</span>
            <textarea
              value={form.operatingConditions}
              onChange={(event) => set('operatingConditions', event.target.value)}
              rows={3}
              placeholder={'60 bar operating pressure\nAmbient temperature 35 °C'}
            />
          </label>
          <label className="field">
            <span className="field__label">Tags (one per line)</span>
            <textarea
              value={form.tags}
              onChange={(event) => set('tags', event.target.value)}
              rows={2}
              placeholder={'hydraulics\nstartup'}
            />
          </label>
        </section>

        <section className="card incident-section">
          <h2>Priorities</h2>
          <div className="field-row">
            <label className="field">
              <span className="field__label">Severity</span>
              <select value={form.severity} onChange={(event) => set('severity', event.target.value)}>
                {['low', 'medium', 'high', 'critical'].map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Priority</span>
              <select value={form.priority} onChange={(event) => set('priority', event.target.value)}>
                {['low', 'medium', 'high', 'urgent'].map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          </div>
          {canAssign && (
            <label className="field">
              <span className="field__label">Assigned technician</span>
              <select value={form.assignedTo} onChange={(event) => set('assignedTo', event.target.value)}>
                <option value="">Unassigned</option>
                {(users.data ?? [])
                  .filter((item) => item.role === 'technician' || item.role === 'manager')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.fullName || item.username}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </section>

        <div className="form-actions">
          <button type="submit" className="button" disabled={submitting || machines.isLoading}>
            {submitting ? 'Creating…' : 'Create incident'}
          </button>
          <button type="button" className="button button--secondary" onClick={() => navigate('/incidents')}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Record maintenance performed on a machine.
 *
 * Part numbers are normalised server-side; performedAt must not be in the
 * future; the record becomes part of the machine's maintenance history lane.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../lib/use-api';
import { apiClient, ApiClientError, type MachineRecord } from '../lib/api-client';
import { ErrorState, LoadingState } from '../components/states';
import './page.css';

interface PartRow {
  partNumber: string;
  name: string;
  quantity: string;
}

interface FormState {
  machineId: string;
  maintenanceType: string;
  title: string;
  description: string;
  performedAt: string;
  performedByExternal: string;
  workOrderRef: string;
  componentsServiced: string;
  durationMinutes: string;
  downtimeMinutes: string;
  notes: string;
  parts: PartRow[];
}

const EMPTY: FormState = {
  machineId: '',
  maintenanceType: 'preventive',
  title: '',
  description: '',
  performedAt: new Date().toISOString().slice(0, 16),
  performedByExternal: '',
  workOrderRef: '',
  componentsServiced: '',
  durationMinutes: '',
  downtimeMinutes: '',
  notes: '',
  parts: [],
};

const MAINTENANCE_TYPES = [
  'preventive',
  'corrective',
  'inspection',
  'part_replacement',
  'calibration',
  'other',
];

export function MaintenanceNewPage(): JSX.Element {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const machines = useApi<MachineRecord[]>(() => apiClient.listMachines().then((r) => r.data));

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors([]);
  }

  function setPart(index: number, key: keyof PartRow, value: string): void {
    setForm((previous) => ({
      ...previous,
      parts: previous.parts.map((part, i) => (i === index ? { ...part, [key]: value } : part)),
    }));
    setErrors([]);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setErrors([]);

    const problems: string[] = [];
    if (!form.machineId) problems.push('A machine is required.');
    if (form.title.trim().length < 3) problems.push('Title must be at least 3 characters.');
    if (!form.performedAt) problems.push('Performed date is required.');
    if (new Date(form.performedAt).getTime() > Date.now() + 60_000) {
      problems.push('Work cannot have been performed in the future.');
    }
    for (const part of form.parts) {
      if (!part.partNumber.trim()) problems.push('Every part row needs a part number.');
    }
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }

    setSubmitting(true);
    try {
      const partsReplaced = form.parts
        .filter((part) => part.partNumber.trim())
        .map((part) => ({
          partNumber: part.partNumber.trim(),
          name: part.name.trim() || undefined,
          quantity: part.quantity ? Number(part.quantity) : 1,
        }));
      const result = await apiClient.createMaintenance({
        machineId: form.machineId,
        maintenanceType: form.maintenanceType,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        performedAt: new Date(form.performedAt).toISOString(),
        performedByExternal: form.performedByExternal.trim() || undefined,
        workOrderRef: form.workOrderRef.trim() || undefined,
        componentsServiced: form.componentsServiced
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : undefined,
        downtimeMinutes: form.downtimeMinutes ? Number(form.downtimeMinutes) : undefined,
        notes: form.notes.trim() || undefined,
        partsReplaced: partsReplaced.length > 0 ? partsReplaced : undefined,
      });
      navigate(`/machines/${result.maintenanceRecord.machineId}`);
    } catch (caught) {
      setErrors([
        caught instanceof ApiClientError
          ? caught.message
          : 'The maintenance record could not be created. Please try again.',
      ]);
      setSubmitting(false);
    }
  }

  if (machines.isInitialLoading) return <LoadingState message="Loading machines…" />;
  if (machines.error) {
    return <ErrorState error={machines.error} onRetry={machines.refetch} title="Could not load machines" />;
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1>Record maintenance</h1>
        <p className="page__lead">
          Structured facts about work performed. The record feeds the machine timeline and the
          non-causal maintenance lane in troubleshooting answers.
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
          <h2>What was done</h2>
          <div className="field-row">
            <label className="field">
              <span className="field__label">Machine *</span>
              <select
                value={form.machineId}
                onChange={(event) => set('machineId', event.target.value)}
                data-testid="maintenance-machine-select"
              >
                <option value="">Select a machine…</option>
                {(machines.data ?? []).map((machine) => (
                  <option key={machine.id} value={machine.id}>
                    {machine.displayName || machine.assetTag}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Type *</span>
              <select
                value={form.maintenanceType}
                onChange={(event) => set('maintenanceType', event.target.value)}
              >
                {MAINTENANCE_TYPES.map((type) => (
                  <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Performed at *</span>
              <input
                type="datetime-local"
                value={form.performedAt}
                onChange={(event) => set('performedAt', event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">Title *</span>
            <input
              value={form.title}
              onChange={(event) => set('title', event.target.value)}
              maxLength={200}
              placeholder="e.g. Quarterly lubrication"
            />
          </label>
          <label className="field">
            <span className="field__label">Description</span>
            <textarea
              value={form.description}
              onChange={(event) => set('description', event.target.value)}
              rows={3}
              placeholder="What was observed, done, or found."
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field__label">External contractor</span>
              <input
                value={form.performedByExternal}
                onChange={(event) => set('performedByExternal', event.target.value)}
                maxLength={150}
                placeholder="Optional"
              />
            </label>
            <label className="field">
              <span className="field__label">Work order reference</span>
              <input
                value={form.workOrderRef}
                onChange={(event) => set('workOrderRef', event.target.value)}
                maxLength={80}
                placeholder="WO-1234"
              />
            </label>
          </div>
        </section>

        <section className="card incident-section">
          <h2>Parts replaced</h2>
          <p className="page__note page__note--top">
            Part numbers are normalised on write so structured lookups match
            (e.g. “abc-123” and “ABC123” compare equal).
          </p>
          {form.parts.map((part, index) => (
            <div className="field-row" key={index}>
              <label className="field">
                <span className="field__label">Part number *</span>
                <input
                  value={part.partNumber}
                  onChange={(event) => setPart(index, 'partNumber', event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  value={part.name}
                  onChange={(event) => setPart(index, 'name', event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field__label">Quantity</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={part.quantity}
                  onChange={(event) => setPart(index, 'quantity', event.target.value)}
                />
              </label>
              <button
                type="button"
                className="button button--danger-outline"
                onClick={() =>
                  setForm((previous) => ({
                    ...previous,
                    parts: previous.parts.filter((_, i) => i !== index),
                  }))
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button button--secondary"
            onClick={() =>
              setForm((previous) => ({
                ...previous,
                parts: [...previous.parts, { partNumber: '', name: '', quantity: '1' }],
              }))
            }
          >
            + Add part
          </button>
        </section>

        <section className="card incident-section">
          <h2>Additional detail</h2>
          <label className="field">
            <span className="field__label">Components serviced (one per line)</span>
            <textarea
              value={form.componentsServiced}
              onChange={(event) => set('componentsServiced', event.target.value)}
              rows={2}
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span className="field__label">Duration (minutes)</span>
              <input
                type="number"
                min={0}
                max={10080}
                value={form.durationMinutes}
                onChange={(event) => set('durationMinutes', event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Downtime (minutes)</span>
              <input
                type="number"
                min={0}
                value={form.downtimeMinutes}
                onChange={(event) => set('downtimeMinutes', event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">Notes</span>
            <textarea
              value={form.notes}
              onChange={(event) => set('notes', event.target.value)}
              rows={2}
            />
          </label>
        </section>

        <div className="form-actions">
          <button type="submit" className="button" disabled={submitting}>
            {submitting ? 'Recording…' : 'Record maintenance'}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => navigate('/maintenance')}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

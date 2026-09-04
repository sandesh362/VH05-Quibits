/**
 * Create a machine.
 *
 * The asset tag is immutable after creation; the model must reference an
 * existing live machine model (the form only offers models the API returns).
 */
import { FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CRITICALITY_LEVELS, MACHINE_STATUSES } from '@itp/shared';
import { apiClient, ApiClientError, type MachineModelRecord } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useToast } from '../lib/toast';
import { titleCase } from '../lib/format';
import {
  Button,
  Card,
  Field,
  PageHeader,
  SelectInput,
  TextArea,
  TextInput,
} from '../components/ui';
import { ErrorState, LoadingState } from '../components/states';
import './page.css';

interface FormValues {
  assetTag: string;
  machineModelId: string;
  displayName: string;
  serialNumber: string;
  status: string;
  criticality: string;
  site: string;
  area: string;
  line: string;
  position: string;
  notes: string;
}

const EMPTY: FormValues = {
  assetTag: '',
  machineModelId: '',
  displayName: '',
  serialNumber: '',
  status: 'operational',
  criticality: '',
  site: '',
  area: '',
  line: '',
  position: '',
  notes: '',
};

export function MachineNewPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: models, error: modelsError, refetch } = useApi<MachineModelRecord[]>(
    () => apiClient.listModels({ limit: 100 }).then((r) => r.data),
    [],
  );

  const [values, setValues] = useState<FormValues>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  const sortedModels = useMemo(
    () =>
      [...(models ?? [])].sort((a, b) =>
        `${a.manufacturer} ${a.modelName}`.localeCompare(`${b.manufacturer} ${b.modelName}`),
      ),
    [models],
  );

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]): void {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!values.assetTag.trim()) next.assetTag = 'Asset tag is required.';
    else if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(values.assetTag.trim()))
      next.assetTag = 'Letters, numbers, dot, dash, underscore and slash only.';
    if (!values.machineModelId) next.machineModelId = 'Select a machine model.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!validate()) return;
    setPending(true);
    try {
      const location: Record<string, string> = {};
      for (const key of ['site', 'area', 'line', 'position'] as const) {
        if (values[key].trim()) location[key] = values[key].trim();
      }
      const body: Record<string, unknown> = {
        assetTag: values.assetTag.trim(),
        machineModelId: values.machineModelId,
      };
      if (values.displayName.trim()) body.displayName = values.displayName.trim();
      if (values.serialNumber.trim()) body.serialNumber = values.serialNumber.trim();
      if (values.status) body.status = values.status;
      if (values.criticality) body.criticality = values.criticality;
      if (Object.keys(location).length) body.location = location;
      if (values.notes.trim()) body.notes = values.notes.trim();

      const { machine } = await apiClient.createMachine(body);
      toast.success(`Machine ${machine.assetTag} registered.`);
      navigate(`/machines/${machine.id}`);
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        if (caught.details?.length) {
          const fieldErrors: Record<string, string> = {};
          for (const detail of caught.details) {
            const key = detail.field.split('.').pop() ?? detail.field;
            fieldErrors[key] = detail.issue;
          }
          setErrors(fieldErrors);
        } else {
          toast.error(caught.message);
        }
      } else {
        toast.error('Could not create the machine.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Register machine"
        description="Register a physical asset. The asset tag is permanent; the machine model must already exist."
        breadcrumbs={[
          { label: 'Machines', to: '/machines' },
          { label: 'New machine' },
        ]}
      />

      {modelsError && <ErrorState error={modelsError} onRetry={refetch} title="Could not load machine models" />}

      {!models && !modelsError && (
        <Card>
          <LoadingState message="Loading machine models…" />
        </Card>
      )}

      {models && (
        <Card>
          <form className="ui-form" onSubmit={onSubmit} noValidate>
            <div className="form-grid">
              <Field label="Asset tag" htmlFor="assetTag" required error={errors.assetTag} hint="Unique identifier, e.g. CNC-01. Letters and numbers only.">
                <TextInput
                  id="assetTag"
                  value={values.assetTag}
                  onChange={(e) => set('assetTag', e.target.value)}
                  autoFocus
                />
              </Field>
              <Field
                label="Display name"
                htmlFor="displayName"
                error={errors.displayName}
                hint="Optional human-friendly name."
              >
                <TextInput
                  id="displayName"
                  value={values.displayName}
                  onChange={(e) => set('displayName', e.target.value)}
                />
              </Field>
              <Field label="Machine model" htmlFor="machineModelId" required error={errors.machineModelId}>
                <SelectInput
                  id="machineModelId"
                  value={values.machineModelId}
                  onChange={(e) => set('machineModelId', e.target.value)}
                >
                  <option value="">Select a model…</option>
                  {sortedModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.manufacturer} {model.modelName} ({model.machineType})
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Serial number" htmlFor="serialNumber" error={errors.serialNumber}>
                <TextInput
                  id="serialNumber"
                  value={values.serialNumber}
                  onChange={(e) => set('serialNumber', e.target.value)}
                />
              </Field>
              <Field label="Status" htmlFor="status">
                <SelectInput id="status" value={values.status} onChange={(e) => set('status', e.target.value)}>
                  {MACHINE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {titleCase(status)}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Criticality" htmlFor="criticality" error={errors.criticality}>
                <SelectInput
                  id="criticality"
                  value={values.criticality}
                  onChange={(e) => set('criticality', e.target.value)}
                >
                  <option value="">Not specified</option>
                  {CRITICALITY_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {titleCase(level)}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Site" htmlFor="site">
                <TextInput id="site" value={values.site} onChange={(e) => set('site', e.target.value)} />
              </Field>
              <Field label="Area" htmlFor="area">
                <TextInput id="area" value={values.area} onChange={(e) => set('area', e.target.value)} />
              </Field>
              <Field label="Line" htmlFor="line">
                <TextInput id="line" value={values.line} onChange={(e) => set('line', e.target.value)} />
              </Field>
              <Field label="Position" htmlFor="position">
                <TextInput
                  id="position"
                  value={values.position}
                  onChange={(e) => set('position', e.target.value)}
                />
              </Field>
              <Field label="Notes" htmlFor="notes" className="field--full">
                <TextArea
                  id="notes"
                  rows={3}
                  value={values.notes}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </Field>
            </div>

            <div className="form-actions">
              <Link to="/machines" className="btn btn--ghost">
                Cancel
              </Link>
              <Button type="submit" variant="primary" loading={pending}>
                Register machine
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

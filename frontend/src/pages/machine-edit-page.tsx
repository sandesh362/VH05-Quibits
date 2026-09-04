/**
 * Edit machine metadata.
 *
 * Asset tag is immutable and not presented as editable. Changing the machine
 * model requires a mandatory model-change reason (enforced by the backend).
 */
import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CRITICALITY_LEVELS, MACHINE_STATUSES } from '@itp/shared';
import { apiClient, ApiClientError, type MachineModelRecord, type MachineRecord } from '../lib/api-client';
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

export function MachineEditPage(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const machineState = useApi<MachineRecord>(
    () => apiClient.getMachine(id).then((r) => r.machine),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );
  const modelsState = useApi<MachineModelRecord[]>(
    () => apiClient.listModels({ limit: 100 }).then((r) => r.data),
    [],
  );

  const [form, setForm] = useState({
    displayName: '',
    serialNumber: '',
    machineModelId: '',
    status: '',
    criticality: '',
    site: '',
    area: '',
    line: '',
    position: '',
    notes: '',
    modelChangeReason: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (machineState.data) {
      const m = machineState.data;
      setForm({
        displayName: m.displayName ?? '',
        serialNumber: m.serialNumber ?? '',
        machineModelId: m.machineModelId,
        status: m.status,
        criticality: m.criticality ?? '',
        site: (m.location?.site as string) ?? '',
        area: (m.location?.area as string) ?? '',
        line: (m.location?.line as string) ?? '',
        position: (m.location?.position as string) ?? '',
        notes: m.notes ?? '',
        modelChangeReason: '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineState.data]);

  function set<K extends keyof typeof form>(key: K, value: string): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const machine = machineState.data;
    if (!machine) return;
    const nextErrors: Record<string, string> = {};

    const body: Record<string, unknown> = {};
    if (form.displayName.trim() !== (machine.displayName ?? ''))
      body.displayName = form.displayName.trim() || null;
    if (form.serialNumber.trim() !== (machine.serialNumber ?? ''))
      body.serialNumber = form.serialNumber.trim() || null;
    if (form.status !== machine.status) body.status = form.status;
    if ((form.criticality || '') !== (machine.criticality ?? ''))
      body.criticality = form.criticality || null;
    if (form.notes.trim() !== (machine.notes ?? '')) body.notes = form.notes.trim();

    const location: Record<string, string> = {};
    for (const key of ['site', 'area', 'line', 'position'] as const) {
      if (form[key].trim()) location[key] = form[key].trim();
    }
    body.location = location;

    if (form.machineModelId !== machine.machineModelId) {
      if (!form.machineModelId) nextErrors.machineModelId = 'Select a machine model.';
      if (form.modelChangeReason.trim().length < 3)
        nextErrors.modelChangeReason = 'A reason (min 3 characters) is required to change the model.';
      body.machineModelId = form.machineModelId;
      body.modelChangeReason = form.modelChangeReason.trim();
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setPending(true);
    try {
      const { machine: updated } = await apiClient.updateMachine(id, body);
      toast.success('Machine updated.');
      navigate(`/machines/${updated.id}`);
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.details?.length) {
        const fieldErrors: Record<string, string> = {};
        for (const detail of caught.details) {
          fieldErrors[detail.field.split('.').pop() ?? detail.field] = detail.issue;
        }
        setErrors(fieldErrors);
      } else if (caught instanceof ApiClientError) {
        toast.error(caught.message);
      } else {
        toast.error('Could not update the machine.');
      }
    } finally {
      setPending(false);
    }
  }

  if (machineState.isInitialLoading || !machineState.data) {
    return (
      <div className="page">
        <Card>
          <LoadingState message="Loading machine…" />
        </Card>
      </div>
    );
  }

  if (machineState.error) {
    return (
      <div className="page">
        <Card>
          <ErrorState error={machineState.error} onRetry={machineState.refetch} title="Could not load machine" />
        </Card>
      </div>
    );
  }

  const machine = machineState.data;
  const modelChanged = form.machineModelId && form.machineModelId !== machine.machineModelId;

  return (
    <div className="page">
      <PageHeader
        title={`Edit ${machine.assetTag}`}
        description="Update machine metadata. The asset tag is permanent and cannot be changed."
        breadcrumbs={[
          { label: 'Machines', to: '/machines' },
          { label: machine.assetTag, to: `/machines/${machine.id}` },
          { label: 'Edit' },
        ]}
      />

      <Card>
        <form className="ui-form" onSubmit={onSubmit} noValidate>
          <div className="form-grid">
            <Field label="Asset tag" htmlFor="assetTag">
              <TextInput id="assetTag" value={machine.assetTag} disabled />
            </Field>
            <Field label="Display name" htmlFor="displayName" error={errors.displayName}>
              <TextInput
                id="displayName"
                value={form.displayName}
                onChange={(e) => set('displayName', e.target.value)}
              />
            </Field>
            <Field label="Machine model" htmlFor="machineModelId" required error={errors.machineModelId}>
              <SelectInput
                id="machineModelId"
                value={form.machineModelId}
                onChange={(e) => set('machineModelId', e.target.value)}
              >
                {(modelsState.data ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.manufacturer} {model.modelName} ({model.machineType})
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Serial number" htmlFor="serialNumber" error={errors.serialNumber}>
              <TextInput
                id="serialNumber"
                value={form.serialNumber}
                onChange={(e) => set('serialNumber', e.target.value)}
              />
            </Field>
            <Field label="Status" htmlFor="status">
              <SelectInput id="status" value={form.status} onChange={(e) => set('status', e.target.value)}>
                {MACHINE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {titleCase(status)}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Criticality" htmlFor="criticality">
              <SelectInput
                id="criticality"
                value={form.criticality}
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
            <Field label="Site" htmlFor="site"><TextInput id="site" value={form.site} onChange={(e) => set('site', e.target.value)} /></Field>
            <Field label="Area" htmlFor="area"><TextInput id="area" value={form.area} onChange={(e) => set('area', e.target.value)} /></Field>
            <Field label="Line" htmlFor="line"><TextInput id="line" value={form.line} onChange={(e) => set('line', e.target.value)} /></Field>
            <Field label="Position" htmlFor="position"><TextInput id="position" value={form.position} onChange={(e) => set('position', e.target.value)} /></Field>
            {modelChanged && (
              <Field
                label="Reason for model change"
                htmlFor="modelChangeReason"
                required
                className="field--full"
                error={errors.modelChangeReason}
                hint="Changing a machine's model is audited. Explain why."
              >
                <TextInput
                  id="modelChangeReason"
                  value={form.modelChangeReason}
                  onChange={(e) => set('modelChangeReason', e.target.value)}
                />
              </Field>
            )}
            <Field label="Notes" htmlFor="notes" className="field--full">
              <TextArea id="notes" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>

          <div className="form-actions">
            <Link to={`/machines/${machine.id}`} className="btn btn--ghost">
              Cancel
            </Link>
            <Button type="submit" variant="primary" loading={pending}>
              Save changes
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

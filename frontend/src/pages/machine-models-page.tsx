/**
 * Machine model management.
 *
 * List with linked machine/manual counts, plus create/edit in a modal dialog.
 * Deletion requires a confirmation reason (audited on the backend). Technicians
 * and viewers can read; only managers/admins can create/edit/delete, matching
 * the backend capabilities.
 */
import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MACHINE_TYPES } from '@itp/shared';
import { apiClient, ApiClientError, type MachineModelRecord } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { titleCase } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Drawer,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  SelectInput,
  SkeletonTable,
  TextArea,
  TextInput,
  ToneBadge,
} from '../components/ui';
import { ErrorState } from '../components/states';
import './page.css';

const MACHINE_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  MACHINE_TYPES.map((type) => [type, titleCase(type.replace(/_/g, ' '))]),
);

interface ModelFormValues {
  manufacturer: string;
  modelName: string;
  machineType: string;
  modelYear: string;
  aliases: string;
  defaultLanguage: string;
  notes: string;
}

const EMPTY_FORM: ModelFormValues = {
  manufacturer: '',
  modelName: '',
  machineType: '',
  modelYear: '',
  aliases: '',
  defaultLanguage: '',
  notes: '',
};

export function MachineModelsPage(): JSX.Element {
  const { can } = useAuth();
  const toast = useToast();
  const [searchInput, setSearchInput] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const search = useDebouncedValue(searchInput, 300);

  const { data, error, isLoading, refetch } = useApi<MachineModelRecord[]>(
    () =>
      apiClient
        .listModels({
          search: search || undefined,
          machineType: typeFilter || undefined,
          limit: 100,
        })
        .then((r) => r.data),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, typeFilter],
  );

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MachineModelRecord | null>(null);
  const [values, setValues] = useState<ModelFormValues>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [detailModel, setDetailModel] = useState<MachineModelRecord | null>(null);
  const [deleting, setDeleting] = useState<MachineModelRecord | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  const models = useMemo(() => data ?? [], [data]);

  function openCreate(): void {
    setEditing(null);
    setValues(EMPTY_FORM);
    setFormErrors({});
    setFormOpen(true);
  }

  function openEdit(model: MachineModelRecord): void {
    setEditing(model);
    setValues({
      manufacturer: model.manufacturer,
      modelName: model.modelName,
      machineType: model.machineType,
      modelYear: model.modelYear ? String(model.modelYear) : '',
      aliases: model.aliases.join(', '),
      defaultLanguage: model.defaultLanguage ?? '',
      notes: model.notes ?? '',
    });
    setFormErrors({});
    setFormOpen(true);
  }

  function set<K extends keyof ModelFormValues>(key: K, value: string): void {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const errors: Record<string, string> = {};
    if (!values.manufacturer.trim()) errors.manufacturer = 'Manufacturer is required.';
    if (!values.modelName.trim()) errors.modelName = 'Model name is required.';
    if (!values.machineType) errors.machineType = 'Select a machine type.';
    if (values.modelYear && (Number.isNaN(Number(values.modelYear)) || Number(values.modelYear) < 1900))
      errors.modelYear = 'Enter a valid year (1900+).';
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const body: Record<string, unknown> = {
      manufacturer: values.manufacturer.trim(),
      modelName: values.modelName.trim(),
      machineType: values.machineType,
    };
    if (values.modelYear) body.modelYear = Number(values.modelYear);
    if (values.aliases.trim())
      body.aliases = values.aliases.split(',').map((a) => a.trim()).filter(Boolean);
    if (values.defaultLanguage.trim()) body.defaultLanguage = values.defaultLanguage.trim();
    if (values.notes.trim()) body.notes = values.notes.trim();

    setSaving(true);
    try {
      if (editing) {
        await apiClient.updateModel(editing.id, body);
        toast.success(`Model ${editing.modelName} updated.`);
      } else {
        await apiClient.createModel(body);
        toast.success('Machine model created.');
      }
      setFormOpen(false);
      refetch();
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.details?.length) {
        const fieldErrors: Record<string, string> = {};
        for (const detail of caught.details) {
          fieldErrors[detail.field.split('.').pop() ?? detail.field] = detail.issue;
        }
        setFormErrors(fieldErrors);
      } else if (caught instanceof ApiClientError) {
        toast.error(caught.message);
      } else {
        toast.error('Could not save the model.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function onDeleteConfirm(reason: string): Promise<void> {
    if (!deleting) return;
    setDeletePending(true);
    try {
      await apiClient.deleteModel(deleting.id, reason);
      toast.success(`Model ${deleting.modelName} deleted.`);
      setDeleting(null);
      setDetailModel(null);
      refetch();
    } catch (caught) {
      toast.error(caught instanceof ApiClientError ? caught.message : 'Could not delete the model.');
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Machine models"
        description="The catalogue of manufacturer/model types. Manuals and machines reference these models."
        breadcrumbs={[{ label: 'Machine Models' }]}
        actions={
          can('machine_model.create') ? (
            <Button variant="primary" onClick={openCreate}>
              New machine model
            </Button>
          ) : null
        }
      />

      <Card>
        <form className="filter-bar" role="search" onSubmit={(e) => e.preventDefault()}>
          <div className="field field--search">
            <label className="field__label" htmlFor="model-search">Search</label>
            <TextInput
              id="model-search"
              type="search"
              placeholder="Manufacturer or model name…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="model-type-filter">Type</label>
            <SelectInput id="model-type-filter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {MACHINE_TYPES.map((type) => (
                <option key={type} value={type}>{MACHINE_TYPE_LABELS[type]}</option>
              ))}
            </SelectInput>
          </div>
        </form>

        {isLoading && <SkeletonTable rows={6} cols={5} />}
        {!isLoading && error && <ErrorState error={error} onRetry={refetch} title="Could not load machine models" />}
        {!isLoading && !error && models.length === 0 && (
          <EmptyState
            title="No machine models"
            message="Create the manufacturer model catalogue before registering machines or uploading manuals."
            action={
              can('machine_model.create') ? (
                <Button variant="primary" onClick={openCreate}>New machine model</Button>
              ) : undefined
            }
          />
        )}

        {!isLoading && !error && models.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Manufacturer</th>
                  <th>Model</th>
                  <th>Type</th>
                  <th className="num">Machines</th>
                  <th className="num">Manuals</th>
                  <th>Aliases</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td>{model.manufacturer}</td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setDetailModel(model)}
                      >
                        {model.modelName}
                      </button>
                    </td>
                    <td>
                      <ToneBadge tone="neutral" icon="▤" label={MACHINE_TYPE_LABELS[model.machineType] ?? model.machineType} size="sm" />
                    </td>
                    <td className="num">
                      <Link to={`/machines`}>{model.machineCount}</Link>
                    </td>
                    <td className="num">
                      <Link to={`/manuals`}>{model.manualCount}</Link>
                    </td>
                    <td>
                      {model.aliases.length > 0 ? (
                        <span className="tag-list">
                          {model.aliases.slice(0, 3).map((alias) => (
                            <span key={alias} className="tag">{alias}</span>
                          ))}
                          {model.aliases.length > 3 && <span className="tag">+{model.aliases.length - 3}</span>}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create / edit modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Edit ${editing.manufacturer} ${editing.modelName}` : 'New machine model'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>Cancel</Button>
            <Button variant="primary" type="submit" form="model-form" loading={saving}>
              {editing ? 'Save changes' : 'Create model'}
            </Button>
          </>
        }
      >
        <form id="model-form" className="ui-form" onSubmit={onSubmit} noValidate>
          <div className="form-grid">
            <Field label="Manufacturer" htmlFor="manufacturer" required error={formErrors.manufacturer}>
              <TextInput id="manufacturer" value={values.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} autoFocus />
            </Field>
            <Field label="Model name" htmlFor="modelName" required error={formErrors.modelName}>
              <TextInput id="modelName" value={values.modelName} onChange={(e) => set('modelName', e.target.value)} />
            </Field>
            <Field label="Machine type" htmlFor="machineType" required error={formErrors.machineType}>
              <SelectInput id="machineType" value={values.machineType} onChange={(e) => set('machineType', e.target.value)}>
                <option value="">Select type…</option>
                {MACHINE_TYPES.map((type) => (
                  <option key={type} value={type}>{MACHINE_TYPE_LABELS[type]}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Model year" htmlFor="modelYear" error={formErrors.modelYear}>
              <TextInput id="modelYear" inputMode="numeric" value={values.modelYear} onChange={(e) => set('modelYear', e.target.value)} placeholder="e.g. 2021" />
            </Field>
            <Field label="Aliases" htmlFor="aliases" className="field--full" hint="Comma-separated alternate names used when technicians refer to this model.">
              <TextInput id="aliases" value={values.aliases} onChange={(e) => set('aliases', e.target.value)} placeholder="e.g. Milltronics ML-18, ML18" />
            </Field>
            <Field label="Default manual language" htmlFor="defaultLanguage" hint="BCP-47 tag, e.g. en">
              <TextInput id="defaultLanguage" value={values.defaultLanguage} onChange={(e) => set('defaultLanguage', e.target.value)} />
            </Field>
            <Field label="Notes" htmlFor="notes" className="field--full">
              <TextArea id="notes" rows={2} value={values.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
        </form>
      </Modal>

      {/* Detail drawer */}
      <Drawer
        open={detailModel !== null}
        onClose={() => setDetailModel(null)}
        title={detailModel ? `${detailModel.manufacturer} ${detailModel.modelName}` : ''}
        footer={
          detailModel && can('machine_model.update') ? (
            <>
              {can('machine_model.delete') && (
                <Button variant="danger" onClick={() => setDeleting(detailModel)}>
                  Delete model
                </Button>
              )}
              <Button variant="primary" onClick={() => { openEdit(detailModel); setDetailModel(null); }}>
                Edit
              </Button>
            </>
          ) : null
        }
      >
        {detailModel && (
          <div className="ui-form">
            <p>
              <Badge presentation={{ tone: 'neutral', icon: '▤', label: MACHINE_TYPE_LABELS[detailModel.machineType] ?? detailModel.machineType }} />
            </p>
            <dl className="desc-list">
              <div className="desc-list__row"><dt>Machines linked</dt><dd>{detailModel.machineCount}</dd></div>
              <div className="desc-list__row"><dt>Manuals linked</dt><dd>{detailModel.manualCount}</dd></div>
              <div className="desc-list__row"><dt>Model year</dt><dd>{detailModel.modelYear ?? '—'}</dd></div>
              <div className="desc-list__row"><dt>Default language</dt><dd>{detailModel.defaultLanguage || '—'}</dd></div>
            </dl>
            {detailModel.aliases.length > 0 && (
              <>
                <h3 className="subsection">Aliases</h3>
                <span className="tag-list">
                  {detailModel.aliases.map((alias) => <span key={alias} className="tag">{alias}</span>)}
                </span>
              </>
            )}
            {detailModel.notes && (
              <>
                <h3 className="subsection">Notes</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{detailModel.notes}</p>
              </>
            )}
            <div className="form-actions" style={{ marginTop: 'var(--space-md)' }}>
              <Link to={`/manuals?modelId=${detailModel.id}`} className="btn btn--secondary btn--sm">
                View manuals
              </Link>
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={onDeleteConfirm}
        title={`Delete ${deleting?.manufacturer ?? ''} ${deleting?.modelName ?? ''}?`}
        confirmLabel="Delete model"
        requireNote
        noteLabel="Reason for deletion"
        loading={deletePending}
        irreversible
      >
        <p>
          Deleting a model is audited and may be prevented while machines or manuals still
          reference it. This does not delete those machines or manuals.
        </p>
      </ConfirmDialog>
    </div>
  );
}

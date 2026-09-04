/**
 * Maintenance record detail.
 *
 * Full record: machine, type, work performed, parts, measurements,
 * technician, dates, linked incident. Editing follows the backend rule:
 * the author may edit within 24 hours; managers/admins any time. We show the
 * edit control to everyone who holds a maintenance.update* capability and
 * surface a 403 message honestly if the window has passed.
 */
import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MAINTENANCE_TYPES } from '@itp/shared';
import {
  apiClient,
  ApiClientError,
  type MachineRecord,
  type MaintenanceRecord,
  type UserRecord,
} from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { formatDate, formatDateShort, titleCase, toDateInput } from '../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  DescriptionList,
  Modal,
  PageHeader,
  SelectInput,
  TextArea,
  TextInput,
  Field,
} from '../components/ui';
import { ErrorState, LoadingState } from '../components/states';
import { maintenanceType } from '../lib/labels';
import './page.css';

export function MaintenanceDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, error, isInitialLoading, refetch } = useApi<{
    record: MaintenanceRecord;
    machine?: MachineRecord;
    technicians: UserRecord[];
  }>(
    async () => {
      const { maintenanceRecord } = await apiClient.getMaintenance(id);
      const [machines, users] = await Promise.all([
        apiClient.listMachines({ limit: 100 }).then((r) => r.data).catch(() => []),
        can('user.read_all')
          ? apiClient.listUsers().then((r) => r.users).catch(() => [])
          : Promise.resolve([] as UserRecord[]),
      ]);
      return {
        record: maintenanceRecord,
        machine: machines.find((m) => m.id === maintenanceRecord.machineId),
        technicians: users,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  const canEdit = can('maintenance.update_any') || can('maintenance.update_own');

  const [form, setForm] = useState({ title: '', maintenanceType: '', performedAt: '', notes: '', workOrderRef: '', durationMinutes: '' });

  function openEdit(): void {
    if (!data) return;
    setForm({
      title: data.record.title,
      maintenanceType: data.record.maintenanceType,
      performedAt: toDateInput(data.record.performedAt),
      notes: data.record.notes ?? '',
      workOrderRef: data.record.workOrderRef ?? '',
      durationMinutes: data.record.durationMinutes?.toString() ?? '',
    });
    setEditOpen(true);
  }

  function set<K extends keyof typeof form>(key: K, value: string): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (form.title.trim() && form.title !== data?.record.title) body.title = form.title.trim();
      if (form.maintenanceType && form.maintenanceType !== data?.record.maintenanceType)
        body.maintenanceType = form.maintenanceType;
      if (form.notes !== (data?.record.notes ?? '')) body.notes = form.notes.trim() || null;
      if (form.workOrderRef !== (data?.record.workOrderRef ?? ''))
        body.workOrderRef = form.workOrderRef.trim() || null;
      if (form.durationMinutes) {
        const duration = Number(form.durationMinutes);
        if (Number.isFinite(duration) && duration >= 0) body.durationMinutes = duration;
      }
      if (form.performedAt) body.performedAt = new Date(form.performedAt).toISOString();

      if (Object.keys(body).length === 0) {
        setEditOpen(false);
        return;
      }
      await apiClient.updateMaintenance(id, body);
      toast.success('Maintenance record updated.');
      setEditOpen(false);
      refetch();
    } catch (caught) {
      toast.error(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not update the maintenance record.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (isInitialLoading) {
    return <div className="page"><Card><LoadingState message="Loading maintenance record…" /></Card></div>;
  }
  if (error || !data) {
    return (
      <div className="page">
        <Card><ErrorState error={error ?? new Error('Not found')} onRetry={refetch} title="Could not load this maintenance record" /></Card>
      </div>
    );
  }

  const { record, machine } = data;
  const technician =
    record.performedByName ??
    record.performedByExternal ??
    data.technicians.find((u) => u.id === record.performedBy)?.fullName ??
    (record.performedBy ? `…${record.performedBy.slice(-6)}` : '—');

  return (
    <div className="page">
      <PageHeader
        breadcrumbs={[
          { label: 'Maintenance', to: '/maintenance' },
          { label: record.title },
        ]}
        title={record.title}
        description={`Performed ${formatDate(record.performedAt)}`}
        actions={
          canEdit ? (
            <Button variant="secondary" onClick={openEdit}>
              Edit record
            </Button>
          ) : null
        }
      />

      <Card>
        <div className="entity-header">
          <div className="entity-header__badges">
            <Badge presentation={maintenanceType(record.maintenanceType)} />
            {record.workOrderRef && <Badge presentation={{ tone: 'neutral', icon: '▤', label: `WO ${record.workOrderRef}` }} />}
          </div>
        </div>

        <div className="section-head"><h2>Details</h2></div>
        <DescriptionList
          items={[
            { label: 'Machine', value: machine ? <Link to={`/machines/${machine.id}`}>{machine.displayName ?? machine.assetTag}</Link> : `…${record.machineId.slice(-6)}` },
            { label: 'Maintenance type', value: titleCase(record.maintenanceType.replace(/_/g, ' ')) },
            { label: 'Performed by', value: technician },
            { label: 'Performed at', value: formatDate(record.performedAt) },
            { label: 'Duration (min)', value: record.durationMinutes ?? '—' },
            { label: 'Downtime (min)', value: record.downtimeMinutes ?? '—' },
            { label: 'Work order', value: record.workOrderRef ?? '—' },
            { label: 'Next due', value: record.nextDueAt ? formatDateShort(record.nextDueAt) : '—' },
            { label: 'Linked incident', value: record.relatedIncidentId ? <Link to={`/incidents/${record.relatedIncidentId}`}>Open incident</Link> : '—' },
          ]}
        />

        {record.description && (
          <>
            <h3 className="subsection">Description</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{record.description}</p>
          </>
        )}
        {record.notes && (
          <>
            <h3 className="subsection">Notes</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{record.notes}</p>
          </>
        )}
      </Card>

      <Card>
        <div className="section-head"><h2>Parts replaced</h2></div>
        {record.partsReplaced.length === 0 ? (
          <p className="muted">No parts recorded.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Part number</th>
                  <th>Name</th>
                  <th className="num">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {record.partsReplaced.map((part) => (
                  <tr key={part.partNumber}>
                    <td className="mono">{part.partNumber}</td>
                    <td>{part.name ?? '—'}</td>
                    <td className="num">{part.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="section-head"><h2>Components serviced</h2></div>
        {record.componentsServiced.length === 0 ? (
          <p className="muted">No components listed.</p>
        ) : (
          <span className="tag-list">
            {record.componentsServiced.map((component) => (
              <span key={component} className="tag">{component}</span>
            ))}
          </span>
        )}

        {record.measurements.length > 0 && (
          <>
            <div className="section-head"><h2>Measurements</h2></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Measurement</th>
                    <th className="num">Value</th>
                    <th>Unit</th>
                    <th>In spec</th>
                  </tr>
                </thead>
                <tbody>
                  {record.measurements.map((measurement, index) => (
                    <tr key={`${measurement.name}-${index}`}>
                      <td>{measurement.name}</td>
                      <td className="num">{measurement.value}</td>
                      <td>{measurement.unit ?? '—'}</td>
                      <td>
                        {measurement.inSpec === null ? (
                          '—'
                        ) : measurement.inSpec ? (
                          <Badge presentation={{ tone: 'ok', icon: '✓', label: 'In spec' }} size="sm" />
                        ) : (
                          <Badge presentation={{ tone: 'error', icon: '✕', label: 'Out of spec' }} size="sm" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <div className="form-actions">
        <Link to="/maintenance" className="btn btn--ghost">← Back to maintenance</Link>
        <Button variant="ghost" onClick={() => refetch()}>Refresh</Button>
      </div>

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit maintenance record"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={saving}>Cancel</Button>
            <Button variant="primary" type="submit" form="maintenance-edit-form" loading={saving}>Save changes</Button>
          </>
        }
      >
        <form id="maintenance-edit-form" className="ui-form" onSubmit={save} noValidate>
          <Alert tone="info">
            Records can be edited by their author for 24 hours; managers can edit at any time.
          </Alert>
          <div className="form-grid">
            <Field label="Title" htmlFor="edit-title" required className="field--full">
              <TextInput id="edit-title" value={form.title} onChange={(e) => set('title', e.target.value)} />
            </Field>
            <Field label="Type" htmlFor="edit-type">
              <SelectInput id="edit-type" value={form.maintenanceType} onChange={(e) => set('maintenanceType', e.target.value)}>
                {MAINTENANCE_TYPES.map((type) => (
                  <option key={type} value={type}>{titleCase(type.replace(/_/g, ' '))}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Performed at" htmlFor="edit-date">
              <TextInput id="edit-date" type="date" value={form.performedAt} onChange={(e) => set('performedAt', e.target.value)} />
            </Field>
            <Field label="Work order reference" htmlFor="edit-wo">
              <TextInput id="edit-wo" value={form.workOrderRef} onChange={(e) => set('workOrderRef', e.target.value)} />
            </Field>
            <Field label="Duration (minutes)" htmlFor="edit-duration">
              <TextInput id="edit-duration" type="number" min="0" value={form.durationMinutes} onChange={(e) => set('durationMinutes', e.target.value)} />
            </Field>
            <Field label="Notes" htmlFor="edit-notes" className="field--full">
              <TextArea id="edit-notes" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
        </form>
      </Modal>
    </div>
  );
}

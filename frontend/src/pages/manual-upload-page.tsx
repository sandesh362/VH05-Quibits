/**
 * Manual upload.
 *
 * Multipart upload with client-side file validation (type + size), upload
 * progress, and duplicate/server-error display. The server re-validates and
 * computes size/checksum itself; client checks only prevent obvious mistakes.
 *
 * Maximum accepted size mirrors the backend's PDF limit (50 MB) so the UI
 * rejects files the API would refuse.
 */
import { ChangeEvent, DragEvent, FormEvent, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DOCUMENT_TYPES, MANUAL_SCOPES } from '@itp/shared';
import { apiClient, ApiClientError, type MachineModelRecord, type MachineRecord } from '../lib/api-client';
import { useApi } from '../lib/use-api';
import { useToast } from '../lib/toast';
import { titleCase, formatBytes } from '../lib/format';
import {
  Alert,
  Button,
  Card,
  Field,
  PageHeader,
  ProgressBar,
  SelectInput,
  TextArea,
  TextInput,
} from '../components/ui';
import { ErrorState, LoadingState } from '../components/states';
import './page.css';

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const ACCEPTED_TYPES = ['application/pdf'];

interface FormValues {
  title: string;
  scope: string;
  machineId: string;
  machineModelId: string;
  documentType: string;
  documentVersion: string;
  documentNumber: string;
  language: string;
  description: string;
}

const EMPTY: FormValues = {
  title: '',
  scope: 'model',
  machineId: '',
  machineModelId: '',
  documentType: 'service',
  documentVersion: '',
  documentNumber: '',
  language: 'en',
  description: '',
};

export function ManualUploadPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const presetModelId = useMemo(
    () => new URLSearchParams(window.location.search).get('modelId') ?? '',
    [],
  );

  const { data: models, error: modelsError, refetch } = useApi<MachineModelRecord[]>(
    () => apiClient.listModels({ limit: 100 }).then((r) => r.data),
    [],
  );
  const { data: machines, error: machinesError, refetch: refetchMachines } = useApi<MachineRecord[]>(
    () => apiClient.listMachines({ limit: 100 }).then((r) => r.data),
    [],
  );

  const [values, setValues] = useState<FormValues>({ ...EMPTY, machineModelId: presetModelId });
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  function set<K extends keyof FormValues>(key: K, value: string): void {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function validateFile(selected: File): string | null {
    if (!ACCEPTED_TYPES.includes(selected.type) && !selected.name.toLowerCase().endsWith('.pdf')) {
      return 'Only PDF files are supported.';
    }
    if (selected.size > MAX_PDF_BYTES) {
      return `File is ${formatBytes(selected.size)}; the maximum is ${formatBytes(MAX_PDF_BYTES)}.`;
    }
    if (selected.size === 0) {
      return 'The selected file is empty.';
    }
    return null;
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    setFileError(null);
    if (selected) {
      const error = validateFile(selected);
      if (error) {
        setFile(null);
        setFileError(error);
        event.target.value = '';
        return;
      }
      setFile(selected);
      // Pre-fill title from the filename if the user has not typed one.
      setValues((v) =>
        v.title ? v : { ...v, title: selected.name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ') },
      );
    } else {
      setFile(null);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragActive(false);
    const dropped = event.dataTransfer.files?.[0] ?? null;
    if (dropped) {
      const error = validateFile(dropped);
      if (error) {
        setFileError(error);
        return;
      }
      setFile(dropped);
      setValues((v) => (v.title ? v : { ...v, title: dropped.name.replace(/\.pdf$/i, '') }));
    }
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!values.title.trim() || values.title.trim().length < 3)
      next.title = 'A title of at least 3 characters is required.';
    if (values.scope === 'model' && !values.machineModelId)
      next.machineModelId = 'Select the machine model this manual applies to.';
    if (values.scope === 'machine' && !values.machineId)
      next.machineId = 'Select the machine this manual applies to.';
    if (!values.documentVersion.trim()) next.documentVersion = 'Document version is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!file) {
      setFileError('Choose a PDF file to upload.');
      return;
    }
    if (!validate()) return;

    setUploading(true);
    setProgress(0);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('title', values.title.trim());
      form.append('scope', values.scope);
      form.append('documentType', values.documentType);
      form.append('documentVersion', values.documentVersion.trim());
      if (values.scope === 'model' && values.machineModelId)
        form.append('machineModelId', values.machineModelId);
      if (values.scope === 'machine' && values.machineId)
        form.append('machineId', values.machineId);
      if (values.documentNumber.trim()) form.append('documentNumber', values.documentNumber.trim());
      if (values.language.trim()) form.append('language', values.language.trim());
      if (values.description.trim()) form.append('description', values.description.trim());

      const result = await apiClient.uploadManual(form, setProgress);
      toast.success('Upload complete. Processing has started.');
      navigate(`/manuals/${result.data.manual.id}`);
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        if (caught.code === 'CONFLICT') {
          setFileError('A document with identical content already exists (duplicate upload rejected).');
        } else if (caught.code === 'PAYLOAD_TOO_LARGE') {
          setFileError(caught.message);
        } else if (caught.details?.length) {
          const fieldErrors: Record<string, string> = {};
          for (const detail of caught.details) {
            fieldErrors[detail.field.split('.').pop() ?? detail.field] = detail.issue;
          }
          setErrors(fieldErrors);
          toast.error('Please correct the highlighted fields.');
        } else {
          toast.error(caught.message);
        }
      } else {
        toast.error('Upload failed. Please try again.');
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Upload manual"
        description="Upload an OEM PDF manual. It is validated, stored, then processed (extraction, OCR if needed, chunking, embeddings and indexing)."
        breadcrumbs={[{ label: 'Manuals', to: '/manuals' }, { label: 'Upload' }]}
      />

      {modelsError && <Card><ErrorState error={modelsError} onRetry={refetch} title="Could not load machine models" /></Card>}
      {machinesError && <Card><ErrorState error={machinesError} onRetry={refetchMachines} title="Could not load machines" /></Card>}
      {!models && !modelsError && (
        <Card><LoadingState message="Loading machine models…" /></Card>
      )}

      {models && machines && (
        <Card>
          <form className="ui-form" onSubmit={onSubmit} noValidate>
            <div
              className={`upload-dropzone ${dragActive ? 'upload-dropzone--active' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
              aria-label="Choose or drop a PDF file"
            >
              <div className="upload-dropzone__inner">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={onFileChange}
                  disabled={uploading}
                  aria-label="PDF file to upload"
                  data-testid="manual-file-input"
                />
                <p style={{ fontSize: '1.05rem', fontWeight: 600 }}>
                  {file ? `📄 ${file.name}` : 'Drag a PDF here, or click to choose'}
                </p>
                <p className="muted" style={{ marginTop: 6 }}>
                  PDF only · maximum {formatBytes(MAX_PDF_BYTES)}
                </p>
              </div>
            </div>
            {fileError && (
              <Alert tone="error">{fileError}</Alert>
            )}

            <div className="form-grid" style={{ marginTop: 'var(--space-lg)' }}>
              <Field label="Title" htmlFor="title" required error={errors.title} className="field--full">
                <TextInput id="title" value={values.title} onChange={(e) => set('title', e.target.value)} disabled={uploading} />
              </Field>
              <Field label="Scope" htmlFor="scope" required>
                <SelectInput id="scope" value={values.scope} onChange={(e) => set('scope', e.target.value)} disabled={uploading}>
                  {MANUAL_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>{titleCase(scope)} manual</option>
                  ))}
                </SelectInput>
              </Field>
              <Field
                label="Machine"
                htmlFor="machineId"
                required={values.scope === 'machine'}
                error={errors.machineId}
                hint={values.scope === 'model' ? 'Not required for a model-wide manual.' : 'This manual applies only to the selected machine.'}
              >
                <SelectInput
                  id="machineId"
                  value={values.machineId}
                  onChange={(e) => set('machineId', e.target.value)}
                  disabled={uploading || values.scope !== 'machine'}
                >
                  <option value="">Select machine…</option>
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>
                      {machine.displayName || machine.assetTag}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field
                label="Machine model"
                htmlFor="machineModelId"
                required={values.scope === 'model'}
                error={errors.machineModelId}
                hint={values.scope === 'machine' ? 'Not required for a single-machine document.' : 'Manuals are tied to a model for retrieval.'}
              >
                <SelectInput
                  id="machineModelId"
                  value={values.machineModelId}
                  onChange={(e) => set('machineModelId', e.target.value)}
                  disabled={uploading || values.scope !== 'model'}
                >
                  <option value="">Select model…</option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.manufacturer} {model.modelName}
                    </option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Document type" htmlFor="documentType" required>
                <SelectInput id="documentType" value={values.documentType} onChange={(e) => set('documentType', e.target.value)} disabled={uploading}>
                  {DOCUMENT_TYPES.map((type) => (
                    <option key={type} value={type}>{titleCase(type.replace(/_/g, ' '))}</option>
                  ))}
                </SelectInput>
              </Field>
              <Field label="Version" htmlFor="documentVersion" required error={errors.documentVersion} hint="e.g. Rev C, 2022-03, 1.4">
                <TextInput id="documentVersion" value={values.documentVersion} onChange={(e) => set('documentVersion', e.target.value)} disabled={uploading} />
              </Field>
              <Field label="Document number" htmlFor="documentNumber" error={errors.documentNumber}>
                <TextInput id="documentNumber" value={values.documentNumber} onChange={(e) => set('documentNumber', e.target.value)} disabled={uploading} />
              </Field>
              <Field label="Language" htmlFor="language">
                <TextInput id="language" value={values.language} onChange={(e) => set('language', e.target.value)} disabled={uploading} />
              </Field>
              <Field label="Description" htmlFor="description" className="field--full">
                <TextArea id="description" rows={2} value={values.description} onChange={(e) => set('description', e.target.value)} disabled={uploading} />
              </Field>
            </div>

            {uploading && <ProgressBar percent={progress} label={`Uploading… ${progress}%`} />}

            <div className="form-actions">
              <Link to="/manuals" className="btn btn--ghost">Cancel</Link>
              <Button type="submit" variant="primary" loading={uploading} disabled={!file}>
                {uploading ? 'Uploading…' : 'Upload & process'}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

/**
 * Manual upload validation tests: non-PDF rejection, size rejection, and the
 * title pre-fill from the file name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ManualUploadPage } from './manual-upload-page';
import { AuthProvider } from '../lib/auth';
import { ToastProvider } from '../lib/toast';
import { apiClient } from '../lib/api-client';

function technician() {
  return {
    id: 'u1', username: 'tech', email: 'tech@example.test', fullName: 'Tech User',
    role: 'technician' as const, isActive: true, mustChangePassword: false,
    lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderUpload(): void {
  const user = technician();
  sessionStorage.setItem('itp.accessToken', 'token');
  sessionStorage.setItem('itp.user', JSON.stringify(user));
  vi.spyOn(apiClient, 'me').mockResolvedValue({ user });
  vi.spyOn(apiClient, 'listModels').mockResolvedValue({
    data: [{ id: 'mdl1', manufacturer: 'Haas', modelName: 'VF-2', machineType: 'cnc_mill' }],
    meta: { requestId: 'r', timestamp: '' },
    status: 200,
  } as never);
  vi.spyOn(apiClient, 'listMachines').mockResolvedValue({
    data: [{ id: 'machine1', assetTag: 'VF2-001', displayName: 'Haas VF-2 #1' }],
    meta: { requestId: 'r', timestamp: '' },
    status: 200,
  } as never);
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <ManualUploadPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('ManualUploadPage validation', () => {
  it('rejects a non-PDF file with an accessible error', async () => {
    renderUpload();
    const input = (await screen.findByTestId('manual-file-input')) as HTMLInputElement;
    const file = new File(['not a pdf'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText(/only pdf files are supported/i)).toBeInTheDocument();
  });

  it('rejects an oversized PDF', async () => {
    renderUpload();
    const input = (await screen.findByTestId('manual-file-input')) as HTMLInputElement;
    const big = new File([new Uint8Array(51 * 1024 * 1024)], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/maximum is/i)).toBeInTheDocument();
  });

  it('pre-fills the title from the PDF filename and requires version + model', async () => {
    renderUpload();
    const input = (await screen.findByTestId('manual-file-input')) as HTMLInputElement;
    const pdf = new File(['%PDF-1.4'], 'Haas VF-2 Service Manual.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [pdf] } });

    await waitFor(() => {
      const title = document.getElementById('title') as HTMLInputElement;
      expect(title.value).toMatch(/Haas VF.2 Service Manual/);
    });
    // Version and model are required before upload; labels are present.
    expect(screen.getByText(/Version/)).toBeInTheDocument();
    expect(document.getElementById('machineModelId')).toBeInTheDocument();
  });

  it('submits machineId for a machine-scoped manual', async () => {
    const uploadManual = vi.spyOn(apiClient, 'uploadManual').mockResolvedValue({
      data: { manual: { id: 'manual1' } },
    } as never);
    renderUpload();

    const input = (await screen.findByTestId('manual-file-input')) as HTMLInputElement;
    const pdf = new File(['%PDF-1.4'], 'machine-guide.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [pdf] } });
    fireEvent.change(document.getElementById('scope') as HTMLSelectElement, { target: { value: 'machine' } });
    fireEvent.change(document.getElementById('machineId') as HTMLSelectElement, { target: { value: 'machine1' } });
    fireEvent.change(document.getElementById('documentVersion') as HTMLInputElement, { target: { value: '1.0' } });

    fireEvent.click(screen.getByRole('button', { name: /upload & process/i }));

    await waitFor(() => expect(uploadManual).toHaveBeenCalledOnce());
    const form = uploadManual.mock.calls[0][0];
    expect(form.get('scope')).toBe('machine');
    expect(form.get('machineId')).toBe('machine1');
    expect(form.get('machineModelId')).toBeNull();
  });
});

/**
 * Dashboard tests: metrics derive from real list endpoints, critical
 * incidents are surfaced, and failure shows an error state with retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from './dashboard-page';
import { AuthProvider } from '../lib/auth';
import { ToastProvider } from '../lib/toast';
import { apiClient, ApiClientError } from '../lib/api-client';

function technician() {
  return {
    id: 'u1', username: 'tech', email: 'tech@example.test', fullName: 'Tech User',
    role: 'technician' as const, isActive: true, mustChangePassword: false,
    lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderDashboard(): void {
  const user = technician();
  sessionStorage.setItem('itp.accessToken', 'token');
  sessionStorage.setItem('itp.user', JSON.stringify(user));
  vi.spyOn(apiClient, 'me').mockResolvedValue({ user });
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <DashboardPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const emptyPage = { data: [], meta: { requestId: 'r', timestamp: '', pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } }, status: 200 };

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('DashboardPage', () => {
  it('renders fleet metrics from the API', async () => {
    vi.spyOn(apiClient, 'listMachines').mockResolvedValue({ ...emptyPage, data: [{ id: 'm1' }] as never });
    vi.spyOn(apiClient, 'listIncidents').mockResolvedValue({
      ...emptyPage,
      data: [
        {
          id: 'i1', incidentNumber: 'INC-0001', title: 'Hydraulic leak', severity: 'critical',
          status: 'open', issueStatus: 'investigating', machineId: 'm1', machineModelId: 'mdl',
        },
      ] as never,
    });
    vi.spyOn(apiClient, 'listMaintenance').mockResolvedValue(emptyPage as never);
    vi.spyOn(apiClient, 'listManuals').mockResolvedValue(emptyPage as never);
    vi.spyOn(apiClient, 'listProcessingJobs').mockResolvedValue(emptyPage as never);
    vi.spyOn(apiClient, 'listConversations').mockResolvedValue(emptyPage as never);

    renderDashboard();

    expect(await screen.findByText('Hydraulic leak')).toBeInTheDocument();
    // Critical tile shows count 1.
    expect(screen.getByText('Critical incidents')).toBeInTheDocument();
    expect(screen.getByText('Document processing')).toBeInTheDocument();
  });

  it('shows error state and retries when metrics cannot load', async () => {
    const list = vi
      .spyOn(apiClient, 'listMachines')
      .mockRejectedValueOnce(new ApiClientError('NETWORK_ERROR', 'Cannot reach the API.'))
      .mockResolvedValueOnce(emptyPage as never);
    vi.spyOn(apiClient, 'listIncidents').mockResolvedValue(emptyPage as never);
    vi.spyOn(apiClient, 'listMaintenance').mockResolvedValue(emptyPage as never);
    vi.spyOn(apiClient, 'listManuals').mockResolvedValue(emptyPage as never);
    vi.spyOn(apiClient, 'listProcessingJobs').mockResolvedValue(emptyPage as never);
    vi.spyOn(apiClient, 'listConversations').mockResolvedValue(emptyPage as never);

    renderDashboard();
    expect(await screen.findByText(/could not load the dashboard/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

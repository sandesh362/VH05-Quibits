/**
 * Machines list page tests: data render, empty state, error retry, and
 * role-aware visibility of the create button.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MachinesPage } from './machines-page';
import { AuthProvider } from '../lib/auth';
import { ToastProvider } from '../lib/toast';
import { apiClient, ApiClientError } from '../lib/api-client';
import type { MachineRecord } from '../lib/api-client';

function makeUser(role: 'technician' | 'manager') {
  return {
    id: role === 'technician' ? 'u1' : 'u2',
    username: role === 'technician' ? 'tech' : 'mgr',
    email: `${role}@example.test`,
    fullName: role === 'technician' ? 'Tech User' : 'Manager User',
    role,
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function renderAs(user: ReturnType<typeof makeUser>): void {
  sessionStorage.setItem('itp.accessToken', 'token');
  sessionStorage.setItem('itp.user', JSON.stringify(user));
  vi.spyOn(apiClient, 'me').mockResolvedValue({ user });
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <MachinesPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const machine: MachineRecord = {
  id: 'm1', assetTag: 'CNC-01', machineModelId: 'mdl1',
  modelSnapshot: { manufacturer: 'Haas', modelName: 'VF-2', machineType: 'cnc_mill' },
  displayName: 'Mill 1', serialNumber: 'SN-1', location: { site: 'Plant A', area: 'Line 2' },
  status: 'operational', installedAt: null, commissionedAt: null, criticality: 'high',
  notes: null, lastMaintenanceAt: null, openIncidentCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('MachinesPage', () => {
  it('renders machines with status badge and open-incident count', async () => {
    vi.spyOn(apiClient, 'listMachines').mockResolvedValue({
      data: [machine],
      meta: { requestId: 'r1', timestamp: '', pagination: { page: 1, limit: 15, total: 1, totalPages: 1 } },
      status: 200,
    });
    vi.spyOn(apiClient, 'listModels').mockResolvedValue({
      data: [], meta: { requestId: 'r2', timestamp: '' }, status: 200,
    });
    renderAs(makeUser('technician'));

    expect(await screen.findByText('CNC-01')).toBeInTheDocument();
    expect(screen.getByText('Mill 1')).toBeInTheDocument();
    // Status badge and the status filter option both say "Operational".
    expect(screen.getAllByText('Operational').length).toBeGreaterThan(0);
    expect(screen.getByText('Plant A · Line 2')).toBeInTheDocument();
    const counts = screen.getAllByText('2');
    expect(counts.some((el) => el.tagName === 'STRONG')).toBe(true);
  });

  it('shows an empty state with a create button only for authorized roles', async () => {
    vi.spyOn(apiClient, 'listMachines').mockResolvedValue({
      data: [],
      meta: { requestId: 'r1', timestamp: '', pagination: { page: 1, limit: 15, total: 0, totalPages: 0 } },
      status: 200,
    });
    vi.spyOn(apiClient, 'listModels').mockResolvedValue({
      data: [], meta: { requestId: 'r2', timestamp: '' }, status: 200,
    });
    renderAs(makeUser('technician'));

    expect(await screen.findByText(/no machines found/i)).toBeInTheDocument();
    // Technicians cannot create machines.
    expect(screen.queryByRole('link', { name: /register machine/i })).not.toBeInTheDocument();
  });

  it('offers register action to managers', async () => {
    vi.spyOn(apiClient, 'listMachines').mockResolvedValue({
      data: [machine],
      meta: { requestId: 'r1', timestamp: '', pagination: { page: 1, limit: 15, total: 1, totalPages: 1 } },
      status: 200,
    });
    vi.spyOn(apiClient, 'listModels').mockResolvedValue({
      data: [], meta: { requestId: 'r2', timestamp: '' }, status: 200,
    });
    renderAs(makeUser('manager'));

    await waitFor(() =>
      expect(screen.getByRole('link', { name: /register machine/i })).toBeInTheDocument(),
    );
  });

  it('renders an error state and retries', async () => {
    const list = vi
      .spyOn(apiClient, 'listMachines')
      .mockRejectedValueOnce(new ApiClientError('NETWORK_ERROR', 'Cannot reach the API.'))
      .mockResolvedValueOnce({
        data: [machine],
        meta: { requestId: 'r1', timestamp: '', pagination: { page: 1, limit: 15, total: 1, totalPages: 1 } },
        status: 200,
      });
    vi.spyOn(apiClient, 'listModels').mockResolvedValue({
      data: [], meta: { requestId: 'r2', timestamp: '' }, status: 200,
    });
    renderAs(makeUser('technician'));

    expect(await screen.findByText(/could not load machines/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('CNC-01')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

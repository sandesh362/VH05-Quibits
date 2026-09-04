/**
 * Status page rendering tests.
 *
 * Covers the required Phase 1 checks: the loading state works, the error state
 * works, and real dependency status is displayed (never a hardcoded "healthy").
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReadinessResponse } from '@itp/shared';
import { StatusPage } from './status-page';
import { apiClient, ApiClientError } from '../lib/api-client';

const readinessFixture: ReadinessResponse = {
  status: 'degraded',
  service: 'backend',
  ready: true,
  checks: [
    {
      name: 'mongodb',
      status: 'ok',
      latencyMs: 4,
      detail: 'Database "itp" reachable',
      required: true,
    },
    {
      name: 'qdrant',
      status: 'down',
      latencyMs: 1001,
      error: 'connect ECONNREFUSED 127.0.0.1:6333',
      required: false,
      impact: 'Vector search will be unavailable.',
    },
  ],
  degradedCapabilities: ['vector_search'],
  durationMs: 1010,
  timestamp: '2026-09-04T00:00:00.000Z',
};

function renderPage(): void {
  render(
    <MemoryRouter>
      <StatusPage />
    </MemoryRouter>,
  );
}

describe('StatusPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the loading state while probing', () => {
    vi.spyOn(apiClient, 'getReadiness').mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/probing dependencies/i)).toBeInTheDocument();
  });

  it('renders real dependency status once loaded', async () => {
    vi.spyOn(apiClient, 'getReadiness').mockResolvedValue(readinessFixture);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('MongoDB')).toBeInTheDocument();
    });

    expect(screen.getByText('Qdrant')).toBeInTheDocument();
    // The failing dependency must be reported honestly.
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
    expect(screen.getByText(/Vector search will be unavailable/)).toBeInTheDocument();
  });

  it('distinguishes required from optional dependencies', async () => {
    vi.spyOn(apiClient, 'getReadiness').mockResolvedValue(readinessFixture);
    renderPage();

    await waitFor(() => expect(screen.getByText('Required')).toBeInTheDocument());
    expect(screen.getByText(/Optional in Phase 1/)).toBeInTheDocument();
  });

  it('reports degraded capabilities', async () => {
    vi.spyOn(apiClient, 'getReadiness').mockResolvedValue(readinessFixture);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/unavailable capabilities/i)).toBeInTheDocument();
    });
    expect(screen.getByText('vector_search')).toBeInTheDocument();
  });

  it('shows an actionable error state when the API is unreachable', async () => {
    vi.spyOn(apiClient, 'getReadiness').mockRejectedValue(
      new ApiClientError('NETWORK_ERROR', 'Cannot reach the API. Is the backend running?'),
    );
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(screen.getByText(/cannot reach the backend/i)).toBeInTheDocument();
    // The hint must tell the operator what to actually do.
    expect(screen.getByText(/npm run dev:backend/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('surfaces the request id for correlation when present', async () => {
    vi.spyOn(apiClient, 'getReadiness').mockRejectedValue(
      new ApiClientError('INTERNAL_SERVER_ERROR', 'Boom', 500, 'req_abc_123'),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText('req_abc_123')).toBeInTheDocument());
  });
});

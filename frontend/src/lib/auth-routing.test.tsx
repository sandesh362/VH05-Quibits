/**
 * Protected-route and role-aware navigation integration tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireCapability } from './auth';
import { apiClient } from './api-client';

function viewer() {
  return {
    id: 'u1', username: 'v', email: 'v@example.test', fullName: 'Viewer User',
    role: 'viewer' as const, isActive: true, mustChangePassword: false,
    lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function admin() {
  return { ...viewer(), id: 'u2', username: 'a', role: 'admin' as const };
}

function renderWith(ui: React.ReactNode, initialPath = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>{ui}</AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('RequireAuth', () => {
  it('redirects unauthenticated users to /login with the original path', async () => {
    renderWith(
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route
          path="/protected"
          element={
            <RequireAuth>
              <p>secret content</p>
            </RequireAuth>
          }
        />
      </Routes>,
    );
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument());
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('renders content for an authenticated user', async () => {
    const user = viewer();
    sessionStorage.setItem('itp.accessToken', 'token');
    sessionStorage.setItem('itp.user', JSON.stringify(user));
    vi.spyOn(apiClient, 'me').mockResolvedValue({ user });

    renderWith(
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route
          path="/protected"
          element={
            <RequireAuth>
              <p>secret content</p>
            </RequireAuth>
          }
        />
      </Routes>,
    );
    await waitFor(() => expect(screen.getByText('secret content')).toBeInTheDocument());
  });
});

describe('RequireCapability', () => {
  it('shows the forbidden page when a user lacks the capability', async () => {
    const user = viewer();
    sessionStorage.setItem('itp.accessToken', 'token');
    sessionStorage.setItem('itp.user', JSON.stringify(user));
    vi.spyOn(apiClient, 'me').mockResolvedValue({ user });

    renderWith(
      <Routes>
        <Route path="/forbidden" element={<p>forbidden page</p>} />
        <Route
          path="/admin"
          element={
            <RequireCapability capability="user.create">
              <p>admin content</p>
            </RequireCapability>
          }
        />
      </Routes>,
      '/admin',
    );
    await waitFor(() => expect(screen.getByText('forbidden page')).toBeInTheDocument());
    expect(screen.queryByText('admin content')).not.toBeInTheDocument();
  });

  it('allows a user who holds the capability', async () => {
    const user = admin();
    sessionStorage.setItem('itp.accessToken', 'token');
    sessionStorage.setItem('itp.user', JSON.stringify(user));
    vi.spyOn(apiClient, 'me').mockResolvedValue({ user });

    renderWith(
      <Routes>
        <Route path="/forbidden" element={<p>forbidden page</p>} />
        <Route
          path="/admin"
          element={
            <RequireCapability capability="user.create">
              <p>admin content</p>
            </RequireCapability>
          }
        />
      </Routes>,
      '/admin',
    );
    await waitFor(() => expect(screen.getByText('admin content')).toBeInTheDocument());
  });
});

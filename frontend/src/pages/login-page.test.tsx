import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from './login-page';
import { AuthProvider } from '../lib/auth';
import { apiClient, ApiClientError } from '../lib/api-client';

function renderLogin(): void {
  render(
    <MemoryRouter>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('signs a technician in through the Express API', async () => {
    const login = vi.spyOn(apiClient, 'login').mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 900,
      user: {
        id: 'u1',
        username: 'tech',
        email: 'tech@example.test',
        fullName: 'Tech User',
        role: 'technician',
        isActive: true,
        mustChangePassword: false,
        lastLoginAt: null,
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
      },
    });

    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), 'tech@example.test');
    await userEvent.type(document.getElementById('login-password') as HTMLInputElement, 'Str0ng-Test-Pass!42');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('tech@example.test', 'Str0ng-Test-Pass!42'));
    expect(sessionStorage.getItem('itp.accessToken')).toBe('access-token');
  });

  it('shows an actionable error when credentials are wrong', async () => {
    vi.spyOn(apiClient, 'login').mockRejectedValue(
      new ApiClientError('UNAUTHENTICATED', 'Invalid email or password.', 401, 'req_1'),
    );
    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), 'tech@example.test');
    await userEvent.type(document.getElementById('login-password') as HTMLInputElement, 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/check your email and password/i));
  });
});

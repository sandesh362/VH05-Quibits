/**
 * App shell tests (Phase 8): the persistent safety disclaimer is always
 * visible and non-dismissible, regardless of auth state.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from './app-layout';
import { AuthProvider } from '../lib/auth';

function renderLayout(initialPath = '/status'): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="*" element={<AppLayout />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AppLayout', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('shows the persistent safety disclaimer when signed out', () => {
    renderLayout();
    const disclaimer = screen.getByTestId('safety-disclaimer');
    expect(disclaimer).toBeInTheDocument();
    expect(disclaimer).toHaveTextContent(/manual evidence is authoritative/i);
    expect(disclaimer).toHaveTextContent(/never proves a diagnosis/i);
  });

  it('keeps the disclaimer visible when signed in', () => {
    sessionStorage.setItem('itp.accessToken', 'token');
    sessionStorage.setItem(
      'itp.user',
      JSON.stringify({
        id: 'u1',
        username: 'tech',
        email: 'tech@example.test',
        fullName: 'Tech',
        role: 'technician',
        isActive: true,
        mustChangePassword: false,
        lastLoginAt: null,
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
      }),
    );
    renderLayout();
    expect(screen.getByTestId('safety-disclaimer')).toBeInTheDocument();
    expect(screen.getByText(/Sign out/i)).toBeInTheDocument();
  });

  it('does not offer a dismiss control for the disclaimer', () => {
    renderLayout();
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });
});

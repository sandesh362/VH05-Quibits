/**
 * Token storage + session refresh.
 */
import {
  clearSession,
  readAccessToken,
  readSession,
  writeSession,
} from './token-store';
import { refreshSession, resetRefreshInflight } from './session';

// Auto-mock the auth API so session.ts's own import of refreshTokens hits the
// mock (requireMock alone only mocks the reference fetched through it).
jest.mock('@/api/auth');

const secureStore = (jest.requireMock('expo-secure-store') as { __store: Map<string, string> }).__store;

const USER = {
  id: 'user-1',
  username: 'tech',
  email: 'tech@example.com',
  fullName: 'T Ech',
  role: 'technician' as const,
  isActive: true,
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('token store', () => {
  beforeEach(async () => {
    secureStore.clear();
    await clearSession();
  });

  it('persists and reads the session', async () => {
    await writeSession({ accessToken: 'a1', refreshToken: 'r1', user: USER });
    const session = await readSession();
    expect(session.accessToken).toBe('a1');
    expect(session.refreshToken).toBe('r1');
    expect(session.user?.username).toBe('tech');
    await expect(readAccessToken()).resolves.toBe('a1');
  });

  it('clears everything securely', async () => {
    await writeSession({ accessToken: 'a1', refreshToken: 'r1', user: USER });
    await clearSession();
    const session = await readSession();
    expect(session.accessToken).toBeNull();
    expect(session.refreshToken).toBeNull();
    expect(secureStore.size).toBe(0);
  });

  it('keeps tokens out of plain AsyncStorage-like stores (they live in SecureStore keys)', async () => {
    await writeSession({ accessToken: 'secret-a', refreshToken: 'secret-r', user: USER });
    expect(secureStore.get('itp.mobile.accessToken')).toBe('secret-a');
    expect(secureStore.get('itp.mobile.refreshToken')).toBe('secret-r');
  });
});

describe('session refresh (single-flight)', () => {
  const authApi = jest.requireMock('@/api/auth') as { refreshTokens: jest.Mock };

  beforeEach(() => {
    resetRefreshInflight();
    secureStore.clear();
    authApi.refreshTokens.mockReset();
  });

  it('returns the new access token and persists the rotated pair', async () => {
    await writeSession({ accessToken: 'a0', refreshToken: 'r0', user: USER });
    authApi.refreshTokens.mockResolvedValue({ accessToken: 'a1', refreshToken: 'r1', expiresIn: 900, user: USER });
    await expect(refreshSession()).resolves.toBe('a1');
    expect(await readAccessToken()).toBe('a1');
  });

  it('collapses concurrent refreshes into ONE network call', async () => {
    await writeSession({ accessToken: 'a0', refreshToken: 'r0', user: USER });
    authApi.refreshTokens.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ accessToken: 'a1', refreshToken: 'r1', expiresIn: 900, user: USER }), 10)),
    );
    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);
    expect(first).toBe('a1');
    expect(second).toBe('a1');
    expect(authApi.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('clears the session when the refresh token is rejected', async () => {
    await writeSession({ accessToken: 'a0', refreshToken: 'r0', user: USER });
    authApi.refreshTokens.mockRejectedValue(new Error('rotated token replay'));
    await expect(refreshSession()).resolves.toBeNull();
    const session = await readSession();
    expect(session.refreshToken).toBeNull();
    expect(session.accessToken).toBeNull();
  });

  it('returns null when there is no refresh token at all', async () => {
    await expect(refreshSession()).resolves.toBeNull();
    expect(authApi.refreshTokens).not.toHaveBeenCalled();
  });
});

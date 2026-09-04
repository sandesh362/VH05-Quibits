import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { PublicUser } from '@itp/shared';
import { apiClient, setAuthTokenGetter } from './api-client';

const TOKEN_KEY = 'itp.accessToken';
const REFRESH_KEY = 'itp.refreshToken';
const USER_KEY = 'itp.user';

interface AuthState {
  user: PublicUser | null;
  accessToken: string | null;
  ready: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredUser(): PublicUser | null {
  try {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as PublicUser) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>({
    user: readStoredUser(),
    accessToken: sessionStorage.getItem(TOKEN_KEY),
    ready: false,
  });

  useEffect(() => {
    setAuthTokenGetter(() => sessionStorage.getItem(TOKEN_KEY));
    setState((current) => ({ ...current, ready: true }));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiClient.login(email, password);
    sessionStorage.setItem(TOKEN_KEY, result.accessToken);
    sessionStorage.setItem(REFRESH_KEY, result.refreshToken);
    sessionStorage.setItem(USER_KEY, JSON.stringify(result.user));
    setAuthTokenGetter(() => sessionStorage.getItem(TOKEN_KEY));
    setState({ user: result.user, accessToken: result.accessToken, ready: true });
  }, []);

  const logout = useCallback(async () => {
    const refresh = sessionStorage.getItem(REFRESH_KEY) ?? undefined;
    try {
      if (sessionStorage.getItem(TOKEN_KEY)) await apiClient.logout(refresh);
    } catch {
      // Clearing local session still logs the operator out of this browser.
    }
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
    sessionStorage.removeItem(USER_KEY);
    setAuthTokenGetter(() => null);
    setState({ user: null, accessToken: null, ready: true });
  }, []);

  const value = useMemo(
    () => ({ ...state, login, logout }),
    [state, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <p>Loading session…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

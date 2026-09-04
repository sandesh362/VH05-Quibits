/**
 * Authentication state.
 *
 * Tokens live in sessionStorage (tab-scoped, not persisted to disk). On mount
 * the stored access token is validated against `/auth/me`; if it has expired
 * the refresh token is exchanged once. Failure either way clears the session.
 *
 * A 401 from ANY API call (registered through `setUnauthorizedHandler`) marks
 * the session as expired and redirects to the login page via route state.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Capability, PublicUser } from '@itp/shared';
import { apiClient, setAuthTokenGetter, setUnauthorizedHandler, ApiClientError } from './api-client';
import { can as roleCan } from './permissions';

const TOKEN_KEY = 'itp.accessToken';
const REFRESH_KEY = 'itp.refreshToken';
const USER_KEY = 'itp.user';

interface AuthState {
  user: PublicUser | null;
  accessToken: string | null;
  ready: boolean;
  /** Set when an API call failed with 401 so the login page can explain. */
  expired: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (capability: Capability) => boolean;
  clearExpired: () => void;
  /** Update the cached profile after the user edits it. */
  updateUser: (user: PublicUser) => void;
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

function persistSession(accessToken: string, refreshToken: string, user: PublicUser): void {
  sessionStorage.setItem(TOKEN_KEY, accessToken);
  sessionStorage.setItem(REFRESH_KEY, refreshToken);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  setAuthTokenGetter(() => sessionStorage.getItem(TOKEN_KEY));
}

function clearSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(USER_KEY);
  setAuthTokenGetter(() => null);
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<AuthState>({
    user: readStoredUser(),
    accessToken: sessionStorage.getItem(TOKEN_KEY),
    ready: false,
    expired: false,
  });

  const applyExpired = useCallback(() => {
    clearSession();
    setState({ user: null, accessToken: null, ready: true, expired: true });
  }, []);

  useEffect(() => {
    setAuthTokenGetter(() => sessionStorage.getItem(TOKEN_KEY));
    setUnauthorizedHandler(applyExpired);

    let cancelled = false;
    async function restore(): Promise<void> {
      const storedToken = sessionStorage.getItem(TOKEN_KEY);
      const storedUser = readStoredUser();
      const refreshToken = sessionStorage.getItem(REFRESH_KEY);
      if (!storedToken || !storedUser) {
        if (!cancelled) setState((s) => ({ ...s, ready: true }));
        return;
      }
      // Validate the stored access token.
      try {
        const { user } = await apiClient.me();
        if (!cancelled) setState({ user, accessToken: storedToken, ready: true, expired: false });
        return;
      } catch (error) {
        if (cancelled) return;
        const isAuthFailure = error instanceof ApiClientError && error.code === 'UNAUTHENTICATED';
        if (!isAuthFailure) {
          // Network blip: keep the stored session, the app will retry calls.
          setState({ user: storedUser, accessToken: storedToken, ready: true, expired: false });
          return;
        }
      }
      // Access token expired/blacklisted — try the refresh token once.
      if (refreshToken) {
        try {
          const result = await apiClient.refresh(refreshToken);
          persistSession(result.accessToken, result.refreshToken, result.user);
          if (!cancelled) {
            setState({ user: result.user, accessToken: result.accessToken, ready: true, expired: false });
          }
          return;
        } catch {
          // fall through to cleared session
        }
      }
      if (!cancelled) applyExpired();
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [applyExpired]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiClient.login(email, password);
    persistSession(result.accessToken, result.refreshToken, result.user);
    setState({ user: result.user, accessToken: result.accessToken, ready: true, expired: false });
  }, []);

  const logout = useCallback(async () => {
    const refresh = sessionStorage.getItem(REFRESH_KEY) ?? undefined;
    try {
      if (sessionStorage.getItem(TOKEN_KEY)) await apiClient.logout(refresh);
    } catch {
      // Clearing local session still logs the operator out of this browser.
    }
    clearSession();
    setState({ user: null, accessToken: null, ready: true, expired: false });
  }, []);

  const can = useCallback(
    (capability: Capability) => roleCan(state.user, capability),
    [state.user],
  );

  const clearExpired = useCallback(() => {
    setState((s) => (s.expired ? { ...s, expired: false } : s));
  }, []);

  const updateUser = useCallback((user: PublicUser) => {
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    setState((s) => ({ ...s, user }));
  }, []);

  const value = useMemo(
    () => ({ ...state, login, logout, can, clearExpired, updateUser }),
    [state, login, logout, can, clearExpired, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Full-screen session restore state. */
export function AuthLoadingScreen(): JSX.Element {
  return (
    <div className="auth-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>Restoring session…</p>
    </div>
  );
}

/** Require an authenticated user; otherwise redirect to /login. */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <AuthLoadingScreen />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/**
 * Require a specific capability for a route. Authenticated users who lack it
 * see the Forbidden page instead of the route. The API would reject the call
 * anyway; this just gives a clear, non-broken screen.
 */
export function RequireCapability({
  capability,
  children,
}: {
  capability: Capability;
  children: ReactNode;
}): JSX.Element {
  const { user, ready, can } = useAuth();
  const location = useLocation();
  if (!ready) return <AuthLoadingScreen />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!can(capability)) return <Navigate to="/forbidden" replace />;
  return <>{children}</>;
}

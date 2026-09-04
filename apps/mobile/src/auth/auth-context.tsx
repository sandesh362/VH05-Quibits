/**
 * Authentication state for the app.
 *
 * Bootstrap: read the SecureStore session; verify against /auth/me; on 401
 * try the refresh token once; on network failure KEEP the stored session so
 * a technician in a dead zone can still use cached data (the web app does
 * the same). Any definitive failure clears the session securely and the
 * router redirects to login.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PublicUser } from '@itp/shared';
import { configureClient } from '@/api/client';
import { fetchMe, login as apiLogin, logout as apiLogout } from '@/api/auth';
import { ApiError } from '@/api/errors';
import { wipeUserData } from '@/db/database';
import { clearSession, readSession, writeSession } from './token-store';
import { refreshSession } from './session';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: PublicUser | null;
  /** Set when the last session ended by expiry (login page explains). */
  expired: boolean;
  disabled: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: (options?: { allDevices?: boolean }) => Promise<void>;
  clearExpired: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<PublicUser | null>(null);
  const [expired, setExpired] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const bootstrapped = useRef(false);

  const applyExpired = useCallback(() => {
    void clearSession();
    setUser(null);
    setStatus('unauthenticated');
    setExpired(true);
  }, []);

  // Wire the API client to the session lifecycle.
  useEffect(() => {
    configureClient({
      getToken: async () => (await import('./token-store')).readAccessToken(),
      refresh: () => refreshSession(),
      onUnauthorized: applyExpired,
    });
  }, [applyExpired]);

  const bootstrap = useCallback(async () => {
    const stored = await readSession();
    if (!stored.accessToken && !stored.refreshToken) {
      setStatus('unauthenticated');
      return;
    }
    setUser(stored.user);
    try {
      const me = await fetchMe();
      setUser(me);
      if (stored.refreshToken) {
        await writeSession({
          accessToken: stored.accessToken ?? '',
          refreshToken: stored.refreshToken,
          user: me,
        });
      }
      setStatus('authenticated');
    } catch (error) {
      if (error instanceof ApiError && error.isAuthError) {
        const newToken = await refreshSession();
        if (newToken) {
          try {
            const me = await fetchMe();
            setUser(me);
            setStatus('authenticated');
            return;
          } catch {
            /* fall through to expiry */
          }
        }
        applyExpired();
        return;
      }
      // Network problem (or backend down): keep the stored session so the
      // technician can work from cache. Requests will retry the refresh.
      setStatus('authenticated');
    }
  }, [applyExpired]);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void bootstrap();
  }, [bootstrap]);

  const login = useCallback(async (email: string, password: string) => {
    setDisabled(false);
    try {
      const tokens = await apiLogin(email, password);
      await writeSession(tokens);
      setUser(tokens.user);
      setExpired(false);
      setStatus('authenticated');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setDisabled(true);
      throw error;
    }
  }, []);

  const logout = useCallback(
    async (options?: { allDevices?: boolean }) => {
      const stored = await readSession();
      try {
        await apiLogout(stored.refreshToken ?? undefined, options?.allDevices ?? false);
      } catch {
        // Best-effort: even if the server call fails, the local session goes.
      }
      // Local cleanup FIRST so wipe cannot be skipped on an API error.
      if (stored.user) await wipeUserData(stored.user.id);
      await clearSession();
      setUser(null);
      setExpired(false);
      setStatus('unauthenticated');
    },
    [],
  );

  const clearExpired = useCallback(() => setExpired(false), []);

  const value = useMemo(
    () => ({ status, user, expired, disabled, login, logout, clearExpired }),
    [status, user, expired, disabled, login, logout, clearExpired],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

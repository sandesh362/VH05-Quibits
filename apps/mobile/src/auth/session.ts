/**
 * Session refresh - single-flight.
 *
 * The backend rotates refresh tokens on every use; concurrent refreshes with
 * the same token would revoke the family. A module-level promise collapses
 * every concurrent 401 into ONE network refresh.
 */
import { refreshTokens } from '@/api/auth';
import { clearSession, readRefreshToken, readSession, writeSession } from './token-store';

let inflight: Promise<string | null> | null = null;

/** Refresh the session once; resolves with the new access token or null. */
export function refreshSession(): Promise<string | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const refreshToken = await readRefreshToken();
      if (!refreshToken) return null;
      const next = await refreshTokens(refreshToken);
      // Preserve the (possibly offline-cached) user until /auth/me corrects it.
      const stored = await readSession();
      await writeSession({ ...next, user: next.user ?? stored.user });
      return next.accessToken;
    } catch {
      // Rotated/replayed/revoked refresh token, network failure with no
      // fallback, or a disabled account: the session cannot continue.
      await clearSession();
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test hook: forget any in-flight refresh (never used in the app). */
export function resetRefreshInflight(): void {
  inflight = null;
}

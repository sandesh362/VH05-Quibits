/**
 * Auth-route decisions, extracted for unit testing.
 *
 * Unauthenticated users must never reach protected screens; authenticated
 * users must never sit on the login screen.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export const LOGIN_ROUTE = '/login' as const;
export const HOME_ROUTE = '/(app)/(tabs)/home' as const;

function isInAuthArea(pathname: string): boolean {
  return pathname.startsWith('/login') || pathname.startsWith('/forgot-password');
}

/**
 * Returns the route to redirect to, or null when the current location is
 * already correct. 'loading' never redirects (the splash gate holds).
 */
export function authRedirect(pathname: string, status: AuthStatus): string | null {
  if (status === 'loading') return null;
  if (status === 'unauthenticated' && !isInAuthArea(pathname)) return LOGIN_ROUTE;
  if (status === 'authenticated' && isInAuthArea(pathname)) return HOME_ROUTE;
  return null;
}

/**
 * Token storage.
 *
 * Access token, refresh token and the cached profile live in Expo
 * SecureStore (Keychain / Keystore) - NEVER in plain AsyncStorage. The cached
 * user is convenience only; every restore verifies against `/auth/me`.
 *
 * Nothing in this module logs values. Only key names may appear in logs.
 */
import * as SecureStore from 'expo-secure-store';
import type { PublicUser } from '@itp/shared';

const ACCESS_KEY = 'itp.mobile.accessToken';
const REFRESH_KEY = 'itp.mobile.refreshToken';
const USER_KEY = 'itp.mobile.user';

/** In-memory mirror so per-request reads do not hit the keystore. */
let cachedAccess: string | null = null;
let cachedRefresh: string | null = null;

export async function readAccessToken(): Promise<string | null> {
  if (cachedAccess !== null) return cachedAccess;
  cachedAccess = await SecureStore.getItemAsync(ACCESS_KEY);
  return cachedAccess;
}

export async function readRefreshToken(): Promise<string | null> {
  if (cachedRefresh !== null) return cachedRefresh;
  cachedRefresh = await SecureStore.getItemAsync(REFRESH_KEY);
  return cachedRefresh;
}

export interface StoredSession {
  accessToken: string | null;
  refreshToken: string | null;
  user: PublicUser | null;
}

export async function readSession(): Promise<StoredSession> {
  const [accessToken, refreshToken] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_KEY),
    SecureStore.getItemAsync(REFRESH_KEY),
  ]);
  cachedAccess = accessToken;
  cachedRefresh = refreshToken;
  let user: PublicUser | null = null;
  try {
    const raw = await SecureStore.getItemAsync(USER_KEY);
    user = raw ? (JSON.parse(raw) as PublicUser) : null;
  } catch {
    user = null;
  }
  return { accessToken, refreshToken, user };
}

export async function writeSession(tokens: {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}): Promise<void> {
  cachedAccess = tokens.accessToken;
  cachedRefresh = tokens.refreshToken;
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
    SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
    SecureStore.setItemAsync(USER_KEY, JSON.stringify(tokens.user)),
  ]);
}

export async function clearSession(): Promise<void> {
  cachedAccess = null;
  cachedRefresh = null;
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(USER_KEY).catch(() => {}),
  ]);
}

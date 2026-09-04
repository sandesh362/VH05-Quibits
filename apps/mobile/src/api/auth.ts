/**
 * Auth endpoints. Shapes are the existing contracts:
 *  - POST /auth/login    → { accessToken, refreshToken, expiresIn, tokenType, user }
 *  - POST /auth/refresh  → same shape (tokens rotate on every use)
 *  - GET  /auth/me       → { user }
 *  - POST /auth/logout   → authenticated; { refreshToken?, allDevices? }
 */
import type { LoginResponse, PublicUser } from '@itp/shared';
import { post, get } from './client';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
}

export async function login(email: string, password: string): Promise<SessionTokens> {
  const result = await post<LoginResponse & { refreshToken: string }>(
    '/auth/login',
    { email, password },
    { authenticated: false },
  );
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    user: result.user,
  };
}

export async function refreshTokens(refreshToken: string): Promise<SessionTokens> {
  const result = await post<LoginResponse & { refreshToken: string }>(
    '/auth/refresh',
    { refreshToken },
    { authenticated: false },
  );
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn,
    user: result.user,
  };
}

export async function fetchMe(): Promise<PublicUser> {
  const result = await get<{ user: PublicUser }>('/auth/me');
  return result.user;
}

export async function logout(refreshToken?: string, allDevices = false): Promise<void> {
  await post('/auth/logout', { refreshToken, allDevices });
}

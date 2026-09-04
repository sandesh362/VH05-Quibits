/**
 * Mobile environment configuration.
 *
 * Values come from EXPO_PUBLIC_* variables, which the Expo CLI inlines at
 * bundle time. There are no secrets here: the mobile app only ever talks to
 * the existing Express API as an authenticated client.
 */
function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const rawBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://localhost:8080/api/v1';
  // Accept either a bare origin (http://host:8080) or an origin + prefix.
  if (/\/api\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/api/v1`;
}

export const env = {
  /** Base URL including the /api/v1 prefix. Never a secret. */
  apiBaseUrl: normalizeBaseUrl(rawBaseUrl),
  /** Raw value as configured (used by the profile screen to show the target). */
  apiBaseUrlConfigured: rawBaseUrl.trim() || '(default) http://localhost:8080/api/v1',
  requestTimeoutMs: num(process.env.EXPO_PUBLIC_API_TIMEOUT_MS, 15_000),
  ragTimeoutMs: num(process.env.EXPO_PUBLIC_RAG_TIMEOUT_MS, 130_000),
} as const;

/** True when the configured base URL can never work from a physical device. */
export function isLoopbackBaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
  } catch {
    return false;
  }
}

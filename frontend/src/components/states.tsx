/**
 * Reusable loading / error / empty states.
 *
 * Centralised so every screen in later phases communicates failure the same
 * way. Each state is announced to assistive technology.
 */
import type { ReactNode } from 'react';
import { ApiClientError } from '../lib/api-client';
import './states.css';

// --------------------------------------------------------------------------
// Loading
// --------------------------------------------------------------------------

export function LoadingState({ message = 'Loading…' }: { message?: string }): JSX.Element {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p className="state__message">{message}</p>
    </div>
  );
}

/** Inline spinner for buttons and table cells. */
export function InlineSpinner({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <>
      <span className="spinner spinner--sm" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </>
  );
}

// --------------------------------------------------------------------------
// Error
// --------------------------------------------------------------------------

interface ErrorStateProps {
  error: ApiClientError | Error;
  onRetry?: () => void;
  title?: string;
}

/** Turn a technical failure into an actionable instruction. */
function troubleshootingHint(error: ApiClientError | Error): string | null {
  if (!(error instanceof ApiClientError)) return null;

  switch (error.code) {
    case 'NETWORK_ERROR':
      return 'The API did not respond. Start it with `npm run dev:backend`, or `docker compose up -d` if you are using Docker.';
    case 'TIMEOUT':
      return 'The API took too long to respond. It may be starting up, or a dependency probe may be hanging.';
    case 'SERVICE_UNAVAILABLE':
    case 'DEPENDENCY_UNAVAILABLE':
      return 'The API is running but a dependency it needs is unavailable. Check the service status page.';
    case 'NOT_FOUND':
      return 'The endpoint does not exist. The frontend and backend versions may be out of sync.';
    case 'MALFORMED_RESPONSE':
      return 'The response was not in the expected format. Check that the dev proxy points at the API and not at another server.';
    default:
      return null;
  }
}

export function ErrorState({
  error,
  onRetry,
  title = 'Something went wrong',
}: ErrorStateProps): JSX.Element {
  const hint = troubleshootingHint(error);
  const requestId = error instanceof ApiClientError ? error.requestId : undefined;
  const code = error instanceof ApiClientError ? error.code : 'UNKNOWN';

  return (
    <div className="state state--error" role="alert">
      <span className="state__icon" aria-hidden="true">
        ⚠
      </span>
      <div className="state__body">
        <h3 className="state__title">{title}</h3>
        <p className="state__message">{error.message}</p>
        {hint && <p className="state__hint">{hint}</p>}

        <div className="state__meta">
          <code>{code}</code>
          {requestId && (
            <>
              {' '}
              <span className="state__meta-label">request</span> <code>{requestId}</code>
            </>
          )}
        </div>

        {onRetry && (
          <button type="button" onClick={onRetry} className="state__action">
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Empty
// --------------------------------------------------------------------------

interface EmptyStateProps {
  title: string;
  message?: string;
  action?: ReactNode;
  icon?: string;
}

export function EmptyState({
  title,
  message,
  action,
  icon = '○',
}: EmptyStateProps): JSX.Element {
  return (
    <div className="state state--empty">
      <span className="state__icon state__icon--muted" aria-hidden="true">
        {icon}
      </span>
      <div className="state__body">
        <h3 className="state__title">{title}</h3>
        {message && <p className="state__message">{message}</p>}
        {action && <div className="state__action-slot">{action}</div>}
      </div>
    </div>
  );
}

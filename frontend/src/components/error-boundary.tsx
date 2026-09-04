/**
 * Top-level error boundary.
 *
 * Catches render-time exceptions so a component bug shows a readable message
 * instead of a blank white page. Stack details are shown only in development.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Later phases can forward this to the backend for logging.
    console.error('Unhandled render error:', error, info.componentStack);
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div
        role="alert"
        style={{
          maxWidth: '640px',
          margin: '10vh auto',
          padding: '24px',
          border: '1px solid rgba(248, 81, 73, 0.4)',
          borderRadius: '8px',
          background: 'rgba(248, 81, 73, 0.12)',
        }}
      >
        <h1 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>The interface crashed</h1>
        <p style={{ color: 'var(--color-text-muted)', marginBottom: '16px' }}>
          An unexpected error occurred while rendering. This is a bug in the frontend, not a
          problem with your data.
        </p>

        {import.meta.env.DEV && (
          <pre
            style={{
              padding: '12px',
              background: 'var(--color-surface)',
              borderRadius: '5px',
              fontSize: '0.8rem',
              overflowX: 'auto',
              marginBottom: '16px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.message}
            {'\n\n'}
            {error.stack}
          </pre>
        )}

        <button type="button" onClick={this.handleReset}>
          Try again
        </button>
      </div>
    );
  }
}

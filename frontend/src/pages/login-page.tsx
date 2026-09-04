/**
 * Login page.
 *
 * - Client-side validation with inline errors and required-field markers.
 * - Password visibility toggle.
 * - Safe error messages (the backend returns generic auth failures).
 * - Expired-session banner when redirected by a 401 elsewhere.
 * - Redirects back to the page the user originally requested.
 */
import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiClientError } from '../lib/api-client';
import { Alert, Button, Field, PasswordInput, TextInput } from '../components/ui';
import './page.css';

interface LocationState {
  from?: string;
}

export function LoginPage(): JSX.Element {
  const { login, expired, clearExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function validate(): boolean {
    const next: typeof errors = {};
    const trimmed = email.trim();
    if (!trimmed) next.email = 'Email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Password is required.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    clearExpired();
    if (!validate()) return;
    setPending(true);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        if (caught.code === 'RATE_LIMITED') {
          setFormError('Too many sign-in attempts. Wait a moment and try again.');
        } else if (caught.status === 401 || caught.code === 'UNAUTHENTICATED') {
          setFormError('Sign-in failed. Check your email and password.');
        } else if (caught.code === 'NETWORK_ERROR') {
          setFormError(caught.message);
        } else {
          setFormError(caught.message);
        }
      } else {
        setFormError('Sign-in failed. Please try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page page--centered">
      <header className="page__header page__header--centered">
        <h1>Sign in</h1>
        <p className="page__lead">
          Sign in to the industrial troubleshooting workspace. Sessions are tab-scoped and no
          credentials are stored on disk.
        </p>
      </header>

      <form className="card ui-form login-form" onSubmit={onSubmit} noValidate>
        {expired && (
          <Alert tone="warn">
            Your session has expired. Please sign in again to continue.
          </Alert>
        )}
        {formError && <Alert tone="error">{formError}</Alert>}

        <Field label="Email" htmlFor="login-email" required error={errors.email}>
          <TextInput
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            aria-required="true"
          />
        </Field>

        <Field
          label="Password"
          htmlFor="login-password"
          required
          error={errors.password}
          hint="Use the password set by your administrator."
        >
          <PasswordInput
            id="login-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-required="true"
          />
        </Field>

        <Button type="submit" variant="primary" loading={pending} className="login-form__submit">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>

        <p className="page__note">
          No default credentials exist. An administrator creates accounts, or bootstrap the first
          administrator with <code>npm run create-admin</code>.
        </p>
        <p className="page__note">
          <Link to="/">Back to overview</Link>
        </p>
      </form>
    </div>
  );
}
